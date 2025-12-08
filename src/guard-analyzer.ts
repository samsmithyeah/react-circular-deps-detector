/**
 * Guard Analyzer Module
 *
 * Analyzes conditional guards around setState calls to determine if they prevent infinite loops.
 * This module handles:
 * - Toggle guards: if (!value) setValue(true)
 * - Equality guards: if (value !== newValue) setValue(newValue)
 * - Early return patterns: if (condition) return; setValue(...)
 * - Object spread risk detection
 */

import * as t from '@babel/types';
import { GuardedModification } from './types';
import { containsNode, usesObjectSpread, conditionInvolvesState } from './utils';

/**
 * Analyze whether a conditional guard around a state setter prevents infinite loops.
 *
 * Common safe patterns:
 * 1. Toggle guard: `if (!value) setValue(true)` - only sets when false
 * 2. Equality guard: `if (value !== newValue) setValue(newValue)` - only sets when different
 * 3. Early return: `if (value === something) return; setValue(...)` - exits before setting
 */
export function analyzeConditionalGuard(
  setterCall: t.CallExpression,
  ancestorStack: t.Node[],
  setterName: string,
  stateVar: string | undefined,
  _allStateVars: string[] // Reserved for future use
): GuardedModification | null {
  if (!stateVar) return null;

  // Find the nearest conditional ancestor
  for (let i = ancestorStack.length - 1; i >= 0; i--) {
    const ancestor = ancestorStack[i];

    // Check for IfStatement
    if (ancestor.type === 'IfStatement') {
      const condition = ancestor.test;
      const guardType = analyzeCondition(condition, stateVar, setterCall, ancestor);

      if (guardType) {
        return {
          setter: setterName,
          stateVariable: stateVar,
          guardType: guardType.type,
          isSafe: guardType.isSafe,
          warning: guardType.warning,
        };
      }
    }

    // Check for early return pattern in BlockStatement
    if (ancestor.type === 'BlockStatement') {
      const earlyReturnGuard = checkEarlyReturnPattern(ancestor, setterCall, stateVar);
      if (earlyReturnGuard) {
        return {
          setter: setterName,
          stateVariable: stateVar,
          guardType: 'early-return',
          isSafe: true,
        };
      }
    }
  }

  return null;
}

/**
 * Analyze if a condition creates a safe guard for state modification.
 */
export function analyzeCondition(
  condition: t.Node | null | undefined,
  stateVar: string,
  setterCall: t.CallExpression,
  _ifStatement: t.IfStatement
): { type: GuardedModification['guardType']; isSafe: boolean; warning?: string } | null {
  if (!condition) return null;

  // Pattern 1: Toggle guard - `if (!stateVar)` or `if (stateVar === false)`
  // Setting to true when false (or vice versa) - only runs once
  if (condition.type === 'UnaryExpression' && condition.operator === '!') {
    if (condition.argument?.type === 'Identifier' && condition.argument.name === stateVar) {
      // Check if we're setting to a truthy value (common: true, or any non-falsy)
      const setterArg = setterCall.arguments?.[0];
      if (setterArg) {
        // `if (!value) setValue(true)` - toggle guard, safe
        if (setterArg.type === 'BooleanLiteral' && setterArg.value === true) {
          return { type: 'toggle-guard', isSafe: true };
        }
        // `if (!value) setValue(something)` where something is truthy - likely safe
        if (setterArg.type !== 'Identifier' || setterArg.name !== stateVar) {
          return { type: 'toggle-guard', isSafe: true };
        }
      }
    }
  }

  // Pattern 1b: `if (stateVar)` with setting to falsy
  if (condition.type === 'Identifier' && condition.name === stateVar) {
    const setterArg = setterCall.arguments?.[0];
    if (setterArg?.type === 'BooleanLiteral' && setterArg.value === false) {
      return { type: 'toggle-guard', isSafe: true };
    }
    if (
      setterArg?.type === 'NullLiteral' ||
      (setterArg?.type === 'Identifier' && setterArg.name === 'undefined')
    ) {
      return { type: 'toggle-guard', isSafe: true };
    }
  }

  // Pattern 2: Equality guard - `if (stateVar !== newValue)` or `if (newValue !== stateVar)`
  if (condition.type === 'BinaryExpression') {
    const { left, right, operator } = condition;

    // Check for !== or !=
    if (operator === '!==' || operator === '!=') {
      const hasStateOnLeft = left?.type === 'Identifier' && left.name === stateVar;
      const hasStateOnRight = right?.type === 'Identifier' && right.name === stateVar;

      if (hasStateOnLeft || hasStateOnRight) {
        return { type: 'equality-guard', isSafe: true };
      }

      // Check for PROPERTY equality guard with object spread risk
      // Pattern: if (user.id !== 5) setUser({ ...user, id: 5 })
      const leftIsMemberOfState =
        left?.type === 'MemberExpression' &&
        left.object?.type === 'Identifier' &&
        left.object.name === stateVar;

      const rightIsMemberOfState =
        right?.type === 'MemberExpression' &&
        right.object?.type === 'Identifier' &&
        right.object.name === stateVar;

      if (leftIsMemberOfState || rightIsMemberOfState) {
        // Check if setter creates a new object reference
        const setterArg = setterCall.arguments?.[0];
        if (setterArg && usesObjectSpread(setterArg, stateVar)) {
          // This is risky: guard checks property, but setter creates new object
          return {
            type: 'object-spread-risk',
            isSafe: false,
            warning:
              `Guard checks property of '${stateVar}' but setter creates new object reference. ` +
              `Even after the property matches, the object reference changes each render, ` +
              `which may cause issues if other effects or memoized values depend on object identity.`,
          };
        }

        // Property check without object spread - could be safe
        return { type: 'equality-guard', isSafe: true };
      }
    }

    // Check for === or == with early return (handled elsewhere)
  }

  // Pattern 3: Logical AND with state check - `if (someCondition && !stateVar)`
  if (condition.type === 'LogicalExpression' && condition.operator === '&&') {
    // Recursively check both sides
    const leftResult = analyzeCondition(condition.left, stateVar, setterCall, _ifStatement);
    const rightResult = analyzeCondition(condition.right, stateVar, setterCall, _ifStatement);

    if (leftResult?.isSafe) return leftResult;
    if (rightResult?.isSafe) return rightResult;
  }

  return null;
}

/**
 * Check for early return pattern:
 * ```
 * if (value === something) return;
 * setValue(newValue);
 * ```
 */
export function checkEarlyReturnPattern(
  blockStatement: t.BlockStatement,
  setterCall: t.CallExpression,
  stateVar: string
): boolean {
  if (!blockStatement.body || !Array.isArray(blockStatement.body)) return false;

  // Find the index of the setter call in the block
  let setterIndex = -1;
  for (let i = 0; i < blockStatement.body.length; i++) {
    if (containsNode(blockStatement.body[i], setterCall)) {
      setterIndex = i;
      break;
    }
  }

  if (setterIndex <= 0) return false;

  // Check statements before the setter for early return guards
  for (let i = 0; i < setterIndex; i++) {
    const stmt = blockStatement.body[i];

    if (stmt.type === 'IfStatement') {
      // Check if it's `if (condition) return;`
      const hasReturn =
        stmt.consequent?.type === 'ReturnStatement' ||
        (stmt.consequent?.type === 'BlockStatement' &&
          stmt.consequent.body?.length === 1 &&
          stmt.consequent.body[0]?.type === 'ReturnStatement');

      if (hasReturn) {
        // Check if condition involves the state variable
        if (conditionInvolvesState(stmt.test, stateVar)) {
          return true;
        }
      }
    }
  }

  return false;
}
