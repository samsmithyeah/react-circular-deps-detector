/**
 * JSX Prop Analyzer Module
 *
 * Detects unstable references being passed as props to JSX elements.
 * This helps catch patterns where:
 * - Unstable objects/arrays are passed to memoized children (breaking memo)
 * - Unstable functions are passed as callbacks (causing unnecessary re-renders)
 * - Context.Provider receives unstable value props
 *
 * To reduce false positives, this analyzer now only reports warnings when
 * the receiving component is memoized (wrapped with React.memo). Passing
 * unstable props to non-memoized components has no performance impact.
 */

import * as t from '@babel/types';
import * as path from 'path';
import traverse, { NodePath } from '@babel/traverse';
import { HookAnalysis } from './types';
import { UnstableVariable } from './state-extractor';
import { createAnalysis, isMemoCallExpression } from './utils';
import { ImportInfo, ParsedFile } from './parser';

/** Information about a JSX prop with an unstable value */
interface UnstableJsxProp {
  componentName: string;
  propName: string;
  unstableVar: UnstableVariable;
  line: number;
  isContextProvider: boolean;
}

/**
 * Find local components that are wrapped with memo() or React.memo()
 * within the same file.
 */
function findLocalMemoizedComponents(ast: t.Node): Set<string> {
  const memoizedComponents = new Set<string>();

  traverse(ast, {
    noScope: true,
    CallExpression(nodePath: NodePath<t.CallExpression>) {
      if (isMemoCallExpression(nodePath.node)) {
        const parent = nodePath.parent;
        if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) {
          memoizedComponents.add(parent.id.name);
        }
      }
    },
  });

  return memoizedComponents;
}

/**
 * Check if a component is memoized, either locally or from an imported file.
 *
 * @param componentName - The name of the component (e.g., "MyButton" or "Components.Button")
 * @param localMemoized - Set of locally memoized component names
 * @param imports - Import declarations from the current file
 * @param allParsedFiles - All parsed files in the project
 * @param currentFilePath - Path of the current file being analyzed
 * @returns true if the component is known to be memoized, false otherwise
 */
function isComponentMemoized(
  componentName: string,
  localMemoized: Set<string>,
  imports?: ImportInfo[],
  allParsedFiles?: ParsedFile[],
  currentFilePath?: string
): boolean {
  // Check if it's a local memoized component
  if (localMemoized.has(componentName)) {
    return true;
  }

  // If we don't have import info, we can't check cross-file
  if (!imports || !allParsedFiles || !currentFilePath) {
    return false;
  }

  // Handle member-access component names (e.g., "Components.Button" from namespace imports)
  const componentParts = componentName.split('.');
  const rootIdentifier = componentParts[0];
  const isMemberAccess = componentParts.length > 1;

  // Find which import this component comes from
  for (const imp of imports) {
    if (!imp.imports.includes(rootIdentifier)) continue;

    // Resolve the import path relative to the current file
    const currentDir = path.dirname(currentFilePath);
    const resolvedImportPath = path.resolve(currentDir, imp.source);

    // Build list of possible file paths (with different extensions)
    const extensions = ['', '.ts', '.tsx', '.js', '.jsx'];
    const possiblePaths = extensions.flatMap((ext) => [
      `${resolvedImportPath}${ext}`,
      path.join(resolvedImportPath, `index${ext}`),
    ]);

    // Find the matching source file
    const sourceFile = allParsedFiles.find((f) => possiblePaths.includes(f.file));

    if (!sourceFile) continue;

    // Check if the component is exported as memoized from that file
    for (const exp of sourceFile.exports) {
      let isMatch = false;

      if (isMemberAccess) {
        // e.g., <Components.Button /> from `import * as Components from ...`
        // Match the second part of the component name against named exports
        if (imp.isNamespaceImport && exp.name === componentParts[1] && !exp.isDefault) {
          isMatch = true;
        }
      } else {
        // e.g., <Button /> from `import { Button } ...` or `import Button from ...`
        isMatch = (imp.isDefaultImport && exp.isDefault) || exp.name === rootIdentifier;
      }

      if (isMatch && exp.isMemoized) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Find unstable variables being passed as JSX props.
 * Returns issues for patterns like:
 * - <Component prop={unstableObject} /> (only if Component is memoized)
 * - <Context.Provider value={unstableObject}>
 *
 * @param ast - The AST to analyze
 * @param unstableVars - Map of unstable variables in the file
 * @param filePath - Path of the current file
 * @param imports - Import declarations (optional, for cross-file memoization detection)
 * @param allParsedFiles - All parsed files (optional, for cross-file memoization detection)
 */
export function analyzeJsxProps(
  ast: t.Node,
  unstableVars: Map<string, UnstableVariable>,
  filePath: string,
  imports?: ImportInfo[],
  allParsedFiles?: ParsedFile[]
): HookAnalysis[] {
  const results: HookAnalysis[] = [];
  const unstableProps: UnstableJsxProp[] = [];

  // Find locally memoized components
  const localMemoizedComponents = findLocalMemoizedComponents(ast);

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

      // Check if this is a Context.Provider - must be *.Provider element with value prop
      const isContextProvider = elementName.endsWith('.Provider') && propName === 'value';

      unstableProps.push({
        componentName: elementName,
        propName,
        unstableVar,
        line,
        isContextProvider,
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
      // Always report this since it affects all context consumers
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
      // For regular components, only report if the component is memoized
      // Passing unstable props to non-memoized components has no performance impact
      const componentIsMemoized = isComponentMemoized(
        prop.componentName,
        localMemoizedComponents,
        imports,
        allParsedFiles,
        filePath
      );

      // Skip warning if component is not memoized (no performance impact)
      if (!componentIsMemoized) {
        continue;
      }

      // Component is memoized - this is a real performance issue
      results.push(
        createAnalysis({
          type: 'potential-issue',
          errorCode: 'RLD-405',
          category: 'performance',
          severity: 'medium',
          confidence: 'high', // High confidence since we know the component is memoized
          hookType: 'jsx-prop',
          line: prop.line,
          file: filePath,
          problematicDependency: prop.unstableVar.name,
          stateVariable: undefined,
          setterFunction: undefined,
          actualStateModifications: [],
          stateReads: [],
          explanation:
            `Unstable ${typeDescriptions[prop.unstableVar.type]} '${prop.unstableVar.name}' is passed as prop '${prop.propName}' to memoized component '${prop.componentName}'. ` +
            `This creates a new reference on every render, defeating the purpose of React.memo() and causing unnecessary re-renders. ` +
            `Fix: wrap '${prop.unstableVar.name}' with ${prop.unstableVar.type === 'function' ? 'useCallback' : 'useMemo'}.`,
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
