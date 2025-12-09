/**
 * Unstable References Detector Module
 *
 * Detects unstable references in hook dependency arrays that may cause
 * unnecessary re-renders or infinite loops.
 *
 * Common patterns detected:
 * - Object literals in dependencies
 * - Array literals in dependencies
 * - Functions defined in component body
 * - Function call results that return new objects
 */

import * as t from '@babel/types';
import { HookAnalysis, HookNodeInfo, ErrorCode } from './types';
import { UnstableVariable } from './state-extractor';
import { isHookIgnored, createAnalysis } from './utils';
import { hasUnconditionalSetStateCFG } from './control-flow';

/**
 * Check if a hook has unstable references in its dependency array.
 * Returns an analysis if an issue is found, null otherwise.
 */
export function checkUnstableReferences(
  hookNode: HookNodeInfo,
  unstableVars: Map<string, UnstableVariable>,
  stateInfo: Map<string, string>,
  filePath: string,
  fileContent?: string
): HookAnalysis | null {
  const { node, hookName, line } = hookNode;

  // Check for ignore comments
  if (fileContent && isHookIgnored(fileContent, line)) {
    return null;
  }

  if (!node.arguments || node.arguments.length < 2) {
    return null; // No dependencies array
  }

  // Get the effect/callback body (first argument)
  const effectBody = node.arguments[0];

  // Get dependencies array
  const depsArray = node.arguments[node.arguments.length - 1];
  if (!t.isArrayExpression(depsArray)) {
    return null;
  }

  // For useEffect/useLayoutEffect, check if there are unconditional setState calls
  const isUseEffect = hookName === 'useEffect' || hookName === 'useLayoutEffect';

  // Use CFG-based analysis to check for unconditional setState calls
  let hasUnconditionalStateUpdate = false;
  if (isUseEffect && effectBody) {
    hasUnconditionalStateUpdate = hasUnconditionalSetStateCFG(effectBody, stateInfo);
  }

  // Check each dependency
  for (const dep of depsArray.elements) {
    if (!t.isIdentifier(dep)) continue;

    const depName = dep.name;

    // Skip if it's a state variable (managed by React, stable reference within render)
    if (stateInfo.has(depName)) continue;

    // Check if this dependency is an unstable variable
    const unstableVar = unstableVars.get(depName);
    if (unstableVar) {
      const typeDescriptions: Record<string, string> = {
        object: 'object literal',
        array: 'array literal',
        function: 'function',
        'function-call': 'function call result',
      };

      // Determine severity based on whether there's an unconditional setState
      // - If useEffect with unconditional setState: confirmed infinite loop (high severity)
      // - If useEffect with only conditional setState: potential issue (medium severity) - effect runs often but won't loop
      // - If useCallback/useMemo: potential issue (medium severity) - unnecessary re-creation
      const isConfirmedLoop = isUseEffect && hasUnconditionalStateUpdate;

      // Determine error code based on unstable variable type
      const unstableTypeToErrorCode: Record<UnstableVariable['type'], ErrorCode> = {
        object: 'RLD-400',
        array: 'RLD-401',
        function: 'RLD-402',
        'function-call': 'RLD-403',
      };

      return createAnalysis({
        type: isConfirmedLoop ? 'confirmed-infinite-loop' : 'potential-issue',
        errorCode: isConfirmedLoop ? 'RLD-200' : unstableTypeToErrorCode[unstableVar.type],
        category: isConfirmedLoop ? 'critical' : 'performance',
        severity: isConfirmedLoop ? 'high' : 'low',
        confidence: 'high',
        hookType: hookName,
        line,
        file: filePath,
        problematicDependency: depName,
        stateVariable: undefined,
        setterFunction: undefined,
        actualStateModifications: [],
        stateReads: [],
        explanation: isConfirmedLoop
          ? `'${depName}' is a ${typeDescriptions[unstableVar.type]} created inside the component. ` +
            `It gets a new reference on every render, and this ${hookName} has an unconditional setState, ` +
            `causing an infinite re-render loop. ` +
            `Fix: wrap with useMemo/useCallback, move outside the component, or remove from dependencies.`
          : isUseEffect
            ? `'${depName}' is a ${typeDescriptions[unstableVar.type]} created inside the component. ` +
              `It gets a new reference on every render, causing this ${hookName} to run on every render. ` +
              `This is a performance issue but won't cause an infinite loop since setState calls are conditional. ` +
              `Fix: wrap with useMemo/useCallback, move outside the component, or remove from dependencies.`
            : `'${depName}' is a ${typeDescriptions[unstableVar.type]} created inside the component. ` +
              `It gets a new reference on every render, causing unnecessary ${hookName} re-creation. ` +
              `Fix: wrap with useMemo/useCallback or move outside the component.`,
        debugInfo: {
          reason: `Detected unstable ${unstableVar.type} '${depName}' in dependency array`,
          stateTracking: {
            declaredStateVars: Array.from(stateInfo.keys()),
            setterFunctions: Array.from(stateInfo.values()),
            stableVariables: [],
            unstableVariables: Array.from(unstableVars.keys()),
          },
          dependencyAnalysis: {
            rawDependencies: depsArray.elements
              .filter((el): el is t.Identifier => t.isIdentifier(el))
              .map((el) => el.name),
            problematicDeps: [depName],
            safeDeps: depsArray.elements
              .filter((el): el is t.Identifier => t.isIdentifier(el) && el.name !== depName)
              .map((el) => el.name),
          },
        },
      });
    }
  }

  return null;
}
