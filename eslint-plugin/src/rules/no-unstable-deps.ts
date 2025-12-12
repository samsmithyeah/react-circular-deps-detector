/**
 * Rule: no-unstable-deps
 *
 * Detects unstable references (objects, arrays, functions) in hook dependency arrays.
 * These cause unnecessary re-renders on every render.
 *
 * Error Codes: RLD-400, RLD-401, RLD-402, RLD-403
 *
 * @example
 * // Bad - inline object
 * useEffect(() => {
 *   console.log(config);
 * }, [{ key: 'value' }]);
 *
 * // Bad - inline array
 * useEffect(() => {
 *   console.log(items);
 * }, [[1, 2, 3]]);
 *
 * // Bad - inline function
 * useCallback(() => {
 *   handleClick();
 * }, [() => {}]);
 *
 * // Good - stable reference
 * const config = useMemo(() => ({ key: 'value' }), []);
 * useEffect(() => {
 *   console.log(config);
 * }, [config]);
 */

import { ESLintUtils, TSESTree } from '@typescript-eslint/utils';
import { EFFECT_HOOKS, isStableFunctionCall, isNodeRldIgnored } from '../utils';

const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/samsmithyeah/react-loop-detector/blob/main/eslint-plugin/docs/rules/${name}.md`
);

type MessageIds = 'unstableObject' | 'unstableArray' | 'unstableFunction' | 'unstableFunctionCall';

export interface Options {
  /** Functions that return stable values */
  stableFunctions?: string[];
}

export default createRule<[Options], MessageIds>({
  name: 'no-unstable-deps',
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow unstable references in hook dependency arrays',
    },
    messages: {
      unstableObject:
        'Object literal in dependency array creates new reference every render. Use useMemo or move outside component.',
      unstableArray:
        'Array literal in dependency array creates new reference every render. Use useMemo or move outside component.',
      unstableFunction:
        'Function in dependency array creates new reference every render. Use useCallback or move outside component.',
      unstableFunctionCall:
        "Function call '{{func}}()' in dependency array may create new reference every render. Consider using useMemo.",
    },
    schema: [
      {
        type: 'object',
        properties: {
          stableFunctions: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        additionalProperties: false,
      },
    ],
  },
  defaultOptions: [{ stableFunctions: [] }],
  create(context, [options]) {
    const stableFunctions = new Set(options.stableFunctions || []);

    /**
     * Check if a function call is considered stable
     */
    function isStableCall(node: TSESTree.CallExpression): boolean {
      // Check user-configured stable functions
      if (node.callee.type === 'Identifier' && stableFunctions.has(node.callee.name)) {
        return true;
      }

      // Check built-in stable functions
      return isStableFunctionCall(node);
    }

    /**
     * Analyze a dependency array for unstable references
     */
    function analyzeDepsArray(node: TSESTree.ArrayExpression) {
      for (const element of node.elements) {
        if (!element) continue;

        // Check for rld-ignore comments
        if (isNodeRldIgnored(context.sourceCode, element)) {
          continue;
        }

        // Inline object literal
        if (element.type === 'ObjectExpression') {
          context.report({
            node: element,
            messageId: 'unstableObject',
          });
          continue;
        }

        // Inline array literal
        if (element.type === 'ArrayExpression') {
          context.report({
            node: element,
            messageId: 'unstableArray',
          });
          continue;
        }

        // Inline function
        if (element.type === 'ArrowFunctionExpression' || element.type === 'FunctionExpression') {
          context.report({
            node: element,
            messageId: 'unstableFunction',
          });
          continue;
        }

        // Function call in deps
        if (element.type === 'CallExpression') {
          if (!isStableCall(element)) {
            const funcName =
              element.callee.type === 'Identifier'
                ? element.callee.name
                : element.callee.type === 'MemberExpression' &&
                    element.callee.property.type === 'Identifier'
                  ? element.callee.property.name
                  : 'unknown';

            context.report({
              node: element,
              messageId: 'unstableFunctionCall',
              data: { func: funcName },
            });
          }
        }
      }
    }

    /**
     * Check if a call expression is a hook with dependencies
     * Returns the hook name if it is, null otherwise
     */
    function isHookWithDeps(node: TSESTree.CallExpression): string | null {
      if (node.callee.type !== 'Identifier') return null;
      const name = node.callee.name;
      return EFFECT_HOOKS.has(name) ? name : null;
    }

    return {
      CallExpression(node) {
        const hookName = isHookWithDeps(node);
        if (!hookName) return;

        let depsArg: TSESTree.Expression | TSESTree.SpreadElement | undefined;

        // useImperativeHandle has deps as 3rd argument, others have it as 2nd
        if (hookName === 'useImperativeHandle') {
          if (node.arguments.length < 3) return;
          depsArg = node.arguments[2];
        } else {
          if (node.arguments.length < 2) return;
          depsArg = node.arguments[1];
        }

        if (!depsArg || depsArg.type !== 'ArrayExpression') return;

        analyzeDepsArray(depsArg);
      },
    };
  },
});
