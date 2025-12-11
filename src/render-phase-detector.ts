/**
 * Render Phase Detector Module
 *
 * Detects problematic patterns during the render phase:
 * 1. setState calls (outside hooks, event handlers, callbacks) - causes infinite loops
 * 2. ref.current mutations - violates React's concurrent mode expectations
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
 *
 * @example
 * ```tsx
 * // BUG: Render-phase ref mutation (concurrent mode incompatible)
 * function Component() {
 *   const [count] = useState(0);
 *   const countRef = useRef(0);
 *   countRef.current = count; // Mutating ref during render!
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
            `This causes an infinite loop because each setState triggers a re-render, which calls setState again.`,
          suggestion: `Move '${calleeName}()' into a useEffect hook, event handler, or callback function.`,
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
  return isInsideSafeContextGeneric(callPath);
}

/**
 * Generic version that works with any node path type.
 * Safe contexts include:
 * - Inside useEffect, useCallback, useMemo, useLayoutEffect callbacks
 * - Inside arrow functions or function expressions (event handlers, callbacks)
 * - Inside nested function declarations (but NOT the component function itself)
 */
function isInsideSafeContextGeneric(nodePath: NodePath): boolean {
  let current: NodePath | null = nodePath.parentPath;

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

/**
 * Extract ref variable names from useRef() calls.
 * Returns a Map of ref variable name -> line number.
 */
function extractRefVariables(ast: t.Node): Map<string, number> {
  const refVars = new Map<string, number>();

  traverse(ast, {
    CallExpression(path: NodePath<t.CallExpression>) {
      // Look for useRef() calls
      if (!t.isIdentifier(path.node.callee) || path.node.callee.name !== 'useRef') {
        return;
      }

      // Find the variable declaration: const myRef = useRef(...)
      const parent = path.parentPath;
      if (parent && t.isVariableDeclarator(parent.node) && t.isIdentifier(parent.node.id)) {
        const refName = parent.node.id.name;
        const line = path.node.loc?.start.line || 0;
        refVars.set(refName, line);
      }
    },
  });

  return refVars;
}

/**
 * Extract state variable names from useState() calls.
 * Returns a Set of state variable names.
 */
function extractStateVariableNames(ast: t.Node): Set<string> {
  const stateNames = new Set<string>();

  traverse(ast, {
    CallExpression(path: NodePath<t.CallExpression>) {
      // Look for useState() calls
      if (!t.isIdentifier(path.node.callee) || path.node.callee.name !== 'useState') {
        return;
      }

      // Find the array destructuring: const [state, setState] = useState(...)
      const parent = path.parentPath;
      if (parent && t.isVariableDeclarator(parent.node) && t.isArrayPattern(parent.node.id)) {
        const elements = parent.node.id.elements;
        if (elements[0] && t.isIdentifier(elements[0])) {
          stateNames.add(elements[0].name);
        }
      }
    },
  });

  return stateNames;
}

/**
 * Check if an expression references any state variable.
 */
function expressionReferencesState(node: t.Node, stateNames: Set<string>): boolean {
  let referencesState = false;

  // Simple traversal to check if any identifier matches a state variable
  const checkNode = (n: t.Node): void => {
    if (t.isIdentifier(n) && stateNames.has(n.name)) {
      referencesState = true;
    } else if (t.isMemberExpression(n)) {
      checkNode(n.object);
      if (!n.computed) {
        // Don't check property name for non-computed access
      } else {
        checkNode(n.property);
      }
    } else if (t.isBinaryExpression(n) || t.isLogicalExpression(n)) {
      checkNode(n.left);
      checkNode(n.right);
    } else if (t.isConditionalExpression(n)) {
      checkNode(n.test);
      checkNode(n.consequent);
      checkNode(n.alternate);
    } else if (t.isCallExpression(n)) {
      n.arguments.forEach((arg) => {
        if (t.isExpression(arg) || t.isSpreadElement(arg)) {
          checkNode(arg);
        }
      });
    } else if (t.isObjectExpression(n)) {
      n.properties.forEach((prop) => {
        if (t.isObjectProperty(prop) && t.isExpression(prop.value)) {
          checkNode(prop.value);
        }
      });
    } else if (t.isArrayExpression(n)) {
      n.elements.forEach((el) => {
        if (el && t.isExpression(el)) {
          checkNode(el);
        }
      });
    } else if (t.isSpreadElement(n)) {
      checkNode(n.argument);
    }
  };

  checkNode(node);
  return referencesState;
}

/**
 * Detect ref.current mutations during render phase (outside hooks, event handlers, callbacks).
 * This is problematic because:
 * - Concurrent mode may render multiple times before commit
 * - Refs should only be mutated in effects or event handlers
 * - Render-phase mutations can cause tearing and inconsistent UI
 */
export function detectRefMutationDuringRender(
  ast: t.Node,
  filePath: string,
  fileContent?: string
): HookAnalysis[] {
  const results: HookAnalysis[] = [];
  const refVars = extractRefVariables(ast);
  const stateNames = extractStateVariableNames(ast);

  if (refVars.size === 0) return results;

  traverse(ast, {
    // Look for function declarations that look like React components (PascalCase)
    FunctionDeclaration(funcPath: NodePath<t.FunctionDeclaration>) {
      const funcName = funcPath.node.id?.name;
      if (!funcName || !/^[A-Z]/.test(funcName)) return; // Not a component

      checkComponentBodyForRefMutation(
        funcPath,
        refVars,
        stateNames,
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
      checkComponentBodyForRefMutation(
        funcPath,
        refVars,
        stateNames,
        filePath,
        fileContent,
        results
      );
    },
  });

  return results;
}

/**
 * Check a component's function body for ref.current mutations that happen during render.
 */
function checkComponentBodyForRefMutation(
  funcPath: NodePath<t.FunctionDeclaration | t.ArrowFunctionExpression | t.FunctionExpression>,
  refVars: Map<string, number>,
  stateNames: Set<string>,
  filePath: string,
  fileContent: string | undefined,
  results: HookAnalysis[]
): void {
  const body = funcPath.node.body;
  if (!t.isBlockStatement(body)) return; // Arrow function with expression body

  funcPath.traverse({
    AssignmentExpression(assignPath: NodePath<t.AssignmentExpression>) {
      const left = assignPath.node.left;

      // Check if this is a ref.current assignment: refVar.current = value
      if (
        !t.isMemberExpression(left) ||
        !t.isIdentifier(left.object) ||
        !t.isIdentifier(left.property) ||
        left.property.name !== 'current'
      ) {
        return;
      }

      const refName = left.object.name;
      if (!refVars.has(refName)) return; // Not a known ref variable

      // Check if this assignment is inside a safe context (hook callback, event handler, nested function)
      if (isInsideSafeContextGeneric(assignPath)) return;

      const line = assignPath.node.loc?.start.line || 0;

      // Check for ignore comments
      if (fileContent && isHookIgnored(fileContent, line)) return;

      // Check if the assigned value references state (higher severity)
      const rightSide = assignPath.node.right;
      const usesState = expressionReferencesState(rightSide, stateNames);

      // Get the assigned value for the message
      let assignedValue: string | undefined;
      if (t.isIdentifier(rightSide)) {
        assignedValue = rightSide.name;
      }

      results.push(
        createAnalysis({
          type: 'potential-issue',
          errorCode: 'RLD-600',
          category: 'warning',
          severity: usesState ? 'high' : 'medium',
          confidence: 'high',
          hookType: 'render',
          line,
          column: assignPath.node.loc?.start.column,
          file: filePath,
          problematicDependency: refName,
          stateVariable: usesState ? assignedValue : undefined,
          setterFunction: `${refName}.current`,
          actualStateModifications: [],
          stateReads: usesState && assignedValue ? [assignedValue] : [],
          explanation: usesState
            ? `'${refName}.current' is mutated with state value '${assignedValue || 'expression'}' during render. ` +
              `Refs should only be mutated in effects or event handlers, not during render. ` +
              `This can cause issues with React's concurrent rendering.`
            : `'${refName}.current' is mutated during render. ` +
              `Refs should only be mutated in effects or event handlers, not during render. ` +
              `This can cause issues with React's concurrent rendering.`,
          suggestion: `Move the ref mutation into a useEffect hook, useLayoutEffect, or an event handler.`,
        })
      );
    },
  });
}
