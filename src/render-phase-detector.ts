/**
 * Render Phase Detector Module
 *
 * Detects setState calls during the render phase (outside hooks, event handlers, callbacks).
 * This is a guaranteed infinite loop pattern because:
 * - setState during render triggers a re-render
 * - Which runs the component body again
 * - Which calls setState again -> infinite loop
 *
 * @example
 * ```tsx
 * // BUG: This will crash the browser
 * function Component() {
 *   const [count, setCount] = useState(0);
 *   setCount(count + 1); // Called during render!
 *   return <div>{count}</div>;
 * }
 * ```
 */

import * as t from '@babel/types';
import traverse, { NodePath } from '@babel/traverse';
import { HookAnalysis } from './types';
import { isHookIgnored, createAnalysis } from './utils';

/**
 * Detect setState calls during render phase (outside hooks, event handlers, callbacks).
 * This is a guaranteed infinite loop pattern.
 */
export function detectSetStateDuringRender(
  ast: t.Node,
  stateInfo: Map<string, string>,
  filePath: string,
  fileContent?: string
): HookAnalysis[] {
  const results: HookAnalysis[] = [];
  const setterNames = new Set(stateInfo.values());

  // Build reverse map: setter -> state variable
  const setterToState = new Map<string, string>();
  stateInfo.forEach((setter, state) => setterToState.set(setter, state));

  traverse(ast, {
    // Look for function declarations that look like React components (PascalCase)
    FunctionDeclaration(funcPath: NodePath<t.FunctionDeclaration>) {
      const funcName = funcPath.node.id?.name;
      if (!funcName || !/^[A-Z]/.test(funcName)) return; // Not a component

      checkComponentBodyForSetState(
        funcPath,
        setterNames,
        setterToState,
        filePath,
        fileContent,
        results
      );
    },

    // Arrow function components: const MyComponent = () => { ... }
    VariableDeclarator(varPath: NodePath<t.VariableDeclarator>) {
      if (!t.isIdentifier(varPath.node.id)) return;
      const varName = varPath.node.id.name;
      if (!/^[A-Z]/.test(varName)) return; // Not a component

      const init = varPath.node.init;
      if (!t.isArrowFunctionExpression(init) && !t.isFunctionExpression(init)) return;

      // Get the path to the arrow/function expression
      const funcPath = varPath.get('init') as NodePath<
        t.ArrowFunctionExpression | t.FunctionExpression
      >;
      checkComponentBodyForSetState(
        funcPath,
        setterNames,
        setterToState,
        filePath,
        fileContent,
        results
      );
    },
  });

  return results;
}

/**
 * Check a component's function body for setState calls that happen during render.
 */
function checkComponentBodyForSetState(
  funcPath: NodePath<t.FunctionDeclaration | t.ArrowFunctionExpression | t.FunctionExpression>,
  setterNames: Set<string>,
  setterToState: Map<string, string>,
  filePath: string,
  fileContent: string | undefined,
  results: HookAnalysis[]
): void {
  const body = funcPath.node.body;
  if (!t.isBlockStatement(body)) return; // Arrow function with expression body

  // Find all setState calls in the component body that are NOT inside:
  // - useEffect, useCallback, useMemo, useLayoutEffect callbacks
  // - event handlers (arrow functions or function expressions assigned to variables)
  // - nested functions

  funcPath.traverse({
    CallExpression(callPath: NodePath<t.CallExpression>) {
      if (!t.isIdentifier(callPath.node.callee)) return;
      const calleeName = callPath.node.callee.name;

      if (!setterNames.has(calleeName)) return;

      // Check if this call is inside a safe context (hook callback, event handler, nested function)
      if (isInsideSafeContext(callPath)) return;

      const line = callPath.node.loc?.start.line || 0;

      // Check for ignore comments
      if (fileContent && isHookIgnored(fileContent, line)) return;

      const stateVar = setterToState.get(calleeName) || calleeName;

      results.push(
        createAnalysis({
          type: 'confirmed-infinite-loop',
          errorCode: 'RLD-100',
          category: 'critical',
          severity: 'high',
          confidence: 'high',
          hookType: 'render',
          line,
          column: callPath.node.loc?.start.column,
          file: filePath,
          problematicDependency: stateVar,
          stateVariable: stateVar,
          setterFunction: calleeName,
          actualStateModifications: [calleeName],
          stateReads: [],
          explanation:
            `'${calleeName}()' is called directly during render (in the component body). ` +
            `This causes an infinite loop because each setState triggers a re-render, which calls setState again. ` +
            `Fix: move the setState call into a useEffect, event handler, or callback.`,
        })
      );
    },
  });
}

/**
 * Check if a CallExpression is inside a safe context where setState won't cause render loops.
 * Safe contexts include:
 * - Inside useEffect, useCallback, useMemo, useLayoutEffect callbacks
 * - Inside arrow functions or function expressions (event handlers, callbacks)
 * - Inside nested function declarations (but NOT the component function itself)
 */
export function isInsideSafeContext(callPath: NodePath<t.CallExpression>): boolean {
  let current: NodePath | null = callPath.parentPath;

  while (current) {
    const node = current.node;

    // Check if we're inside a function (arrow or regular)
    if (t.isArrowFunctionExpression(node) || t.isFunctionExpression(node)) {
      // If we're inside an arrow/function expression, it's a safe context
      // (event handler, callback, hook callback, etc.)
      // BUT we need to check if this is the component itself (arrow function component)
      const parent = current.parentPath;
      if (
        parent &&
        t.isVariableDeclarator(parent.node) &&
        t.isIdentifier(parent.node.id) &&
        /^[A-Z]/.test(parent.node.id.name)
      ) {
        // This is the component function itself (arrow function component)
        // e.g., const MyComponent = () => { ... }
        return false;
      }

      // Otherwise it's a nested function - safe context
      return true;
    }

    // Check if we're inside a regular function declaration
    if (t.isFunctionDeclaration(node)) {
      // Check if this is the component function itself
      const funcName = node.id?.name;
      if (funcName && /^[A-Z]/.test(funcName)) {
        // This is the component function itself - NOT safe
        // We've reached the boundary
        return false;
      }

      // It's a nested function - safe context
      return true;
    }

    current = current.parentPath;
  }

  return false;
}
