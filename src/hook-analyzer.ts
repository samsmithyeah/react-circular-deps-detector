/**
 * Hook Analyzer Module
 *
 * Core hook node analysis logic for detecting state modification patterns.
 * This module handles:
 * - Individual hook analysis (useEffect, useCallback, useMemo)
 * - Cross-file modification detection
 * - CFG-based unconditional modification analysis
 * - Guard detection and safe pattern recognition
 */

import * as t from '@babel/types';
import traverse, { NodePath } from '@babel/traverse';
import { HookAnalysis, HookNodeInfo, ErrorCode } from './types';
import { CrossFileAnalysis } from './cross-file-analyzer';
import { analyzeSetStateCalls, type SetStateAnalysis } from './control-flow';
import { analyzeStateInteractions } from './effect-analyzer';
import { isHookIgnored, createAnalysis } from './utils';

/**
 * Extract the root identifier from a dependency expression.
 * Handles both simple identifiers (count) and member expressions (state.count, state.nested.value).
 * Returns the root identifier name or null if not extractable.
 */
function extractRootIdentifier(node: t.Node | null): string | null {
  if (!node) return null;

  if (t.isIdentifier(node)) {
    return node.name;
  }

  if (t.isMemberExpression(node)) {
    // Recursively get the root object (e.g., state.count -> state, state.a.b -> state)
    return extractRootIdentifier(node.object);
  }

  return null;
}

/**
 * Find all hook call expressions in an AST.
 * Returns nodes for useEffect, useCallback, and useMemo hooks.
 */
export function findHookNodes(ast: t.Node): HookNodeInfo[] {
  const hookNodes: HookNodeInfo[] = [];

  traverse(ast, {
    CallExpression(nodePath: NodePath<t.CallExpression>) {
      if (t.isIdentifier(nodePath.node.callee)) {
        const hookName = nodePath.node.callee.name;
        if (['useEffect', 'useCallback', 'useMemo'].includes(hookName)) {
          hookNodes.push({
            node: nodePath.node,
            hookName,
            line: nodePath.node.loc?.start.line || 0,
          });
        }
      }
    },
  });

  return hookNodes;
}

/**
 * Analyze a single hook node for potential infinite loop patterns.
 *
 * @param hookNode - The hook node to analyze
 * @param stateInfo - Map of state variables to their setters
 * @param filePath - Path to the file being analyzed
 * @param crossFileAnalysis - Cross-file analysis results
 * @param fileContent - File content for comment detection
 * @param refVars - Set of ref variable names
 * @param localFunctionSetters - Map of local functions to the setters they call (transitively)
 */
export function analyzeHookNode(
  hookNode: HookNodeInfo,
  stateInfo: Map<string, string>,
  filePath: string,
  crossFileAnalysis: CrossFileAnalysis,
  fileContent?: string,
  refVars: Set<string> = new Set(),
  localFunctionSetters: Map<string, string[]> = new Map()
): HookAnalysis | null {
  const { node, hookName, line } = hookNode;

  // Check for ignore comments: // rcd-ignore or // rcd-ignore-next-line
  if (fileContent && isHookIgnored(fileContent, line)) {
    return null; // Skip this hook - user has explicitly ignored it
  }

  if (!node.arguments || node.arguments.length < 2) {
    return null; // No dependencies array
  }

  // Get dependencies
  const depsArray = node.arguments[node.arguments.length - 1];
  if (!t.isArrayExpression(depsArray)) {
    return null;
  }

  // Extract dependencies - handles both simple identifiers and member expressions
  // e.g., [count] -> ['count'], [state.count] -> ['state'], [state.a.b] -> ['state']
  const dependencies = depsArray.elements
    .map((el) => extractRootIdentifier(el))
    .filter((name): name is string => name !== null);

  // Analyze hook body for state interactions
  const hookBody = node.arguments[0];
  const stateInteractions = analyzeStateInteractions(
    hookBody,
    stateInfo,
    refVars,
    localFunctionSetters
  );

  // CFG-based analysis for more accurate unconditional detection
  let cfgAnalysis: Map<string, SetStateAnalysis> | null = null;
  if (hookBody) {
    try {
      cfgAnalysis = analyzeSetStateCalls(hookBody, stateInfo, dependencies);
    } catch (error) {
      // CFG building can fail on very unusual code patterns
      if (process.env.DEBUG) {
        console.warn(`[CFG] Failed to analyze setState calls in ${filePath}:`, error);
      }
      cfgAnalysis = null;
    }
  }

  // Check cross-file modifications for this hook
  const hookId = `${filePath}:${line}:${hookName}`;
  const crossFileModifications = crossFileAnalysis.stateSetterFlows.get(hookId) || [];

  // IMPORTANT: useCallback and useMemo CANNOT cause infinite loops by themselves!
  // They only memoize functions/values - they don't auto-execute on dependency changes.
  // Only useEffect/useLayoutEffect can directly cause infinite re-render loops.
  const canCauseDirectLoop = hookName === 'useEffect' || hookName === 'useLayoutEffect';

  // Check if dependencies are only passed as references (not invoked)
  // e.g., addEventListener('resize', handleResize) - handleResize is passed, not called
  const depsPassedAsRefs = new Set(
    stateInteractions.functionReferences.map((ref) => ref.functionName)
  );

  // Check for problematic patterns
  for (const dep of dependencies) {
    const setter = stateInfo.get(dep);
    if (!setter) continue;

    // Check if this setter has a safe guard
    const guardedMod = stateInteractions.guardedModifications.find(
      (g) => g.setter === setter && g.stateVariable === dep
    );

    if (guardedMod) {
      if (guardedMod.isSafe) {
        // This modification is safely guarded - not a problem
        return createAnalysis({
          type: 'safe-pattern',
          errorCode: 'RLD-200', // Safe pattern, but we use the base code for categorization
          category: 'safe',
          severity: 'low',
          confidence: 'high',
          hookType: hookName,
          line,
          file: filePath,
          problematicDependency: dep,
          stateVariable: dep,
          setterFunction: setter,
          actualStateModifications: [setter],
          stateReads: stateInteractions.reads,
          explanation: `Hook modifies '${dep}' but has a ${guardedMod.guardType} that prevents infinite loops.`,
        });
      }

      // Handle risky guard patterns like object-spread-risk
      if (guardedMod.guardType === 'object-spread-risk') {
        return createAnalysis({
          type: 'potential-issue',
          errorCode: 'RLD-410',
          category: 'warning',
          severity: 'medium',
          confidence: 'medium',
          hookType: hookName,
          line,
          file: filePath,
          problematicDependency: dep,
          stateVariable: dep,
          setterFunction: setter,
          actualStateModifications: [setter],
          stateReads: stateInteractions.reads,
          explanation:
            guardedMod.warning ||
            `Guard checks property of '${dep}' but setter creates new object reference. ` +
              `The object identity changes even when the guarded property doesn't, which may cause unexpected re-renders.`,
        });
      }
    }

    // Check if this dependency is only passed as a reference (not invoked)
    // e.g., useEffect(() => { addEventListener('resize', handleResize) }, [handleResize])
    // The handleResize function modifies state, but it's not called during effect execution
    if (depsPassedAsRefs.has(dep)) {
      const refInfo = stateInteractions.functionReferences.find((r) => r.functionName === dep);
      // If it's only used as a reference and the state modification happens through that function,
      // it's safe because the function won't be invoked synchronously during effect execution
      return createAnalysis({
        type: 'safe-pattern',
        errorCode: 'RLD-200',
        category: 'safe',
        severity: 'low',
        confidence: 'high',
        hookType: hookName,
        line,
        file: filePath,
        problematicDependency: dep,
        stateVariable: dep,
        setterFunction: setter,
        actualStateModifications: [],
        stateReads: stateInteractions.reads,
        explanation: `'${dep}' is passed as a ${refInfo?.context || 'callback'} reference to '${refInfo?.receivingFunction || 'a function'}', not invoked directly. This is a safe pattern.`,
      });
    }

    // Check if this is a deferred modification (inside setInterval, onSnapshot, etc.)
    // These don't cause immediate re-render loops because they execute asynchronously
    if (stateInteractions.deferredModifications.includes(setter)) {
      return createAnalysis({
        type: 'safe-pattern',
        errorCode: 'RLD-200',
        category: 'safe',
        severity: 'low',
        confidence: 'high',
        hookType: hookName,
        line,
        file: filePath,
        problematicDependency: dep,
        stateVariable: dep,
        setterFunction: setter,
        actualStateModifications: stateInteractions.deferredModifications,
        stateReads: stateInteractions.reads,
        explanation: `'${setter}()' is called inside an async callback (setInterval, onSnapshot, etc.), not during effect execution. This is a safe pattern - the state update is deferred and won't cause an immediate re-render loop.`,
      });
    }

    // Check if this is a cleanup function modification (return () => setState())
    // Cleanup functions run when the effect re-runs or component unmounts.
    // If the cleanup modifies state that the effect depends on, it can cause a loop:
    // effect runs -> cleanup runs -> state changes -> effect re-runs -> cleanup runs...
    if (stateInteractions.cleanupModifications.includes(setter) && canCauseDirectLoop) {
      return createAnalysis({
        type: 'confirmed-infinite-loop',
        errorCode: 'RLD-200',
        category: 'critical',
        severity: 'high',
        confidence: 'high',
        hookType: hookName,
        line,
        file: filePath,
        problematicDependency: dep,
        stateVariable: dep,
        setterFunction: setter,
        actualStateModifications: stateInteractions.cleanupModifications,
        stateReads: stateInteractions.reads,
        explanation: `${hookName} cleanup function calls '${setter}()' which modifies '${dep}' that the effect depends on. This creates an infinite loop: effect runs → cleanup runs → state changes → effect re-runs.`,
      });
    }

    // Check direct modifications
    if (stateInteractions.modifications.includes(setter)) {
      // Use CFG analysis if available for more accurate unconditional detection
      const setterCfgAnalysis = cfgAnalysis?.get(setter);

      // Determine if setState is truly unconditional
      // CFG analysis can detect early returns and complex guards the heuristic misses
      const isUnconditionalByCFG = setterCfgAnalysis?.isUnconditional ?? true;
      const hasEffectiveGuardByCFG = setterCfgAnalysis?.hasEffectiveGuard ?? false;

      // If CFG says it's unreachable (dead code), skip
      if (setterCfgAnalysis && !setterCfgAnalysis.isReachable) {
        continue; // Dead code - setState never executes
      }

      // If CFG detected an effective guard, treat as safe
      if (hasEffectiveGuardByCFG && setterCfgAnalysis?.guardAnalysis) {
        return createAnalysis({
          type: 'safe-pattern',
          errorCode: 'RLD-200',
          category: 'safe',
          severity: 'low',
          confidence: 'high',
          hookType: hookName,
          line,
          file: filePath,
          problematicDependency: dep,
          stateVariable: dep,
          setterFunction: setter,
          actualStateModifications: [setter],
          stateReads: stateInteractions.reads,
          explanation: `Hook modifies '${dep}' but CFG analysis detected an effective ${setterCfgAnalysis.guardAnalysis.guardType}: ${setterCfgAnalysis.guardAnalysis.explanation}`,
          debugInfo: {
            reason: `CFG analysis: ${setterCfgAnalysis.explanation}`,
            guardInfo: {
              hasGuard: true,
              guardType: setterCfgAnalysis.guardAnalysis.guardType,
            },
          },
        });
      }

      if (canCauseDirectLoop && isUnconditionalByCFG) {
        // Determine if it's useEffect or useLayoutEffect for the error code
        const effectErrorCode: ErrorCode = hookName === 'useLayoutEffect' ? 'RLD-202' : 'RLD-200';
        return createAnalysis({
          type: 'confirmed-infinite-loop',
          errorCode: effectErrorCode,
          category: 'critical',
          severity: 'high',
          confidence: 'high',
          hookType: hookName,
          line,
          file: filePath,
          problematicDependency: dep,
          stateVariable: dep,
          setterFunction: setter,
          actualStateModifications: stateInteractions.modifications,
          stateReads: stateInteractions.reads,
          explanation: `${hookName} modifies '${dep}' via '${setter}()' while depending on it, creating guaranteed infinite loop.`,
          debugInfo: {
            reason: setterCfgAnalysis
              ? `CFG analysis: ${setterCfgAnalysis.explanation}`
              : `Direct state modification: ${hookName} depends on '${dep}' and calls '${setter}()' unconditionally`,
            stateTracking: {
              declaredStateVars: Array.from(stateInfo.keys()),
              setterFunctions: Array.from(stateInfo.values()),
              stableVariables: [],
              unstableVariables: [],
            },
            dependencyAnalysis: {
              rawDependencies: dependencies,
              problematicDeps: [dep],
              safeDeps: dependencies.filter((d) => d !== dep),
            },
            guardInfo: {
              hasGuard: false,
            },
            deferredInfo: {
              isDeferred: false,
            },
          },
        });
      } else if (canCauseDirectLoop && !isUnconditionalByCFG) {
        // CFG says it's conditional - report as potential issue, not confirmed
        return createAnalysis({
          type: 'potential-issue',
          errorCode: 'RLD-501',
          category: 'warning',
          severity: 'medium',
          confidence: 'medium',
          hookType: hookName,
          line,
          file: filePath,
          problematicDependency: dep,
          stateVariable: dep,
          setterFunction: setter,
          actualStateModifications: stateInteractions.modifications,
          stateReads: stateInteractions.reads,
          explanation: `${hookName} conditionally modifies '${dep}' via '${setter}()' while depending on it. Review to ensure the condition prevents infinite loops.`,
          debugInfo: {
            reason: setterCfgAnalysis
              ? `CFG analysis: ${setterCfgAnalysis.explanation}`
              : `Conditional state modification detected`,
            guardInfo: {
              hasGuard: true,
              guardType: 'conditional',
            },
          },
        });
      } else if (!canCauseDirectLoop) {
        // useCallback/useMemo - can't cause loops directly
        // If it uses a functional updater, it's completely safe - don't report
        if (stateInteractions.functionalUpdates.includes(setter)) {
          return null; // Functional updater in useCallback/useMemo is safe
        }
        // Only warn if it's NOT using functional updater (reads dep value directly)
        return createAnalysis({
          type: 'potential-issue',
          errorCode: 'RLD-420',
          category: 'warning',
          severity: 'low',
          confidence: 'medium',
          hookType: hookName,
          line,
          file: filePath,
          problematicDependency: dep,
          stateVariable: dep,
          setterFunction: setter,
          actualStateModifications: stateInteractions.modifications,
          stateReads: stateInteractions.reads,
          explanation: `${hookName} modifies '${dep}' while depending on it. This won't cause a direct infinite loop (${hookName} doesn't auto-execute), but review if a useEffect depends on this callback.`,
        });
      }
    }

    // Check indirect modifications through cross-file calls
    if (crossFileModifications.includes(setter)) {
      if (canCauseDirectLoop) {
        return createAnalysis({
          type: 'confirmed-infinite-loop',
          errorCode: 'RLD-300',
          category: 'critical',
          severity: 'high',
          confidence: 'high',
          hookType: hookName,
          line,
          file: filePath,
          problematicDependency: dep,
          stateVariable: dep,
          setterFunction: setter,
          actualStateModifications: crossFileModifications,
          stateReads: stateInteractions.reads,
          explanation: `${hookName} indirectly modifies '${dep}' via function calls while depending on it, creating guaranteed infinite loop.`,
        });
      } else {
        return createAnalysis({
          type: 'potential-issue',
          errorCode: 'RLD-301',
          category: 'warning',
          severity: 'low',
          confidence: 'medium',
          hookType: hookName,
          line,
          file: filePath,
          problematicDependency: dep,
          stateVariable: dep,
          setterFunction: setter,
          actualStateModifications: crossFileModifications,
          stateReads: stateInteractions.reads,
          explanation: `${hookName} indirectly modifies '${dep}' while depending on it. This won't cause a direct infinite loop (${hookName} doesn't auto-execute).`,
        });
      }
    }

    // Check conditional modifications (that weren't identified as safely guarded)
    if (stateInteractions.conditionalModifications.includes(setter)) {
      if (canCauseDirectLoop) {
        return createAnalysis({
          type: 'potential-issue',
          errorCode: 'RLD-501',
          category: 'warning',
          severity: 'medium',
          confidence: 'medium',
          hookType: hookName,
          line,
          file: filePath,
          problematicDependency: dep,
          stateVariable: dep,
          setterFunction: setter,
          actualStateModifications: stateInteractions.conditionalModifications,
          stateReads: stateInteractions.reads,
          explanation: `${hookName} conditionally modifies '${dep}' - review if conditions prevent infinite loops.`,
        });
      } else {
        // useCallback/useMemo with conditional modification - very unlikely to be a problem
        return null; // Don't report - too low risk
      }
    }

    // Only reads state, doesn't modify - don't return early, continue checking other deps
  }

  // Check for ref mutations that store state values - potential stale closure issues
  // This is a lower-priority warning as refs don't cause re-renders, but storing
  // state in refs can lead to stale data if not used carefully
  if (stateInteractions.refMutations.length > 0 && canCauseDirectLoop) {
    for (const refMutation of stateInteractions.refMutations) {
      if (refMutation.usesStateValue) {
        // Check if this ref is also read in the dependencies
        const refInDeps = dependencies.some(
          (dep) => dep === refMutation.refName || dep.includes(refMutation.refName)
        );

        if (refInDeps) {
          // Ref is both mutated with state value AND in dependencies - potential loop
          return createAnalysis({
            type: 'potential-issue',
            errorCode: 'RLD-600',
            category: 'warning',
            severity: 'low',
            confidence: 'low',
            hookType: hookName,
            line: refMutation.line,
            file: filePath,
            problematicDependency: refMutation.refName,
            stateVariable: refMutation.assignedValue || 'state',
            setterFunction: 'ref.current =',
            actualStateModifications: [],
            stateReads: stateInteractions.reads,
            explanation: `${hookName} mutates '${refMutation.refName}.current' with state value while depending on the ref. This can cause stale closure issues.`,
            debugInfo: {
              reason: `Ref '${refMutation.refName}' is mutated with state value '${refMutation.assignedValue}' and appears in dependencies`,
              stateTracking: {
                declaredStateVars: Array.from(stateInfo.keys()),
                setterFunctions: Array.from(stateInfo.values()),
                stableVariables: [],
                unstableVariables: [],
              },
              dependencyAnalysis: {
                rawDependencies: dependencies,
                problematicDeps: [refMutation.refName],
                safeDeps: dependencies.filter((d) => d !== refMutation.refName),
              },
            },
          });
        }
      }
    }
  }

  return null;
}
