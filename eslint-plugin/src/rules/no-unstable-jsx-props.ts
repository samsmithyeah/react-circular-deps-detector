/**
 * Rule: no-unstable-jsx-props
 *
 * Detects unstable values (objects, arrays, functions) passed as props to JSX elements.
 * When a component receives a new reference on every render, it may cause:
 * - React.memo to be ineffective
 * - useEffect in the child to run on every render if the prop is in dependencies
 *
 * This is the ESLint equivalent of RLD-405 from the CLI tool.
 *
 * @example
 * // Bad - new object created every render
 * function Parent() {
 *   return <Child config={{ page: 1 }} />;
 * }
 *
 * // Bad - new function created every render
 * function Parent() {
 *   return <Child onClick={() => console.log('clicked')} />;
 * }
 *
 * // Good - memoized values
 * function Parent() {
 *   const config = useMemo(() => ({ page: 1 }), []);
 *   const onClick = useCallback(() => console.log('clicked'), []);
 *   return <Child config={config} onClick={onClick} />;
 * }
 */

import { ESLintUtils, TSESTree } from '@typescript-eslint/utils';
import { isStableFunctionCall, isComponentName, isNodeRldIgnored } from '../utils';

const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/samsmithyeah/react-loop-detector/blob/main/eslint-plugin/docs/rules/${name}.md`
);

type MessageIds =
  | 'unstableObjectProp'
  | 'unstableArrayProp'
  | 'unstableFunctionProp'
  | 'unstableFunctionCallProp'
  | 'unstableVariableProp';

interface UnstableVariable {
  name: string;
  type: 'object' | 'array' | 'function' | 'function-call';
}

type Options = [
  {
    /** Only check props passed to PascalCase components (default: true) */
    onlyComponents?: boolean;
    /** Check callback/handler props like onClick (default: false to reduce noise) */
    checkCallbacks?: boolean;
    /** Prop names to ignore (default: ['key', 'ref', 'children']) */
    ignoredProps?: string[];
  },
];

const defaultOptions: Options[0] = {
  onlyComponents: true,
  checkCallbacks: false,
  ignoredProps: ['key', 'ref', 'children'],
};

export default createRule<Options, MessageIds>({
  name: 'no-unstable-jsx-props',
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow unstable values as JSX props that may cause unnecessary re-renders',
    },
    messages: {
      unstableObjectProp:
        "Prop '{{propName}}' receives a new object on every render. If '{{elementName}}' is memoized or uses this in a hook dependency array, this causes unnecessary re-renders. Consider using useMemo.",
      unstableArrayProp:
        "Prop '{{propName}}' receives a new array on every render. If '{{elementName}}' is memoized or uses this in a hook dependency array, this causes unnecessary re-renders. Consider using useMemo.",
      unstableFunctionProp:
        "Prop '{{propName}}' receives a new function on every render. If '{{elementName}}' is memoized or uses this in a hook dependency array, this causes unnecessary re-renders. Consider using useCallback.",
      unstableFunctionCallProp:
        "Prop '{{propName}}' receives the result of a function call that may create a new object on every render. Consider using useMemo.",
      unstableVariableProp:
        "Prop '{{propName}}' receives '{{varName}}', an unstable {{type}} created inside the component. If '{{elementName}}' is memoized or uses this in a hook dependency array, this causes unnecessary re-renders.",
    },
    schema: [
      {
        type: 'object',
        properties: {
          onlyComponents: {
            type: 'boolean',
            description: 'Only check props passed to PascalCase components',
          },
          checkCallbacks: {
            type: 'boolean',
            description: 'Check callback/handler props like onClick',
          },
          ignoredProps: {
            type: 'array',
            items: { type: 'string' },
            description: 'Prop names to ignore',
          },
        },
        additionalProperties: false,
      },
    ],
  },
  defaultOptions: [defaultOptions],
  create(context, [options]) {
    const { onlyComponents, checkCallbacks, ignoredProps } = {
      ...defaultOptions,
      ...options,
    };

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
     * Check if a prop name is a callback (onClick, onSubmit, etc.)
     */
    function isCallbackProp(propName: string): boolean {
      return /^on[A-Z]/.test(propName);
    }

    /**
     * Track variable declarations for stability
     */
    function analyzeVariableDeclaration(declarator: TSESTree.VariableDeclarator) {
      if (declarator.id.type !== 'Identifier') return;

      const varName = declarator.id.name;
      const init = declarator.init;

      if (!init) return;

      // Stable: useState, useReducer, useRef, useMemo, useCallback
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
     * Get the element name from a JSX opening element
     */
    function getElementName(node: TSESTree.JSXOpeningElement): string | null {
      const name = node.name;

      if (name.type === 'JSXIdentifier') {
        return name.name;
      }

      if (name.type === 'JSXMemberExpression') {
        // Build the full name: Foo.Bar.Baz
        const parts: string[] = [];
        let current: TSESTree.JSXTagNameExpression = name;
        while (current.type === 'JSXMemberExpression') {
          parts.unshift(current.property.name);
          current = current.object;
        }
        if (current.type === 'JSXIdentifier') {
          parts.unshift(current.name);
        }
        return parts.join('.');
      }

      // JSXNamespacedName (e.g., <svg:rect>) - not typically a component
      return null;
    }

    /**
     * Check if we should analyze this element
     */
    function shouldAnalyzeElement(elementName: string | null): boolean {
      if (!elementName) return false;

      // Skip Context.Provider - handled by no-unstable-context-value
      if (elementName.endsWith('.Provider')) return false;

      // If onlyComponents is true, only check PascalCase names
      if (onlyComponents) {
        // Get the first part of the name (before any dots)
        const firstName = elementName.split('.')[0];
        return isComponentName(firstName);
      }

      return true;
    }

    /**
     * Analyze a JSX attribute for unstable values
     */
    function analyzeAttribute(attr: TSESTree.JSXAttribute, elementName: string) {
      // Get prop name
      if (attr.name.type !== 'JSXIdentifier') return;
      const propName = attr.name.name;

      // Skip ignored props
      if (ignoredProps?.includes(propName)) return;

      // Skip callbacks unless checkCallbacks is enabled
      if (!checkCallbacks && isCallbackProp(propName)) return;

      const value = attr.value;

      // Must be an expression container: prop={...}
      if (!value || value.type !== 'JSXExpressionContainer') return;

      const expression = value.expression;

      // Skip empty expressions
      if (expression.type === 'JSXEmptyExpression') return;

      // Check for rld-ignore comments
      if (isNodeRldIgnored(context.sourceCode, expression)) return;

      // Inline object literal: prop={{ foo: 'bar' }}
      if (expression.type === 'ObjectExpression') {
        context.report({
          node: expression,
          messageId: 'unstableObjectProp',
          data: { propName, elementName },
        });
        return;
      }

      // Inline array literal: prop={[1, 2, 3]}
      if (expression.type === 'ArrayExpression') {
        context.report({
          node: expression,
          messageId: 'unstableArrayProp',
          data: { propName, elementName },
        });
        return;
      }

      // Inline function: prop={() => {}}
      if (
        expression.type === 'ArrowFunctionExpression' ||
        expression.type === 'FunctionExpression'
      ) {
        context.report({
          node: expression,
          messageId: 'unstableFunctionProp',
          data: { propName, elementName },
        });
        return;
      }

      // Function call result: prop={createValue()}
      if (expression.type === 'CallExpression') {
        if (!isStableFunctionCall(expression)) {
          context.report({
            node: expression,
            messageId: 'unstableFunctionCallProp',
            data: { propName, elementName },
          });
        }
        return;
      }

      // Variable reference: prop={someVar}
      if (expression.type === 'Identifier') {
        const varName = expression.name;

        // Skip stable variables
        if (stableVariables.has(varName)) return;

        // Check if it's an unstable variable
        const unstable = findUnstableVariable(varName);
        if (unstable) {
          context.report({
            node: expression,
            messageId: 'unstableVariableProp',
            data: { propName, varName, type: unstable.type, elementName },
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

      // Check JSX props
      JSXOpeningElement(node) {
        const elementName = getElementName(node);

        if (!shouldAnalyzeElement(elementName)) return;

        for (const attr of node.attributes) {
          if (attr.type === 'JSXAttribute') {
            analyzeAttribute(attr, elementName!);
          }
        }
      },
    };
  },
});
