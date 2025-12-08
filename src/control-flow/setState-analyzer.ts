/**
 * setState Analyzer - Uses CFG to analyze setState calls in React hooks.
 *
 * This module provides more accurate analysis of setState calls in hooks
 * by using Control Flow Graph analysis to determine:
 * - Whether setState is guaranteed to execute (unconditional)
 * - Whether guards effectively prevent infinite loops
 * - Path conditions that lead to setState execution
 */

import * as t from '@babel/types';
import { buildCFG } from './cfg-builder';
import { analyzeReachability, conditionInvolvesVariable } from './cfg-analyzer';
import type { CFG, CFGNode, ReachabilityResult, GuardAnalysis } from './cfg-types';

/**
 * Result of analyzing a setState call using CFG.
 */
export interface SetStateAnalysis {
  /** Whether the setState call is guaranteed to execute every time */
  isUnconditional: boolean;

  /** Whether the setState call is reachable at all */
  isReachable: boolean;

  /** Whether there's an effective guard preventing infinite loops */
  hasEffectiveGuard: boolean;

  /** Guard analysis details */
  guardAnalysis?: GuardAnalysis;

  /** CFG node for the setState call */
  cfgNode?: CFGNode;

  /** All paths from entry to setState */
  paths: CFGNode[][];

  /** Explanation of the analysis */
  explanation: string;
}

/**
 * Analyze all setState calls in a hook body using CFG.
 *
 * @param hookBody - The hook callback body (arrow function or function expression)
 * @param stateInfo - Map of state variable names to their setter functions
 * @param dependencies - Dependencies array of the hook
 * @returns Map of setter function names to their analysis results
 */
export function analyzeSetStateCalls(
  hookBody: t.Node,
  stateInfo: Map<string, string>,
  dependencies: string[]
): Map<string, SetStateAnalysis> {
  const results = new Map<string, SetStateAnalysis>();

  // Get the actual function body
  let bodyToAnalyze: t.BlockStatement | t.Expression | null = null;
  if (t.isArrowFunctionExpression(hookBody)) {
    bodyToAnalyze = hookBody.body as t.BlockStatement | t.Expression;
  } else if (t.isFunctionExpression(hookBody)) {
    bodyToAnalyze = hookBody.body;
  } else if (t.isBlockStatement(hookBody)) {
    bodyToAnalyze = hookBody;
  }

  if (!bodyToAnalyze) {
    return results;
  }

  // Build CFG for the hook body
  let cfg: CFG;
  try {
    cfg = buildCFG(bodyToAnalyze);
  } catch {
    // If CFG building fails, return empty results
    return results;
  }

  // Find all setState calls in the hook body
  const setterNames = new Set(stateInfo.values());
  const setterToState = new Map<string, string>();
  stateInfo.forEach((setter, state) => setterToState.set(setter, state));

  // Find setState calls in special callback contexts that the CFG doesn't traverse into:
  // 1. Promise callbacks (.then/.catch/.finally) - treated as unconditional when promise settles
  // 2. Deferred callbacks (setTimeout/setInterval/requestAnimationFrame) - treated as conditional
  const callbackAnalysis = findSettersInCallbacks(bodyToAnalyze, setterNames);

  for (const [setterName, context] of callbackAnalysis) {
    if (context.type === 'promise') {
      // Promise callbacks are treated as unconditional (will execute when promise settles)
      // But check if the setState inside the promise callback is itself conditional
      results.set(setterName, {
        isUnconditional: !context.isConditionalWithinCallback,
        isReachable: true,
        hasEffectiveGuard: context.isConditionalWithinCallback,
        paths: [],
        explanation: context.isConditionalWithinCallback
          ? `${setterName}() is conditionally called inside a promise callback`
          : `${setterName}() is called inside a promise callback (.then/.catch/.finally) - will execute when promise settles`,
      });
    } else if (context.type === 'deferred') {
      // Deferred callbacks might never execute (could be cleared), so treat as conditional
      results.set(setterName, {
        isUnconditional: false, // Deferred callbacks are conditional
        isReachable: true,
        hasEffectiveGuard: true, // The deferral itself acts as a guard
        paths: [],
        explanation: `${setterName}() is called inside a deferred callback (${context.deferredType}) - may not execute`,
      });
    }
  }

  // Find setState call nodes in the CFG
  for (const [_nodeId, node] of cfg.nodes) {
    if (!node.astNode) continue;

    // Check if this node contains a setState call
    const setterCall = findSetterCall(node.astNode, setterNames);
    if (!setterCall) continue;

    const setterName = getSetterName(setterCall);
    if (!setterName) continue;

    const stateVar = setterToState.get(setterName);
    const stateInDeps = stateVar ? dependencies.includes(stateVar) : false;

    // Analyze reachability for this setState call
    const reachability = analyzeReachability(cfg, node);

    // Determine if unconditional
    const isUnconditional = reachability.guaranteedToExecute;

    // Analyze guard effectiveness
    let guardAnalysis: GuardAnalysis | undefined;
    if (!isUnconditional && reachability.pathConditions.length > 0) {
      guardAnalysis = analyzeGuardForSetState(
        reachability,
        stateVar,
        setterCall
      );
    }

    const hasEffectiveGuard = guardAnalysis?.isEffective ?? false;

    // Generate explanation
    let explanation: string;
    if (!reachability.reachable) {
      explanation = `${setterName}() is unreachable (dead code)`;
    } else if (isUnconditional) {
      if (stateInDeps) {
        explanation = `${setterName}() is called unconditionally with ${stateVar} in dependencies - infinite loop risk`;
      } else {
        explanation = `${setterName}() is called unconditionally`;
      }
    } else if (hasEffectiveGuard) {
      explanation = `${setterName}() has effective guard: ${guardAnalysis!.explanation}`;
    } else {
      explanation = `${setterName}() is conditionally executed`;
    }

    results.set(setterName, {
      isUnconditional,
      isReachable: reachability.reachable,
      hasEffectiveGuard,
      guardAnalysis,
      cfgNode: node,
      paths: reachability.paths,
      explanation,
    });
  }

  return results;
}

/**
 * Check if a hook body has any unconditional setState calls using CFG analysis.
 * This is a drop-in replacement for the heuristic-based hasUnconditionalSetState.
 */
export function hasUnconditionalSetStateCFG(
  hookBody: t.Node,
  stateInfo: Map<string, string>
): boolean {
  const analysis = analyzeSetStateCalls(hookBody, stateInfo, []);

  for (const result of analysis.values()) {
    if (result.isUnconditional && result.isReachable) {
      return true;
    }
  }

  return false;
}

/**
 * Find a setState call expression in an AST node.
 */
function findSetterCall(
  node: t.Node,
  setterNames: Set<string>
): t.CallExpression | null {
  if (t.isCallExpression(node)) {
    const callee = node.callee;
    if (t.isIdentifier(callee) && setterNames.has(callee.name)) {
      return node;
    }
  }

  if (t.isExpressionStatement(node)) {
    return findSetterCall(node.expression, setterNames);
  }

  return null;
}

/**
 * Get the setter function name from a call expression.
 */
function getSetterName(call: t.CallExpression): string | null {
  if (t.isIdentifier(call.callee)) {
    return call.callee.name;
  }
  return null;
}

/**
 * Analyze guard effectiveness specifically for setState calls.
 */
function analyzeGuardForSetState(
  reachability: ReachabilityResult,
  stateVar: string | undefined,
  setterCall: t.CallExpression
): GuardAnalysis {
  // Check each path's conditions
  for (const conditions of reachability.pathConditions) {
    for (const condition of conditions) {
      // Check if condition involves the state variable
      if (stateVar && conditionInvolvesVariable(condition.conditionNode, stateVar)) {
        // Analyze the specific guard pattern
        const guardType = detectGuardType(condition.conditionNode, stateVar, setterCall);

        if (guardType === 'equality-guard') {
          return {
            guardType: 'equality-guard',
            isEffective: true,
            guardCondition: condition.conditionNode,
            explanation: `Guard checks ${stateVar} before updating`,
            riskLevel: 'safe',
          };
        }

        if (guardType === 'toggle-guard') {
          return {
            guardType: 'toggle-guard',
            isEffective: true,
            guardCondition: condition.conditionNode,
            explanation: `Toggle guard on ${stateVar}`,
            riskLevel: 'safe',
          };
        }
      }
    }
  }

  // No effective guard found
  return {
    guardType: 'none',
    isEffective: false,
    explanation: 'No guard that checks state before updating',
    riskLevel: 'unsafe',
  };
}

/**
 * Detect the type of guard pattern in a condition.
 */
function detectGuardType(
  condition: t.Node,
  stateVar: string,
  _setterCall: t.CallExpression
): 'equality-guard' | 'toggle-guard' | 'conditional-set' | 'none' {
  // Equality guard: if (x !== y) or if (x === y)
  if (t.isBinaryExpression(condition)) {
    const { operator, left, right } = condition;
    const hasStateOnLeft = t.isIdentifier(left) && left.name === stateVar;
    const hasStateOnRight = t.isIdentifier(right) && right.name === stateVar;

    if (
      (operator === '!==' || operator === '!=' || operator === '===' || operator === '==') &&
      (hasStateOnLeft || hasStateOnRight)
    ) {
      return 'equality-guard';
    }
  }

  // Toggle guard: if (!flag) or if (flag)
  if (t.isUnaryExpression(condition) && condition.operator === '!') {
    if (t.isIdentifier(condition.argument) && condition.argument.name === stateVar) {
      return 'toggle-guard';
    }
  }

  if (t.isIdentifier(condition) && condition.name === stateVar) {
    return 'toggle-guard';
  }

  return 'none';
}

/**
 * Context information for a setState call found in a callback.
 */
interface CallbackContext {
  type: 'promise' | 'deferred';
  /** For deferred callbacks, the specific type (setTimeout, setInterval, etc.) */
  deferredType?: string;
  /** Whether the setState is inside a conditional within the callback */
  isConditionalWithinCallback: boolean;
}

/** Deferred function names that might never execute (can be cleared/cancelled) */
const DEFERRED_FUNCTIONS = new Set(['setTimeout', 'setInterval', 'requestAnimationFrame']);

/** Promise method names */
const PROMISE_METHODS = new Set(['then', 'catch', 'finally']);

/**
 * Find setState calls inside callbacks (promise and deferred).
 *
 * This function traverses the AST looking for setState calls inside:
 * 1. Promise callbacks (.then/.catch/.finally) - will execute when promise settles
 * 2. Deferred callbacks (setTimeout/setInterval/requestAnimationFrame) - might not execute
 *
 * @returns Map of setter names to their callback context
 */
function findSettersInCallbacks(
  body: t.Node,
  setterNames: Set<string>
): Map<string, CallbackContext> {
  const foundSetters = new Map<string, CallbackContext>();

  interface VisitorContext {
    type: 'promise' | 'deferred' | null;
    deferredType?: string;
    conditionalDepth: number;
  }

  function visitNode(node: t.Node | null | undefined, ctx: VisitorContext): void {
    if (!node) return;

    if (t.isCallExpression(node)) {
      const callee = node.callee;

      // Check if it's a setState call inside a callback
      if (ctx.type && t.isIdentifier(callee) && setterNames.has(callee.name)) {
        foundSetters.set(callee.name, {
          type: ctx.type,
          deferredType: ctx.deferredType,
          isConditionalWithinCallback: ctx.conditionalDepth > 0,
        });
      }

      // Check if this is a deferred function call (setTimeout, setInterval, etc.)
      if (t.isIdentifier(callee) && DEFERRED_FUNCTIONS.has(callee.name)) {
        // Visit the callback argument with deferred context
        for (const arg of node.arguments) {
          if (t.isArrowFunctionExpression(arg) || t.isFunctionExpression(arg)) {
            visitNode(arg.body, {
              type: 'deferred',
              deferredType: callee.name,
              conditionalDepth: 0,
            });
          }
        }
        return;
      }

      // Check if this is a promise method call (.then/.catch/.finally)
      if (
        t.isMemberExpression(callee) &&
        t.isIdentifier(callee.property) &&
        PROMISE_METHODS.has(callee.property.name)
      ) {
        // Visit the object (the promise chain before this method)
        visitNode(callee.object, ctx);

        // Visit the callback arguments with promise context
        for (const arg of node.arguments) {
          if (t.isArrowFunctionExpression(arg) || t.isFunctionExpression(arg)) {
            visitNode(arg.body, {
              type: 'promise',
              conditionalDepth: 0,
            });
          } else {
            visitNode(arg, ctx);
          }
        }
        return;
      }

      // Regular call - visit callee and arguments
      visitNode(callee, ctx);
      for (const arg of node.arguments) {
        visitNode(arg, ctx);
      }
      return;
    }

    // Conditional contexts - increase depth when inside a callback
    if (t.isIfStatement(node)) {
      visitNode(node.test, ctx);
      visitNode(node.consequent, {
        ...ctx,
        conditionalDepth: ctx.type ? ctx.conditionalDepth + 1 : 0,
      });
      visitNode(node.alternate, {
        ...ctx,
        conditionalDepth: ctx.type ? ctx.conditionalDepth + 1 : 0,
      });
      return;
    }

    if (t.isConditionalExpression(node)) {
      visitNode(node.test, ctx);
      visitNode(node.consequent, {
        ...ctx,
        conditionalDepth: ctx.type ? ctx.conditionalDepth + 1 : 0,
      });
      visitNode(node.alternate, {
        ...ctx,
        conditionalDepth: ctx.type ? ctx.conditionalDepth + 1 : 0,
      });
      return;
    }

    if (t.isLogicalExpression(node)) {
      visitNode(node.left, ctx);
      // Right side of && or || is conditional
      visitNode(node.right, {
        ...ctx,
        conditionalDepth: ctx.type ? ctx.conditionalDepth + 1 : 0,
      });
      return;
    }

    // Traverse other node types
    if (t.isBlockStatement(node)) {
      for (const stmt of node.body) {
        visitNode(stmt, ctx);
      }
      return;
    }

    if (t.isExpressionStatement(node)) {
      visitNode(node.expression, ctx);
      return;
    }

    if (t.isReturnStatement(node)) {
      visitNode(node.argument, ctx);
      return;
    }

    if (t.isVariableDeclaration(node)) {
      for (const decl of node.declarations) {
        visitNode(decl.init, ctx);
      }
      return;
    }

    if (t.isArrowFunctionExpression(node) || t.isFunctionExpression(node)) {
      // Don't traverse into other nested functions (they're not executed immediately)
      return;
    }

    if (t.isMemberExpression(node)) {
      visitNode(node.object, ctx);
      return;
    }

    if (t.isBinaryExpression(node)) {
      visitNode(node.left, ctx);
      visitNode(node.right, ctx);
      return;
    }

    if (t.isAwaitExpression(node)) {
      visitNode(node.argument, ctx);
      return;
    }

    if (t.isTryStatement(node)) {
      visitNode(node.block, ctx);
      visitNode(node.handler?.body, ctx);
      visitNode(node.finalizer, ctx);
      return;
    }

    // For/while loops - body is conditional (may not execute or execute multiple times)
    if (
      t.isForStatement(node) ||
      t.isWhileStatement(node) ||
      t.isDoWhileStatement(node) ||
      t.isForInStatement(node) ||
      t.isForOfStatement(node)
    ) {
      if (t.isForStatement(node)) {
        visitNode(node.init, ctx);
        visitNode(node.test, ctx);
        visitNode(node.update, ctx);
      }
      if (t.isWhileStatement(node) || t.isDoWhileStatement(node)) {
        visitNode(node.test, ctx);
      }
      if (t.isForInStatement(node) || t.isForOfStatement(node)) {
        visitNode(node.right, ctx);
      }
      visitNode(node.body, {
        ...ctx,
        conditionalDepth: ctx.type ? ctx.conditionalDepth + 1 : 0,
      });
      return;
    }

    // Switch statement
    if (t.isSwitchStatement(node)) {
      visitNode(node.discriminant, ctx);
      for (const caseClause of node.cases) {
        visitNode(caseClause.test, ctx);
        for (const stmt of caseClause.consequent) {
          visitNode(stmt, {
            ...ctx,
            conditionalDepth: ctx.type ? ctx.conditionalDepth + 1 : 0,
          });
        }
      }
      return;
    }
  }

  visitNode(body, { type: null, conditionalDepth: 0 });
  return foundSetters;
}

/**
 * Export the CFG for debugging/visualization.
 */
export function buildHookCFG(hookBody: t.Node): CFG | null {
  let bodyToAnalyze: t.BlockStatement | t.Expression | null = null;
  if (t.isArrowFunctionExpression(hookBody)) {
    bodyToAnalyze = hookBody.body as t.BlockStatement | t.Expression;
  } else if (t.isFunctionExpression(hookBody)) {
    bodyToAnalyze = hookBody.body;
  } else if (t.isBlockStatement(hookBody)) {
    bodyToAnalyze = hookBody;
  }

  if (!bodyToAnalyze) {
    return null;
  }

  try {
    return buildCFG(bodyToAnalyze);
  } catch {
    return null;
  }
}
