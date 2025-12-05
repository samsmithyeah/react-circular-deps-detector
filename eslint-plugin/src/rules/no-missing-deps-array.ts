/**
 * Rule: no-missing-deps-array
 *
 * Detects useEffect calls without a dependency array that contain setState.
 * This is a guaranteed infinite loop pattern.
 *
 * Error Code: RLD-500
 *
 * @example
 * // Bad - no dependency array with setState
 * useEffect(() => {
 *   setCount(count + 1);
 * }); // Missing deps array = runs every render = infinite loop!
 *
 * // Good - with dependency array
 * useEffect(() => {
 *   setCount(count + 1);
 * }, [count]); // Still a loop, but explicit
 *
 * // Good - empty deps array
 * useEffect(() => {
 *   setCount(1);
 * }, []); // Only runs once
 */

import { ESLintUtils, TSESTree } from '@typescript-eslint/utils';
import { isSetterName, STATE_HOOKS } from '../utils';

const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/samsmithyeah/react-circular-deps-detector/blob/main/eslint-plugin/docs/rules/${name}.md`
);

type MessageIds = 'missingDepsArray' | 'missingDepsArrayWithSetState';

export interface Options {
  /** Only report if setState is called (default: true) */
  onlyWithSetState?: boolean;
}

export default createRule<[Options], MessageIds>({
  name: 'no-missing-deps-array',
  meta: {
    type: 'problem',
    docs: {
      description: 'Require dependency array in useEffect when setState is used',
    },
    messages: {
      missingDepsArray:
        'useEffect without dependency array runs on every render. Add a dependency array.',
      missingDepsArrayWithSetState:
        "useEffect without dependency array calls '{{setter}}()'. This causes an infinite loop. Add a dependency array.",
    },
    schema: [
      {
        type: 'object',
        properties: {
          onlyWithSetState: {
            type: 'boolean',
          },
        },
        additionalProperties: false,
      },
    ],
  },
  defaultOptions: [{ onlyWithSetState: true }],
  create(context, [options]) {
    const stateSetters = new Set<string>();

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

      const setterVar = elements[1];
      if (setterVar?.type === 'Identifier') {
        stateSetters.add(setterVar.name);
      }
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
     * Find setter calls in a function body
     */
    function findSetterCalls(body: TSESTree.Node): string[] {
      const setters: string[] = [];
      const visited = new WeakSet<TSESTree.Node>();

      function visit(node: TSESTree.Node) {
        if (visited.has(node)) return;
        visited.add(node);

        if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
          const name = node.callee.name;
          if (stateSetters.has(name) || isSetterName(name)) {
            setters.push(name);
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
      return setters;
    }

    /**
     * Analyze useEffect calls for missing deps
     */
    function analyzeUseEffect(node: TSESTree.CallExpression) {
      if (node.callee.type !== 'Identifier') return;
      if (node.callee.name !== 'useEffect' && node.callee.name !== 'useLayoutEffect') {
        return;
      }

      // Check if there's a dependency array (second argument)
      if (node.arguments.length >= 2) {
        // Has deps array, skip
        return;
      }

      // No dependency array
      if (node.arguments.length === 0) return;

      const callback = node.arguments[0];
      if (callback.type !== 'ArrowFunctionExpression' && callback.type !== 'FunctionExpression') {
        return;
      }

      // Find setState calls
      const setterCalls = findSetterCalls(callback.body);

      if (setterCalls.length > 0) {
        // Has setState calls - this is a guaranteed infinite loop
        context.report({
          node,
          messageId: 'missingDepsArrayWithSetState',
          data: { setter: setterCalls[0] },
        });
      } else if (!options.onlyWithSetState) {
        // No setState but still missing deps
        context.report({
          node,
          messageId: 'missingDepsArray',
        });
      }
    }

    return {
      CallExpression(node) {
        trackStateHook(node);
        analyzeUseEffect(node);
      },
    };
  },
});
