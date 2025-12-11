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
import { isSetterName, STATE_HOOKS, findSetterCallsInBody, isNodeRldIgnored } from '../utils';

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
     * Check if a name is a setter (either tracked or matches pattern)
     */
    function isSetter(name: string): boolean {
      return stateSetters.has(name) || isSetterName(name);
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

      // Check for rld-ignore comments
      if (isNodeRldIgnored(context.sourceCode, node)) {
        return;
      }

      // Find setState calls
      const setterCalls = findSetterCallsInBody(callback.body, isSetter);

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
