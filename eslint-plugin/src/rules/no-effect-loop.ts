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
import { isSetterName, getStateNameFromSetter, STATE_HOOKS, EFFECT_HOOKS } from '../utils';

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
     * Check if a value is an AST node
     */
    function isAstNode(value: unknown): value is TSESTree.Node {
      return (
        value !== null &&
        typeof value === 'object' &&
        'type' in value &&
        typeof (value as { type: unknown }).type === 'string'
      );
    }

    /**
     * Find all setter calls in a function body
     */
    function findSetterCalls(
      body: TSESTree.Node
    ): Array<{ node: TSESTree.CallExpression; setter: string; state: string }> {
      const calls: Array<{
        node: TSESTree.CallExpression;
        setter: string;
        state: string;
      }> = [];
      const visited = new WeakSet<TSESTree.Node>();

      function visit(node: TSESTree.Node) {
        if (visited.has(node)) return;
        visited.add(node);

        if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
          const setterName = node.callee.name;
          const state = getStateFromSetter(setterName);

          if (state) {
            calls.push({ node, setter: setterName, state });
          }
        }

        // Recursively visit children (skip 'parent' and 'loc' to avoid non-node objects)
        for (const key of Object.keys(node)) {
          if (key === 'parent' || key === 'loc' || key === 'range') continue;
          const value = (node as unknown as Record<string, unknown>)[key];
          if (value && typeof value === 'object') {
            if (Array.isArray(value)) {
              for (const item of value) {
                if (isAstNode(item)) {
                  visit(item);
                }
              }
            } else if (isAstNode(value)) {
              visit(value);
            }
          }
        }
      }

      visit(body);
      return calls;
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

      // Find setter calls in the callback
      const setterCalls = findSetterCalls(callback.body);

      for (const { node: setterNode, setter, state } of setterCalls) {
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
