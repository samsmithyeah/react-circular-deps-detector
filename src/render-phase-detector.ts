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
import { analyzeRenderPhaseGuard } from './guard-analyzer';

/** React HOCs that wrap component functions */
const REACT_COMPONENT_WRAPPERS = new Set(['memo', 'forwardRef']);

/**
 * Extract the component function from a VariableDeclarator's init.
 * Handles:
 * - Direct: `const Comp = () => {}`
 * - memo: `const Comp = memo(() => {})`
 * - React.memo: `const Comp = React.memo(() => {})`
 * - forwardRef: `const Comp = forwardRef(() => {})`
 * - React.forwardRef: `const Comp = React.forwardRef(() => {})`
 *
 * Returns null if the init is not a component function.
 */
function getComponentFunctionPath(
  varPath: NodePath<t.VariableDeclarator>
): NodePath<t.ArrowFunctionExpression | t.FunctionExpression> | null {
  const initPath = varPath.get('init');

  // Direct arrow/function expression
  if (initPath.isArrowFunctionExpression() || initPath.isFunctionExpression()) {
    return initPath as NodePath<t.ArrowFunctionExpression | t.FunctionExpression>;
  }

  // Check for HOC wrapper: memo(() => {}), React.memo(() => {}), forwardRef(() => {}), etc.
  if (initPath.isCallExpression()) {
    const callee = initPath.node.callee;
    let isWrapper = false;

    // Check for `memo(...)` or `forwardRef(...)`
    if (t.isIdentifier(callee) && REACT_COMPONENT_WRAPPERS.has(callee.name)) {
      isWrapper = true;
    }
    // Check for `React.memo(...)` or `React.forwardRef(...)`
    else if (
      t.isMemberExpression(callee) &&
      t.isIdentifier(callee.object) &&
      callee.object.name === 'React' &&
      t.isIdentifier(callee.property) &&
      REACT_COMPONENT_WRAPPERS.has(callee.property.name)
    ) {
      isWrapper = true;
    }

    if (isWrapper && initPath.node.arguments[0]) {
      const firstArgPath = initPath.get('arguments.0') as NodePath;
      if (firstArgPath.isArrowFunctionExpression() || firstArgPath.isFunctionExpression()) {
        return firstArgPath as NodePath<t.ArrowFunctionExpression | t.FunctionExpression>;
      }
    }
  }

  return null;
}

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
    // Also handles memo()/React.memo()/forwardRef()/React.forwardRef() wrappers
    VariableDeclarator(varPath: NodePath<t.VariableDeclarator>) {
      if (!t.isIdentifier(varPath.node.id)) return;
      const varName = varPath.node.id.name;
      if (!/^[A-Z]/.test(varName)) return; // Not a component

      const funcPath = getComponentFunctionPath(varPath);
      if (!funcPath) return;

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
 * Get ancestor stack as array of nodes for guard analysis.
 */
function getAncestorStack(path: NodePath): t.Node[] {
  const ancestors: t.Node[] = [];
  let current: NodePath | null = path;
  while (current) {
    ancestors.push(current.node);
    current = current.parentPath;
  }
  return ancestors;
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

      // Check if this setState is guarded by a condition (derived state pattern)
      // Example: if (row !== prevRow) setPrevRow(row)
      const ancestorStack = getAncestorStack(callPath);
      const guardAnalysis = analyzeRenderPhaseGuard(
        callPath.node,
        ancestorStack,
        calleeName,
        stateVar
      );

      if (guardAnalysis?.isSafe) {
        // This is a valid "derived state" pattern - safe
        // React documentation explicitly supports this pattern:
        // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
        return;
      }

      if (guardAnalysis && !guardAnalysis.isSafe) {
        // Guarded but not a safe pattern (e.g., if (count < 100) setCount(count + 1))
        // This will eventually stop, but is still problematic
        results.push(
          createAnalysis({
            type: 'potential-issue',
            errorCode: 'RLD-100',
            category: 'warning',
            severity: 'medium',
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
              `'${calleeName}()' is called during render with a guard condition. ` +
              `While the guard may eventually stop the updates, this pattern can cause multiple ` +
              `re-renders before stabilizing and may indicate a design issue.`,
            suggestion:
              `If this is intentional "derived state" (like tracking previous props), ensure the condition ` +
              `compares current vs previous values: \`if (prop !== prevProp) setPrevProp(prop)\`. ` +
              `Otherwise, move the setState into a useEffect hook.`,
          })
        );
        return;
      }

      // Unconditional setState during render - critical issue
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
 * Uses @babel/traverse for robust handling of all expression types.
 */
function expressionReferencesState(node: t.Node, stateNames: Set<string>): boolean {
  let referencesState = false;
  if (!node) return false;

  traverse(node, {
    noScope: true, // Don't build scope info - we're only traversing a sub-node
    Identifier(path) {
      if (stateNames.has(path.node.name) && path.isReferencedIdentifier()) {
        referencesState = true;
        path.stop(); // Stop traversal once a reference is found
      }
    },
  });

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
    // Also handles memo()/React.memo()/forwardRef()/React.forwardRef() wrappers
    VariableDeclarator(varPath: NodePath<t.VariableDeclarator>) {
      if (!t.isIdentifier(varPath.node.id)) return;
      const varName = varPath.node.id.name;
      if (!/^[A-Z]/.test(varName)) return; // Not a component

      const funcPath = getComponentFunctionPath(varPath);
      if (!funcPath) return;

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
