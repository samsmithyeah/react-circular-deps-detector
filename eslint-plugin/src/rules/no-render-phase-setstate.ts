/**
 * Rule: no-render-phase-setstate
 *
 * Detects setState calls during render phase (outside hooks, event handlers, callbacks).
 * This is a guaranteed infinite loop pattern.
 *
 * Error Code: RLD-100
 *
 * @example
 * // Bad - setState during render
 * function Component() {
 *   const [count, setCount] = useState(0);
 *   setCount(count + 1); // Infinite loop!
 *   return <div>{count}</div>;
 * }
 *
 * // Good - setState in effect
 * function Component() {
 *   const [count, setCount] = useState(0);
 *   useEffect(() => {
 *     setCount(count + 1);
 *   }, []);
 *   return <div>{count}</div>;
 * }
 */

import { ESLintUtils, TSESTree } from '@typescript-eslint/utils';
import { isComponentName, isSetterName, STATE_HOOKS } from '../utils';

const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/samsmithyeah/react-circular-deps-detector/blob/main/eslint-plugin/docs/rules/${name}.md`
);

type MessageIds = 'renderPhaseSetState' | 'renderPhaseSetStateIndirect';

export interface Options {
  /** Additional functions to treat as setState calls */
  additionalSetters?: string[];
}

export default createRule<[Options], MessageIds>({
  name: 'no-render-phase-setstate',
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow setState calls during render phase',
    },
    messages: {
      renderPhaseSetState:
        "setState call '{{setter}}()' during render causes infinite loop. Move to useEffect, event handler, or callback.",
      renderPhaseSetStateIndirect:
        "Function '{{func}}()' calls setState during render, causing infinite loop. Move to useEffect, event handler, or callback.",
    },
    schema: [
      {
        type: 'object',
        properties: {
          additionalSetters: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        additionalProperties: false,
      },
    ],
  },
  defaultOptions: [{ additionalSetters: [] }],
  create(context, [options]) {
    const setters = new Set<string>(options.additionalSetters || []);
    const stateSetters = new Map<string, string>(); // setter -> state variable
    let componentDepth = 0;
    let safeContextDepth = 0; // Inside hooks, event handlers, etc.

    /**
     * Check if we're inside a safe context (hook callback, event handler, etc.)
     */
    function isInSafeContext(): boolean {
      return safeContextDepth > 0;
    }

    /**
     * Check if we're inside a component
     */
    function isInComponent(): boolean {
      return componentDepth > 0;
    }

    /**
     * Track useState/useReducer calls to identify setters
     */
    function trackStateHook(node: TSESTree.CallExpression) {
      if (node.callee.type !== 'Identifier' || !STATE_HOOKS.has(node.callee.name)) {
        return;
      }

      // Look for array destructuring: const [state, setState] = useState()
      const parent = node.parent;
      if (parent?.type !== 'VariableDeclarator') return;

      const id = parent.id;
      if (id.type !== 'ArrayPattern') return;

      const elements = id.elements;
      if (elements.length < 2) return;

      const stateVar = elements[0];
      const setterVar = elements[1];

      if (stateVar?.type === 'Identifier' && setterVar?.type === 'Identifier') {
        setters.add(setterVar.name);
        stateSetters.set(setterVar.name, stateVar.name);
      }
    }

    /**
     * Check if a function call is a setState call
     */
    function isSetterCall(node: TSESTree.CallExpression): boolean {
      if (node.callee.type === 'Identifier') {
        const name = node.callee.name;
        return setters.has(name) || isSetterName(name);
      }
      return false;
    }

    /**
     * Get the setter name from a call expression
     */
    function getSetterName(node: TSESTree.CallExpression): string | null {
      if (node.callee.type === 'Identifier') {
        return node.callee.name;
      }
      return null;
    }

    return {
      // Track component function boundaries
      FunctionDeclaration(node) {
        if (node.id && isComponentName(node.id.name)) {
          componentDepth++;
        }
      },
      'FunctionDeclaration:exit'(node: TSESTree.FunctionDeclaration) {
        if (node.id && isComponentName(node.id.name)) {
          componentDepth--;
        }
      },

      // Track arrow function components
      'VariableDeclarator > ArrowFunctionExpression'(node: TSESTree.ArrowFunctionExpression) {
        const parent = node.parent as TSESTree.VariableDeclarator;
        if (parent.id.type === 'Identifier' && isComponentName(parent.id.name)) {
          componentDepth++;
        }
      },
      'VariableDeclarator > ArrowFunctionExpression:exit'(node: TSESTree.ArrowFunctionExpression) {
        const parent = node.parent as TSESTree.VariableDeclarator;
        if (parent.id.type === 'Identifier' && isComponentName(parent.id.name)) {
          componentDepth--;
        }
      },

      // Track function expression components
      'VariableDeclarator > FunctionExpression'(node: TSESTree.FunctionExpression) {
        const parent = node.parent as TSESTree.VariableDeclarator;
        if (parent.id.type === 'Identifier' && isComponentName(parent.id.name)) {
          componentDepth++;
        }
      },
      'VariableDeclarator > FunctionExpression:exit'(node: TSESTree.FunctionExpression) {
        const parent = node.parent as TSESTree.VariableDeclarator;
        if (parent.id.type === 'Identifier' && isComponentName(parent.id.name)) {
          componentDepth--;
        }
      },

      // Track safe contexts (nested functions, callbacks)
      ArrowFunctionExpression(node) {
        // If we're already in a component, entering an arrow function is a safe context
        if (isInComponent()) {
          const parent = node.parent;
          // Skip if this is the component definition itself
          if (
            parent?.type === 'VariableDeclarator' &&
            parent.id.type === 'Identifier' &&
            isComponentName(parent.id.name)
          ) {
            return;
          }
          safeContextDepth++;
        }
      },
      'ArrowFunctionExpression:exit'(node: TSESTree.ArrowFunctionExpression) {
        if (isInComponent()) {
          const parent = node.parent;
          if (
            parent?.type === 'VariableDeclarator' &&
            parent.id.type === 'Identifier' &&
            isComponentName(parent.id.name)
          ) {
            return;
          }
          safeContextDepth--;
        }
      },

      FunctionExpression(node) {
        if (isInComponent()) {
          const parent = node.parent;
          if (
            parent?.type === 'VariableDeclarator' &&
            parent.id.type === 'Identifier' &&
            isComponentName(parent.id.name)
          ) {
            return;
          }
          safeContextDepth++;
        }
      },
      'FunctionExpression:exit'(node: TSESTree.FunctionExpression) {
        if (isInComponent()) {
          const parent = node.parent;
          if (
            parent?.type === 'VariableDeclarator' &&
            parent.id.type === 'Identifier' &&
            isComponentName(parent.id.name)
          ) {
            return;
          }
          safeContextDepth--;
        }
      },

      // Track state hooks
      CallExpression(node) {
        trackStateHook(node);

        // Check for setState calls during render
        if (!isInComponent() || isInSafeContext()) {
          return;
        }

        if (isSetterCall(node)) {
          const setter = getSetterName(node);
          if (setter) {
            context.report({
              node,
              messageId: 'renderPhaseSetState',
              data: { setter },
            });
          }
        }
      },
    };
  },
});
