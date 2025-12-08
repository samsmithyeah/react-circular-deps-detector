/**
 * Rule: no-effect-loop
 *
 * Detects useEffect patterns that cause infinite loops by modifying
 * state that the effect depends on.
 *
 * Error Codes: RLD-200, RLD-202
 *
 * @example
 * // Bad - modifies dependency
 * useEffect(() => {
 *   setCount(count + 1);
 * }, [count]);
 *
 * // Good - functional update
 * useEffect(() => {
 *   setCount(c => c + 1);
 * }, []);
 *
 * // Good - guarded update
 * useEffect(() => {
 *   if (shouldUpdate) {
 *     setCount(count + 1);
 *   }
 * }, [count, shouldUpdate]);
 */

import { ESLintUtils, TSESTree } from '@typescript-eslint/utils';
import {
  isSetterName,
  getStateNameFromSetter,
  STATE_HOOKS,
  EFFECT_HOOKS,
  findSetterCallsWithInfo,
} from '../utils';

const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/samsmithyeah/react-circular-deps-detector/blob/main/eslint-plugin/docs/rules/${name}.md`
);

type MessageIds = 'effectLoop' | 'effectLoopLayout';

export interface Options {
  /** Whether to allow functional updates (setCount(c => c + 1)) */
  allowFunctionalUpdates?: boolean;
  /** Whether to detect guarded updates as safe */
  detectGuards?: boolean;
}

export default createRule<[Options], MessageIds>({
  name: 'no-effect-loop',
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow useEffect patterns that cause infinite loops',
    },
    messages: {
      effectLoop:
        "useEffect modifies '{{state}}' via '{{setter}}()' while depending on it. This causes an infinite loop.",
      effectLoopLayout:
        "useLayoutEffect modifies '{{state}}' via '{{setter}}()' while depending on it. This causes an infinite loop.",
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowFunctionalUpdates: {
            type: 'boolean',
          },
          detectGuards: {
            type: 'boolean',
          },
        },
        additionalProperties: false,
      },
    ],
  },
  defaultOptions: [{ allowFunctionalUpdates: true, detectGuards: true }],
  create(context, [options]) {
    const stateSetters = new Map<string, string>(); // setter -> state variable

    /**
     * Track useState/useReducer calls to identify setters
     */
    function trackStateHook(node: TSESTree.CallExpression) {
      if (node.callee.type !== 'Identifier' || !STATE_HOOKS.has(node.callee.name)) {
        return;
      }

      const parent = node.parent;
      if (parent?.type !== 'VariableDeclarator') return;

      const id = parent.id;
      if (id.type !== 'ArrayPattern') return;

      const elements = id.elements;
      if (elements.length < 2) return;

      const stateVar = elements[0];
      const setterVar = elements[1];

      if (stateVar?.type === 'Identifier' && setterVar?.type === 'Identifier') {
        stateSetters.set(setterVar.name, stateVar.name);
      }
    }

    /**
     * Get state variable name from a setter call
     */
    function getStateFromSetter(setterName: string): string | null {
      // First check tracked setters
      const tracked = stateSetters.get(setterName);
      if (tracked) return tracked;

      // Fall back to naming convention
      if (isSetterName(setterName)) {
        return getStateNameFromSetter(setterName);
      }

      return null;
    }

    /**
     * Check if a setter call is a functional update
     */
    function isFunctionalUpdate(node: TSESTree.CallExpression): boolean {
      const args = node.arguments;
      if (args.length === 0) return false;

      const firstArg = args[0];
      return firstArg.type === 'ArrowFunctionExpression' || firstArg.type === 'FunctionExpression';
    }

    /**
     * Check if a setter call is inside an if statement (guarded)
     */
    function isGuarded(node: TSESTree.Node): boolean {
      let current: TSESTree.Node | undefined = node.parent;

      while (current) {
        if (current.type === 'IfStatement' || current.type === 'ConditionalExpression') {
          return true;
        }
        // Stop at function boundaries
        if (
          current.type === 'ArrowFunctionExpression' ||
          current.type === 'FunctionExpression' ||
          current.type === 'FunctionDeclaration'
        ) {
          break;
        }
        current = current.parent;
      }

      return false;
    }

    /**
     * Extract dependency array identifiers from effect call
     */
    function getDependencies(node: TSESTree.CallExpression): Set<string> {
      const deps = new Set<string>();

      // Effect hooks have deps as second argument
      if (node.arguments.length < 2) return deps;

      const depsArg = node.arguments[1];
      if (depsArg.type !== 'ArrayExpression') return deps;

      for (const element of depsArg.elements) {
        if (element?.type === 'Identifier') {
          deps.add(element.name);
        }
      }

      return deps;
    }

    /**
     * Analyze an effect hook for loop patterns
     */
    function analyzeEffectHook(node: TSESTree.CallExpression) {
      if (node.callee.type !== 'Identifier') return;

      const hookName = node.callee.name;
      if (!EFFECT_HOOKS.has(hookName)) return;

      // Skip useCallback, useMemo - they don't cause loops in the same way
      if (hookName === 'useCallback' || hookName === 'useMemo') return;

      // Get the callback function
      if (node.arguments.length === 0) return;
      const callback = node.arguments[0];
      if (callback.type !== 'ArrowFunctionExpression' && callback.type !== 'FunctionExpression') {
        return;
      }

      // Get dependencies
      const deps = getDependencies(node);
      if (deps.size === 0) return; // No deps = no loop from deps

      // Find setter calls in the callback using the shared utility
      const setterCalls = findSetterCallsWithInfo(callback.body, getStateFromSetter);

      for (const { node: setterNode, setter, state } of setterCalls) {
        // Skip if state is null (shouldn't happen but TypeScript needs it)
        if (state === null) continue;
        // Check if the state variable is in dependencies
        if (!deps.has(state)) continue;

        // Check if it's a functional update (allowed by default)
        if (options.allowFunctionalUpdates && isFunctionalUpdate(setterNode)) {
          continue;
        }

        // Check if it's guarded
        if (options.detectGuards && isGuarded(setterNode)) {
          continue;
        }

        // Report the issue
        const messageId = hookName === 'useLayoutEffect' ? 'effectLoopLayout' : 'effectLoop';

        context.report({
          node: setterNode,
          messageId,
          data: { state, setter },
        });
      }
    }

    return {
      CallExpression(node) {
        trackStateHook(node);
        analyzeEffectHook(node);
      },
    };
  },
});
