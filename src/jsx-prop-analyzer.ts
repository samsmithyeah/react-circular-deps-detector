/**
 * JSX Prop Analyzer Module
 *
 * Detects unstable references being passed as props to JSX elements.
 * This helps catch patterns where:
 * - Unstable objects/arrays are passed to memoized children (breaking memo)
 * - Unstable functions are passed as callbacks (causing unnecessary re-renders)
 * - Context.Provider receives unstable value props
 */

import * as t from '@babel/types';
import traverse, { NodePath } from '@babel/traverse';
import { HookAnalysis } from './types';
import { UnstableVariable } from './state-extractor';
import { createAnalysis } from './utils';

/** Information about a JSX prop with an unstable value */
interface UnstableJsxProp {
  componentName: string;
  propName: string;
  unstableVar: UnstableVariable;
  line: number;
  isContextProvider: boolean;
}

/**
 * Find unstable variables being passed as JSX props.
 * Returns issues for patterns like:
 * - <Component prop={unstableObject} />
 * - <Context.Provider value={unstableObject}>
 */
export function analyzeJsxProps(
  ast: t.Node,
  unstableVars: Map<string, UnstableVariable>,
  filePath: string
): HookAnalysis[] {
  const results: HookAnalysis[] = [];
  const unstableProps: UnstableJsxProp[] = [];

  traverse(ast, {
    JSXAttribute(nodePath: NodePath<t.JSXAttribute>) {
      const propName = t.isJSXIdentifier(nodePath.node.name) ? nodePath.node.name.name : null;
      if (!propName) return;

      // Get the value of the prop
      const value = nodePath.node.value;
      if (!t.isJSXExpressionContainer(value)) return;

      const expression = value.expression;
      if (!t.isIdentifier(expression)) return;

      const varName = expression.name;
      const line = nodePath.node.loc?.start.line || 0;

      // Check if this variable is unstable (using line-based component scoping)
      const unstableVar = findUnstableVarByLine(unstableVars, varName, line);
      if (!unstableVar) return;

      // Get the JSX element name
      const jsxElement = nodePath.findParent((p) =>
        t.isJSXOpeningElement(p.node)
      ) as NodePath<t.JSXOpeningElement> | null;
      if (!jsxElement) return;

      const elementName = getJSXElementName(jsxElement.node);
      if (!elementName) return;

      // Check if this is a Context.Provider
      const isContextProvider = elementName.endsWith('.Provider') || propName === 'value';

      unstableProps.push({
        componentName: elementName,
        propName,
        unstableVar,
        line,
        isContextProvider: isContextProvider && propName === 'value',
      });
    },
  });

  // Generate issues for found unstable props
  for (const prop of unstableProps) {
    const typeDescriptions: Record<string, string> = {
      object: 'object',
      array: 'array',
      function: 'function',
      'function-call': 'function call result',
    };

    if (prop.isContextProvider) {
      // Context provider with unstable value - this causes all consumers to re-render
      results.push(
        createAnalysis({
          type: 'potential-issue',
          errorCode: 'RLD-404',
          category: 'performance',
          severity: 'medium',
          confidence: 'high',
          hookType: 'jsx-prop',
          line: prop.line,
          file: filePath,
          problematicDependency: prop.unstableVar.name,
          stateVariable: undefined,
          setterFunction: undefined,
          actualStateModifications: [],
          stateReads: [],
          explanation:
            `Context provider '${prop.componentName}' receives unstable ${typeDescriptions[prop.unstableVar.type]} '${prop.unstableVar.name}' as value. ` +
            `This creates a new object reference on every render, causing all context consumers to re-render unnecessarily. ` +
            `Fix: wrap the value with useMemo.`,
        })
      );
    } else {
      // Regular unstable prop - warn about potential memoization issues
      results.push(
        createAnalysis({
          type: 'potential-issue',
          errorCode: 'RLD-405',
          category: 'performance',
          severity: 'low',
          confidence: 'medium',
          hookType: 'jsx-prop',
          line: prop.line,
          file: filePath,
          problematicDependency: prop.unstableVar.name,
          stateVariable: undefined,
          setterFunction: undefined,
          actualStateModifications: [],
          stateReads: [],
          explanation:
            `Unstable ${typeDescriptions[prop.unstableVar.type]} '${prop.unstableVar.name}' is passed as prop '${prop.propName}' to '${prop.componentName}'. ` +
            `This creates a new reference on every render, which can cause unnecessary re-renders if the child component uses this prop in a useEffect dependency array or is memoized. ` +
            `Consider using useMemo/useCallback if the child depends on referential equality.`,
        })
      );
    }
  }

  return results;
}

/**
 * Find an unstable variable by name, checking component boundaries by line.
 */
function findUnstableVarByLine(
  unstableVars: Map<string, UnstableVariable>,
  varName: string,
  usageLine: number
): UnstableVariable | undefined {
  for (const unstableVar of unstableVars.values()) {
    if (
      unstableVar.name === varName &&
      unstableVar.componentStartLine !== undefined &&
      unstableVar.componentEndLine !== undefined &&
      usageLine >= unstableVar.componentStartLine &&
      usageLine <= unstableVar.componentEndLine
    ) {
      return unstableVar;
    }
  }
  return undefined;
}

/**
 * Get the name of a JSX element (handles both simple and member expressions)
 */
function getJSXElementName(node: t.JSXOpeningElement): string | null {
  if (t.isJSXIdentifier(node.name)) {
    return node.name.name;
  }
  if (t.isJSXMemberExpression(node.name)) {
    const parts: string[] = [];
    let current: t.JSXMemberExpression | t.JSXIdentifier = node.name;
    while (t.isJSXMemberExpression(current)) {
      parts.unshift(current.property.name);
      current = current.object;
    }
    if (t.isJSXIdentifier(current)) {
      parts.unshift(current.name);
    }
    return parts.join('.');
  }
  return null;
}
