/**
 * Shared utilities for ESLint rules
 */

import type { TSESTree } from '@typescript-eslint/utils';

/**
 * React hooks that create state
 */
export const STATE_HOOKS = new Set(['useState', 'useReducer']);

/**
 * React hooks that accept a callback and dependency array
 */
export const EFFECT_HOOKS = new Set([
  'useEffect',
  'useLayoutEffect',
  'useCallback',
  'useMemo',
  'useImperativeHandle',
]);

/**
 * React hooks that return stable references
 */
export const STABLE_HOOKS = new Set(['useRef', 'useId']);

/**
 * Built-in functions that return primitive values
 */
export const STABLE_FUNCTION_CALLS = new Set([
  'require',
  'String',
  'Number',
  'Boolean',
  'parseInt',
  'parseFloat',
]);

/**
 * Method calls that return primitive values
 */
export const PRIMITIVE_RETURNING_METHODS = new Set([
  // String methods
  'join',
  'toString',
  'toLocaleString',
  'valueOf',
  'charAt',
  'charCodeAt',
  'codePointAt',
  'substring',
  'substr',
  'slice',
  'trim',
  'trimStart',
  'trimEnd',
  'toLowerCase',
  'toUpperCase',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'normalize',
  'padStart',
  'padEnd',
  'repeat',
  'replace',
  'replaceAll',
  // Number methods
  'toFixed',
  'toExponential',
  'toPrecision',
  // Array methods that return primitives
  'indexOf',
  'lastIndexOf',
  'length',
  // Boolean checks
  'includes',
  'startsWith',
  'endsWith',
  'every',
  'some',
]);

/**
 * Static methods on built-in objects that return primitives
 */
export const PRIMITIVE_RETURNING_STATIC_METHODS: Record<string, Set<string>> = {
  Math: new Set([
    'abs',
    'acos',
    'acosh',
    'asin',
    'asinh',
    'atan',
    'atan2',
    'atanh',
    'cbrt',
    'ceil',
    'clz32',
    'cos',
    'cosh',
    'exp',
    'expm1',
    'floor',
    'fround',
    'hypot',
    'imul',
    'log',
    'log10',
    'log1p',
    'log2',
    'max',
    'min',
    'pow',
    'random',
    'round',
    'sign',
    'sin',
    'sinh',
    'sqrt',
    'tan',
    'tanh',
    'trunc',
  ]),
  Number: new Set(['isFinite', 'isInteger', 'isNaN', 'isSafeInteger', 'parseFloat', 'parseInt']),
  String: new Set(['fromCharCode', 'fromCodePoint']),
  Object: new Set(['is', 'hasOwn']),
  Array: new Set(['isArray']),
  Date: new Set(['now', 'parse', 'UTC']),
  JSON: new Set(['stringify']),
};

/**
 * Check if a name looks like a React component (PascalCase)
 */
export function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

/**
 * Check if a name looks like a state setter (setXxx)
 */
export function isSetterName(name: string): boolean {
  return name.startsWith('set') && name.length > 3 && name[3] === name[3].toUpperCase();
}

/**
 * Check if a name looks like a custom hook (useXxx)
 */
export function isHookName(name: string): boolean {
  return name.startsWith('use') && name.length > 3;
}

/**
 * Get the state variable name from a setter name
 * e.g., setCount -> count
 */
export function getStateNameFromSetter(setterName: string): string {
  return setterName.charAt(3).toLowerCase() + setterName.slice(4);
}

/**
 * Check if a call expression is a hook call
 */
export function isHookCall(node: TSESTree.CallExpression): boolean {
  if (node.callee.type === 'Identifier') {
    return isHookName(node.callee.name);
  }
  if (node.callee.type === 'MemberExpression' && node.callee.property.type === 'Identifier') {
    return isHookName(node.callee.property.name);
  }
  return false;
}

/**
 * Get the hook name from a call expression
 */
export function getHookName(node: TSESTree.CallExpression): string | null {
  if (node.callee.type === 'Identifier') {
    return node.callee.name;
  }
  if (node.callee.type === 'MemberExpression' && node.callee.property.type === 'Identifier') {
    return node.callee.property.name;
  }
  return null;
}

/**
 * Check if a call is a stable function call (returns primitive or stable value)
 */
export function isStableFunctionCall(node: TSESTree.CallExpression): boolean {
  const { callee } = node;

  // Check built-in stable functions
  if (callee.type === 'Identifier') {
    if (STABLE_FUNCTION_CALLS.has(callee.name)) {
      return true;
    }
    // React hooks that return stable values
    if (STABLE_HOOKS.has(callee.name)) {
      return true;
    }
    // Custom hooks are treated as stable by default (configurable)
    if (isHookName(callee.name)) {
      return true;
    }
  }

  // Check method calls that return primitives
  if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
    const methodName = callee.property.name;

    if (PRIMITIVE_RETURNING_METHODS.has(methodName)) {
      return true;
    }

    // Check static methods
    if (callee.object.type === 'Identifier') {
      const objectName = callee.object.name;
      const staticMethods = PRIMITIVE_RETURNING_STATIC_METHODS[objectName];
      if (staticMethods?.has(methodName)) {
        return true;
      }
    }

    // Zustand pattern: getState()
    if (methodName === 'getState') {
      return true;
    }
  }

  return false;
}

/**
 * Check if a node is inside a callback (arrow function or function expression)
 */
export function isInsideCallback(node: TSESTree.Node, ancestors: TSESTree.Node[]): boolean {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const ancestor = ancestors[i];

    if (ancestor.type === 'ArrowFunctionExpression' || ancestor.type === 'FunctionExpression') {
      // Check if this is NOT the component function itself
      const parent = ancestors[i - 1];
      if (parent?.type === 'VariableDeclarator') {
        const id = parent.id;
        if (id.type === 'Identifier' && isComponentName(id.name)) {
          // This is the component function, not a callback
          return false;
        }
      }
      return true;
    }

    if (ancestor.type === 'FunctionDeclaration') {
      // Check if this is the component function
      if (ancestor.id && isComponentName(ancestor.id.name)) {
        return false;
      }
      return true;
    }
  }
  return false;
}

/**
 * Find ancestors of a node (ESLint provides this via context.getAncestors())
 */
export function findAncestors(
  node: TSESTree.Node,
  sourceCode: { getAncestors: (node: TSESTree.Node) => TSESTree.Node[] }
): TSESTree.Node[] {
  return sourceCode.getAncestors(node);
}

/**
 * Check if a node is inside an effect hook callback
 */
export function isInsideEffectCallback(ancestors: TSESTree.Node[]): boolean {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const ancestor = ancestors[i];

    if (
      ancestor.type === 'CallExpression' &&
      ancestor.callee.type === 'Identifier' &&
      EFFECT_HOOKS.has(ancestor.callee.name)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Extract useState/useReducer state info from a component
 */
export interface StateInfo {
  /** State variable name -> setter name */
  stateVars: Map<string, string>;
  /** Setter name -> state variable name */
  setterVars: Map<string, string>;
}

/**
 * Check if a node is an object literal
 */
export function isObjectLiteral(node: TSESTree.Node): boolean {
  return node.type === 'ObjectExpression';
}

/**
 * Check if a node is an array literal
 */
export function isArrayLiteral(node: TSESTree.Node): boolean {
  return node.type === 'ArrayExpression';
}

/**
 * Check if a node is a function expression (arrow or regular)
 */
export function isFunctionExpression(node: TSESTree.Node): boolean {
  return node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression';
}
