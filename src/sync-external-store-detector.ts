/**
 * useSyncExternalStore Detector Module
 *
 * Detects unstable getSnapshot functions passed to useSyncExternalStore.
 * An unstable getSnapshot (inline arrow function or function that creates new objects)
 * causes a synchronous infinite loop because React will call getSnapshot repeatedly
 * and receive different object references each time.
 *
 * React API:
 *   useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot?)
 *
 * The getSnapshot function must return a stable value (same reference for same data).
 * If it returns a new object/array each time, React will infinitely re-render.
 */

import * as t from '@babel/types';
import traverse, { NodePath } from '@babel/traverse';
import { HookAnalysis, ErrorCode } from './types';
import { UnstableVariable } from './state-extractor';
import {
  isHookIgnored,
  createAnalysis,
  isStrictModeEnabled,
  getConfidenceExplanation,
} from './utils';

interface SyncExternalStoreCall {
  node: t.CallExpression;
  line: number;
  column?: number;
}

/**
 * Find all useSyncExternalStore calls in an AST.
 */
function findSyncExternalStoreCalls(ast: t.Node): SyncExternalStoreCall[] {
  const calls: SyncExternalStoreCall[] = [];

  traverse(ast, {
    CallExpression(nodePath: NodePath<t.CallExpression>) {
      if (
        t.isIdentifier(nodePath.node.callee) &&
        nodePath.node.callee.name === 'useSyncExternalStore'
      ) {
        calls.push({
          node: nodePath.node,
          line: nodePath.node.loc?.start.line || 0,
          column: nodePath.node.loc?.start.column,
        });
      }
    },
  });

  return calls;
}

/**
 * Check if an expression is an inline function (arrow function or function expression).
 */
function isInlineFunction(node: t.Node | null | undefined): boolean {
  if (!node) return false;
  return t.isArrowFunctionExpression(node) || t.isFunctionExpression(node);
}

/**
 * Recursively check if a node contains a return statement with object/array literal.
 */
function containsReturnWithNewRef(node: t.Node): boolean {
  if (t.isReturnStatement(node)) {
    const arg = node.argument;
    return arg !== null && (t.isObjectExpression(arg) || t.isArrayExpression(arg));
  }

  // Recursively check block statements
  if (t.isBlockStatement(node)) {
    return node.body.some((stmt) => containsReturnWithNewRef(stmt));
  }

  // Check if/else branches
  if (t.isIfStatement(node)) {
    if (containsReturnWithNewRef(node.consequent)) return true;
    if (node.alternate && containsReturnWithNewRef(node.alternate)) return true;
  }

  // Check try/catch/finally
  if (t.isTryStatement(node)) {
    if (containsReturnWithNewRef(node.block)) return true;
    if (node.handler && containsReturnWithNewRef(node.handler.body)) return true;
    if (node.finalizer && containsReturnWithNewRef(node.finalizer)) return true;
  }

  return false;
}

/**
 * Check if an inline function returns a new object/array on every call.
 * This is the critical pattern that causes infinite loops with useSyncExternalStore.
 */
function returnsNewObjectOrArray(fn: t.ArrowFunctionExpression | t.FunctionExpression): boolean {
  // For arrow functions with expression body: () => ({ ... }) or () => [...]
  if (t.isArrowFunctionExpression(fn) && !t.isBlockStatement(fn.body)) {
    return t.isObjectExpression(fn.body) || t.isArrayExpression(fn.body);
  }

  // For functions with block bodies, check return statements
  const body = fn.body;
  if (!t.isBlockStatement(body)) return false;

  return containsReturnWithNewRef(body);
}

/**
 * Find an unstable variable by name within a component's scope.
 */
function findUnstableVar(
  unstableVars: Map<string, UnstableVariable>,
  varName: string,
  hookLine: number
): UnstableVariable | undefined {
  // Try to find a variable in a component that contains this hook (by line range)
  for (const unstableVar of unstableVars.values()) {
    if (
      unstableVar.name === varName &&
      unstableVar.componentStartLine !== undefined &&
      unstableVar.componentEndLine !== undefined &&
      hookLine >= unstableVar.componentStartLine &&
      hookLine <= unstableVar.componentEndLine
    ) {
      return unstableVar;
    }
  }

  // Fall back to non-component-scoped lookup
  return unstableVars.get(varName);
}

/**
 * Detect unstable getSnapshot functions in useSyncExternalStore calls.
 * Returns an array of HookAnalysis issues found.
 */
export function detectUnstableSyncExternalStore(
  ast: t.Node,
  unstableVars: Map<string, UnstableVariable>,
  filePath: string,
  fileContent?: string
): HookAnalysis[] {
  const results: HookAnalysis[] = [];
  const calls = findSyncExternalStoreCalls(ast);

  for (const call of calls) {
    const { node, line, column } = call;

    // Check for ignore comments
    if (fileContent && isHookIgnored(fileContent, line)) {
      continue;
    }

    // useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot?)
    // We focus on getSnapshot (2nd argument) as it's the most common source of issues
    const args = node.arguments;
    if (args.length < 2) {
      continue; // Invalid call, skip
    }

    const getSnapshotArg = args[1];

    // Case 1: Inline arrow function that returns new object/array
    // useSyncExternalStore(subscribe, () => ({ data }))
    if (isInlineFunction(getSnapshotArg)) {
      const fn = getSnapshotArg as t.ArrowFunctionExpression | t.FunctionExpression;

      if (returnsNewObjectOrArray(fn)) {
        results.push(
          createAnalysis({
            type: 'confirmed-infinite-loop',
            errorCode: 'RLD-407' as ErrorCode,
            category: 'critical',
            severity: 'high',
            confidence: 'high',
            hookType: 'useSyncExternalStore',
            line,
            column,
            file: filePath,
            problematicDependency: 'getSnapshot',
            stateVariable: undefined,
            setterFunction: undefined,
            actualStateModifications: [],
            stateReads: [],
            explanation:
              `The getSnapshot function passed to useSyncExternalStore returns a new object/array on every call. ` +
              `This causes a synchronous infinite loop because React compares snapshots by reference, ` +
              `and a new object is never equal to the previous one.`,
            suggestion: `Return a cached value, use a primitive, or memoize the result outside the callback.`,
            debugInfo: {
              reason: 'Inline getSnapshot function returns new object/array literal',
            },
          })
        );
        continue;
      }
    }

    // Case 2: Variable reference that's an unstable function
    // const getSnapshot = () => ({ data });
    // useSyncExternalStore(subscribe, getSnapshot)
    if (t.isIdentifier(getSnapshotArg)) {
      const varName = getSnapshotArg.name;
      const unstableVar = findUnstableVar(unstableVars, varName, line);

      if (unstableVar && !unstableVar.isMemoized) {
        // Check if it's a function type
        if (unstableVar.type === 'function' || unstableVar.type === 'function-call') {
          const confidenceContext = {
            usedTypeInference: true,
            isConditional: false,
            isStrictMode: isStrictModeEnabled(),
          };
          const confidenceExplanation = getConfidenceExplanation('medium', confidenceContext);
          results.push(
            createAnalysis({
              type: 'potential-issue',
              errorCode: 'RLD-407' as ErrorCode,
              category: 'performance',
              severity: 'medium',
              confidence: 'medium',
              hookType: 'useSyncExternalStore',
              line,
              column,
              file: filePath,
              problematicDependency: varName,
              stateVariable: undefined,
              setterFunction: undefined,
              actualStateModifications: [],
              stateReads: [],
              explanation:
                `'${varName}' passed as getSnapshot to useSyncExternalStore is recreated on every render. ` +
                `If it returns a new object/array each time, this will cause an infinite loop.${confidenceExplanation}`,
              suggestion: `Wrap '${varName}' with useCallback, or ensure it returns a stable reference.`,
              debugInfo: {
                reason: `Unstable ${unstableVar.type} '${varName}' used as getSnapshot argument`,
                stateTracking: {
                  declaredStateVars: [],
                  setterFunctions: [],
                  stableVariables: [],
                  unstableVariables: Array.from(unstableVars.keys()),
                },
              },
            })
          );
        }
      }
    }
  }

  return results;
}
