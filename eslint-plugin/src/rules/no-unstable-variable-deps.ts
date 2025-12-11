/**
 * Rule: no-unstable-variable-deps
 *
 * Detects variables with unstable references (objects, arrays, functions created inside
 * the component) used in hook dependency arrays. Unlike no-unstable-deps which only
 * catches inline literals, this rule tracks variable declarations.
 *
 * This is the ESLint equivalent of RLD-400/401/402/403 from the CLI tool.
 *
 * @example
 * // Bad - object created in component used as dependency
 * function Component() {
 *   const config = { key: 'value' }; // New object every render
 *   useEffect(() => {
 *     console.log(config);
 *   }, [config]); // Triggers on every render!
 * }
 *
 * // Good - memoized object
 * function Component() {
 *   const config = useMemo(() => ({ key: 'value' }), []);
 *   useEffect(() => {
 *     console.log(config);
 *   }, [config]); // Stable reference
 * }
 */

import { ESLintUtils, TSESTree } from '@typescript-eslint/utils';
import { EFFECT_HOOKS, isStableFunctionCall, isNodeRldIgnored } from '../utils';

const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/samsmithyeah/react-circular-deps-detector/blob/main/eslint-plugin/docs/rules/${name}.md`
);

type MessageIds =
  | 'unstableObjectVariable'
  | 'unstableArrayVariable'
  | 'unstableFunctionVariable'
  | 'unstableFunctionCallVariable';

interface UnstableVariable {
  name: string;
  type: 'object' | 'array' | 'function' | 'function-call';
  node: TSESTree.Node;
}

export default createRule<[], MessageIds>({
  name: 'no-unstable-variable-deps',
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow variables with unstable references in hook dependency arrays',
    },
    messages: {
      unstableObjectVariable:
        "'{{name}}' is an object created inside the component. It gets a new reference on every render, causing this hook to run on every render. Wrap with useMemo, move outside the component, or remove from dependencies.",
      unstableArrayVariable:
        "'{{name}}' is an array created inside the component. It gets a new reference on every render, causing this hook to run on every render. Wrap with useMemo, move outside the component, or remove from dependencies.",
      unstableFunctionVariable:
        "'{{name}}' is a function created inside the component. It gets a new reference on every render, causing this hook to run on every render. Wrap with useCallback, move outside the component, or remove from dependencies.",
      unstableFunctionCallVariable:
        "'{{name}}' is the result of a function call inside the component. It may get a new reference on every render, causing this hook to run on every render. Consider wrapping with useMemo.",
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    // Track unstable variables within each function scope
    const scopeStack: Map<string, UnstableVariable>[] = [];
    // Track state variables (which are stable)
    const stateVariables = new Set<string>();
    // Track ref variables (which are stable)
    const refVariables = new Set<string>();
    // Track memoized variables (useMemo/useCallback results)
    const memoizedVariables = new Set<string>();

    function currentScope(): Map<string, UnstableVariable> {
      return scopeStack[scopeStack.length - 1] || new Map();
    }

    function enterScope() {
      scopeStack.push(new Map());
    }

    function exitScope() {
      scopeStack.pop();
    }

    /**
     * Check if a variable declaration creates an unstable reference
     */
    function analyzeVariableDeclaration(declarator: TSESTree.VariableDeclarator) {
      if (declarator.id.type !== 'Identifier') return;

      const varName = declarator.id.name;
      const init = declarator.init;

      if (!init) return;

      // Check for useState - both values are stable
      if (
        init.type === 'CallExpression' &&
        init.callee.type === 'Identifier' &&
        init.callee.name === 'useState'
      ) {
        // Handle array destructuring: const [foo, setFoo] = useState()
        if (declarator.id.type === 'Identifier') {
          stateVariables.add(varName);
        }
        return;
      }

      // Check for useRef - stable reference
      if (
        init.type === 'CallExpression' &&
        init.callee.type === 'Identifier' &&
        init.callee.name === 'useRef'
      ) {
        refVariables.add(varName);
        return;
      }

      // Check for useMemo/useCallback - stable reference
      if (
        init.type === 'CallExpression' &&
        init.callee.type === 'Identifier' &&
        (init.callee.name === 'useMemo' || init.callee.name === 'useCallback')
      ) {
        memoizedVariables.add(varName);
        return;
      }

      // Object literal - unstable
      if (init.type === 'ObjectExpression') {
        currentScope().set(varName, {
          name: varName,
          type: 'object',
          node: init,
        });
        return;
      }

      // Array literal - unstable
      if (init.type === 'ArrayExpression') {
        currentScope().set(varName, {
          name: varName,
          type: 'array',
          node: init,
        });
        return;
      }

      // Function expression - unstable
      if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
        currentScope().set(varName, {
          name: varName,
          type: 'function',
          node: init,
        });
        return;
      }

      // Function call - potentially unstable (unless it's a stable call)
      if (init.type === 'CallExpression') {
        if (!isStableFunctionCall(init)) {
          currentScope().set(varName, {
            name: varName,
            type: 'function-call',
            node: init,
          });
        }
        return;
      }
    }

    /**
     * Handle array destructuring from useState
     */
    function handleArrayPattern(pattern: TSESTree.ArrayPattern, init: TSESTree.Expression | null) {
      if (!init) return;

      // Check if this is useState
      if (
        init.type === 'CallExpression' &&
        init.callee.type === 'Identifier' &&
        init.callee.name === 'useState'
      ) {
        // Both the state value and setter are stable
        for (const element of pattern.elements) {
          if (element && element.type === 'Identifier') {
            stateVariables.add(element.name);
          }
        }
      }
    }

    /**
     * Check dependency array for unstable variable references
     */
    function analyzeDepsArray(depsArray: TSESTree.ArrayExpression) {
      for (const element of depsArray.elements) {
        if (!element || element.type !== 'Identifier') continue;

        const varName = element.name;

        // Skip state variables - they're stable
        if (stateVariables.has(varName)) continue;

        // Skip ref variables - they're stable
        if (refVariables.has(varName)) continue;

        // Skip memoized variables - they're stable
        if (memoizedVariables.has(varName)) continue;

        // Check for rld-ignore comments
        if (isNodeRldIgnored(context.sourceCode, element)) continue;

        // Check all scopes for unstable variables
        for (let i = scopeStack.length - 1; i >= 0; i--) {
          const unstable = scopeStack[i].get(varName);
          if (unstable) {
            const messageIdMap: Record<UnstableVariable['type'], MessageIds> = {
              object: 'unstableObjectVariable',
              array: 'unstableArrayVariable',
              function: 'unstableFunctionVariable',
              'function-call': 'unstableFunctionCallVariable',
            };

            context.report({
              node: element,
              messageId: messageIdMap[unstable.type],
              data: { name: varName },
            });
            break;
          }
        }
      }
    }

    /**
     * Check if a call expression is a hook with dependencies
     */
    function isHookWithDeps(node: TSESTree.CallExpression): string | null {
      if (node.callee.type !== 'Identifier') return null;
      const name = node.callee.name;
      return EFFECT_HOOKS.has(name) ? name : null;
    }

    return {
      // Track function scopes (component functions)
      FunctionDeclaration() {
        enterScope();
      },
      'FunctionDeclaration:exit'() {
        exitScope();
      },
      FunctionExpression() {
        enterScope();
      },
      'FunctionExpression:exit'() {
        exitScope();
      },
      ArrowFunctionExpression() {
        enterScope();
      },
      'ArrowFunctionExpression:exit'() {
        exitScope();
      },

      // Track variable declarations
      VariableDeclarator(node) {
        // Handle array destructuring (e.g., const [state, setState] = useState())
        if (node.id.type === 'ArrayPattern') {
          handleArrayPattern(node.id, node.init);
          return;
        }

        analyzeVariableDeclaration(node);
      },

      // Check hook calls for unstable deps
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
