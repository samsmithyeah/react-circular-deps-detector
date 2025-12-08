/**
 * Shared Utilities for React Loop Detector
 *
 * This module contains utility functions used across the analyzer modules.
 */

import * as t from '@babel/types';
import { HookAnalysis, CreateAnalysisParams, AnalyzerOptions } from './types';

/**
 * Module-level options storage for helper functions.
 *
 * Note: This is intentional - the analyzer runs synchronously in a single thread,
 * and options are reset at the start of each analyzeHooks() call.
 * While passing options through the call chain would be more pure, the current
 * approach avoids threading options through 10+ function calls for a simple
 * config lookup. The tradeoff is acceptable since the analyzer is not concurrent.
 */
let currentOptions: AnalyzerOptions = {};

/**
 * Set the current analyzer options
 */
export function setCurrentOptions(options: AnalyzerOptions): void {
  currentOptions = options;
}

/**
 * Get the current analyzer options
 */
export function getCurrentOptions(): AnalyzerOptions {
  return currentOptions;
}

/**
 * Check if a hook at the given line should be ignored based on comments.
 * Supports:
 * - // rcd-ignore (on same line)
 * - // rcd-ignore-next-line (on previous line)
 * - Block comments with rcd-ignore (inline or on same line)
 */
export function isHookIgnored(fileContent: string, hookLine: number): boolean {
  const lines = fileContent.split('\n');

  // Check the hook's line for inline ignore comment
  if (hookLine > 0 && hookLine <= lines.length) {
    const currentLine = lines[hookLine - 1];
    if (/\/\/\s*rcd-ignore\b/.test(currentLine) || /\/\*\s*rcd-ignore\s*\*\//.test(currentLine)) {
      return true;
    }
  }

  // Check the previous line for rcd-ignore-next-line
  if (hookLine > 1 && hookLine <= lines.length) {
    const previousLine = lines[hookLine - 2];
    if (
      /\/\/\s*rcd-ignore-next-line\b/.test(previousLine) ||
      /\/\*\s*rcd-ignore-next-line\s*\*\//.test(previousLine)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a node contains another node (by reference)
 */
export function containsNode(tree: t.Node | null | undefined, target: t.Node): boolean {
  if (tree === target) return true;
  if (!tree || typeof tree !== 'object') return false;

  const indexableTree = tree as unknown as Record<string, unknown>;
  for (const key of Object.keys(tree)) {
    const value = indexableTree[key];
    if (Array.isArray(value)) {
      if (value.some((child) => containsNode(child as t.Node, target))) return true;
    } else if (value && typeof value === 'object') {
      if (containsNode(value as t.Node, target)) return true;
    }
  }

  return false;
}

/**
 * Create an analysis result object
 */
export function createAnalysis(params: CreateAnalysisParams): HookAnalysis {
  const result: HookAnalysis = {
    type: params.type,
    errorCode: params.errorCode,
    category: params.category,
    description: `${params.hookType} ${params.type.replace(/-/g, ' ')}`,
    file: params.file,
    line: params.line,
    column: params.column,
    hookType: params.hookType,
    problematicDependency: params.problematicDependency,
    stateVariable: params.stateVariable,
    setterFunction: params.setterFunction,
    severity: params.severity,
    confidence: params.confidence,
    explanation: params.explanation,
    actualStateModifications: params.actualStateModifications,
    stateReads: params.stateReads,
  };

  // Only include debug info if debug mode is enabled
  if (currentOptions.debug && params.debugInfo) {
    result.debugInfo = params.debugInfo;
  }

  return result;
}

/**
 * Check if a setter argument uses object spread with the state variable.
 * Examples that return true:
 * - `{ ...user, id: 5 }`
 * - `{ ...user }`
 * - `Object.assign({}, user, { id: 5 })`
 */
export function usesObjectSpread(setterArg: t.Node | null | undefined, stateVar: string): boolean {
  if (!setterArg) return false;

  // Check for object expression with spread: { ...stateVar, ... }
  if (setterArg.type === 'ObjectExpression') {
    for (const prop of setterArg.properties || []) {
      if (prop.type === 'SpreadElement') {
        // Check if spreading the state variable
        if (prop.argument?.type === 'Identifier' && prop.argument.name === stateVar) {
          return true;
        }
      }
    }
  }

  // Check for Object.assign({}, stateVar, ...)
  if (setterArg.type === 'CallExpression') {
    const callee = setterArg.callee;
    if (
      callee?.type === 'MemberExpression' &&
      callee.object?.type === 'Identifier' &&
      callee.object.name === 'Object' &&
      callee.property?.type === 'Identifier' &&
      callee.property.name === 'assign'
    ) {
      // Check if any argument is the state variable
      for (const arg of setterArg.arguments || []) {
        if (arg.type === 'Identifier' && arg.name === stateVar) {
          return true;
        }
      }
    }
  }

  // Check for array spread: [...items, newItem]
  if (setterArg.type === 'ArrayExpression') {
    for (const element of setterArg.elements || []) {
      if (element?.type === 'SpreadElement') {
        if (element.argument?.type === 'Identifier' && element.argument.name === stateVar) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Check if a condition references a state variable
 */
export function conditionInvolvesState(
  condition: t.Node | null | undefined,
  stateVar: string
): boolean {
  if (!condition) return false;

  if (condition.type === 'Identifier' && condition.name === stateVar) {
    return true;
  }

  if (condition.type === 'BinaryExpression' || condition.type === 'LogicalExpression') {
    return (
      conditionInvolvesState(condition.left, stateVar) ||
      conditionInvolvesState(condition.right, stateVar)
    );
  }

  if (condition.type === 'UnaryExpression') {
    return conditionInvolvesState(condition.argument, stateVar);
  }

  if (condition.type === 'MemberExpression') {
    return conditionInvolvesState(condition.object, stateVar);
  }

  return false;
}
