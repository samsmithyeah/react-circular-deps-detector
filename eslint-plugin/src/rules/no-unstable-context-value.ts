/**
 * Rule: no-unstable-context-value
 *
 * Detects unstable values passed to Context.Provider's `value` prop.
 * When a Context.Provider receives a new object reference on every render,
 * all consumers of that context will re-render unnecessarily.
 *
 * This is the ESLint equivalent of RLD-404 from the CLI tool.
 *
 * @example
 * // Bad - new object created every render
 * function App() {
 *   const [user, setUser] = useState(null);
 *   return (
 *     <UserContext.Provider value={{ user, setUser }}>
 *       <Child />
 *     </UserContext.Provider>
 *   );
 * }
 *
 * // Good - memoized value
 * function App() {
 *   const [user, setUser] = useState(null);
 *   const value = useMemo(() => ({ user, setUser }), [user]);
 *   return (
 *     <UserContext.Provider value={value}>
 *       <Child />
 *     </UserContext.Provider>
 *   );
 * }
 */

import { ESLintUtils, TSESTree } from '@typescript-eslint/utils';
import { isStableFunctionCall, isNodeRldIgnored } from '../utils';

const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/samsmithyeah/react-circular-deps-detector/blob/main/eslint-plugin/docs/rules/${name}.md`
);

type MessageIds =
  | 'unstableObjectValue'
  | 'unstableArrayValue'
  | 'unstableFunctionValue'
  | 'unstableFunctionCallValue'
  | 'unstableVariableValue';

interface UnstableVariable {
  name: string;
  type: 'object' | 'array' | 'function' | 'function-call';
}

export default createRule<[], MessageIds>({
  name: 'no-unstable-context-value',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow unstable values in Context.Provider value prop that cause unnecessary re-renders',
    },
    messages: {
      unstableObjectValue:
        'Context.Provider receives a new object on every render. This causes all consumers to re-render unnecessarily. Wrap the value with useMemo.',
      unstableArrayValue:
        'Context.Provider receives a new array on every render. This causes all consumers to re-render unnecessarily. Wrap the value with useMemo.',
      unstableFunctionValue:
        'Context.Provider receives a new function on every render. This causes all consumers to re-render unnecessarily. Wrap the value with useCallback or useMemo.',
      unstableFunctionCallValue:
        'Context.Provider receives the result of a function call that may create a new object on every render. Consider wrapping with useMemo.',
      unstableVariableValue:
        "'{{name}}' is an unstable {{type}} created inside the component. Passing it to Context.Provider causes all consumers to re-render. Wrap with useMemo/useCallback.",
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    // Track unstable variables within each function scope
    const scopeStack: Map<string, UnstableVariable>[] = [];
    // Track stable variables
    const stableVariables = new Set<string>();

    function currentScope(): Map<string, UnstableVariable> {
      return scopeStack[scopeStack.length - 1] || new Map();
    }

    function enterScope() {
      scopeStack.push(new Map());
    }

    function exitScope() {
      scopeStack.pop();
    }

    function findUnstableVariable(name: string): UnstableVariable | null {
      for (let i = scopeStack.length - 1; i >= 0; i--) {
        const unstable = scopeStack[i].get(name);
        if (unstable) return unstable;
      }
      return null;
    }

    /**
     * Track variable declarations for stability
     */
    function analyzeVariableDeclaration(declarator: TSESTree.VariableDeclarator) {
      if (declarator.id.type !== 'Identifier') return;

      const varName = declarator.id.name;
      const init = declarator.init;

      if (!init) return;

      // Stable: useState, useReducer, useRef
      if (
        init.type === 'CallExpression' &&
        init.callee.type === 'Identifier' &&
        ['useState', 'useReducer', 'useRef', 'useMemo', 'useCallback'].includes(init.callee.name)
      ) {
        stableVariables.add(varName);
        return;
      }

      // Object literal - unstable
      if (init.type === 'ObjectExpression') {
        currentScope().set(varName, { name: varName, type: 'object' });
        return;
      }

      // Array literal - unstable
      if (init.type === 'ArrayExpression') {
        currentScope().set(varName, { name: varName, type: 'array' });
        return;
      }

      // Function expression - unstable
      if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
        currentScope().set(varName, { name: varName, type: 'function' });
        return;
      }

      // Function call - potentially unstable
      if (init.type === 'CallExpression') {
        if (!isStableFunctionCall(init)) {
          currentScope().set(varName, { name: varName, type: 'function-call' });
        } else {
          stableVariables.add(varName);
        }
        return;
      }
    }

    /**
     * Handle array destructuring from useState
     */
    function handleArrayPattern(pattern: TSESTree.ArrayPattern, init: TSESTree.Expression | null) {
      if (!init) return;

      if (
        init.type === 'CallExpression' &&
        init.callee.type === 'Identifier' &&
        ['useState', 'useReducer'].includes(init.callee.name)
      ) {
        for (const element of pattern.elements) {
          if (element && element.type === 'Identifier') {
            stableVariables.add(element.name);
          }
        }
      }
    }

    /**
     * Check if a JSX element is a Context.Provider
     */
    function isContextProvider(node: TSESTree.JSXOpeningElement): boolean {
      const name = node.name;

      // Handle MyContext.Provider
      if (name.type === 'JSXMemberExpression') {
        return name.property.type === 'JSXIdentifier' && name.property.name === 'Provider';
      }

      return false;
    }

    /**
     * Analyze the value prop of a Context.Provider
     */
    function analyzeProviderValue(attr: TSESTree.JSXAttribute) {
      const value = attr.value;

      // Must be an expression container: value={...}
      if (!value || value.type !== 'JSXExpressionContainer') return;

      const expression = value.expression;

      // Skip if it's just an empty expression
      if (expression.type === 'JSXEmptyExpression') return;

      // Check for rld-ignore comments
      if (isNodeRldIgnored(context.sourceCode, expression)) return;

      // Inline object literal: value={{ foo: 'bar' }}
      if (expression.type === 'ObjectExpression') {
        context.report({
          node: expression,
          messageId: 'unstableObjectValue',
        });
        return;
      }

      // Inline array literal: value={[1, 2, 3]}
      if (expression.type === 'ArrayExpression') {
        context.report({
          node: expression,
          messageId: 'unstableArrayValue',
        });
        return;
      }

      // Inline function: value={() => {}}
      if (
        expression.type === 'ArrowFunctionExpression' ||
        expression.type === 'FunctionExpression'
      ) {
        context.report({
          node: expression,
          messageId: 'unstableFunctionValue',
        });
        return;
      }

      // Function call result: value={createValue()}
      if (expression.type === 'CallExpression') {
        if (!isStableFunctionCall(expression)) {
          context.report({
            node: expression,
            messageId: 'unstableFunctionCallValue',
          });
        }
        return;
      }

      // Variable reference: value={contextValue}
      if (expression.type === 'Identifier') {
        const varName = expression.name;

        // Skip stable variables
        if (stableVariables.has(varName)) return;

        // Check if it's an unstable variable
        const unstable = findUnstableVariable(varName);
        if (unstable) {
          context.report({
            node: expression,
            messageId: 'unstableVariableValue',
            data: { name: varName, type: unstable.type },
          });
        }
      }
    }

    return {
      // Track function scopes
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
        if (node.id.type === 'ArrayPattern') {
          handleArrayPattern(node.id, node.init);
          return;
        }
        analyzeVariableDeclaration(node);
      },

      // Check Context.Provider value props
      JSXOpeningElement(node) {
        if (!isContextProvider(node)) return;

        // Find the value attribute
        for (const attr of node.attributes) {
          if (
            attr.type === 'JSXAttribute' &&
            attr.name.type === 'JSXIdentifier' &&
            attr.name.name === 'value'
          ) {
            analyzeProviderValue(attr);
          }
        }
      },
    };
  },
});
