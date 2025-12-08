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
  } catch (error) {
    // If CFG building fails, log in debug mode and return empty results
    if (process.env.DEBUG) {
      console.warn('[CFG] Failed to build CFG for hook body:', error);
    }
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
      guardAnalysis = analyzeGuardForSetState(reachability, stateVar, setterCall);
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
function findSetterCall(node: t.Node, setterNames: Set<string>): t.CallExpression | null {
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

interface CallbackTraversalState {
  type: 'promise' | 'deferred' | null;
  deferredType?: string;
  conditionalDepth: number;
}

/**
 * Find setState calls inside callbacks (promise and deferred).
 *
 * Uses t.VISITOR_KEYS for robust AST traversal, ensuring all child nodes
 * are visited without manually enumerating every possible AST node type.
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

  // Track callback context per node using a WeakMap
  const nodeContext = new WeakMap<t.Node, CallbackTraversalState>();

  // Helper to get context by walking up ancestor chain
  function getContextFromAncestors(node: t.Node, ancestors: t.Node[]): CallbackTraversalState {
    // Check current node first
    const ctx = nodeContext.get(node);
    if (ctx) return ctx;

    // Walk up ancestors (in reverse order since ancestors is root->leaf)
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const ancestorCtx = nodeContext.get(ancestors[i]);
      if (ancestorCtx) return ancestorCtx;
    }
    return { type: null, conditionalDepth: 0 };
  }

  // Helper to set context for callback bodies
  function setCallbackContext(
    node: t.Node,
    type: 'promise' | 'deferred',
    deferredType?: string
  ): void {
    nodeContext.set(node, { type, deferredType, conditionalDepth: 0 });
  }

  // Helper to mark a node as conditional within its callback context
  function markConditional(node: t.Node, parentCtx: CallbackTraversalState): void {
    if (parentCtx.type) {
      nodeContext.set(node, {
        ...parentCtx,
        conditionalDepth: parentCtx.conditionalDepth + 1,
      });
    }
  }

  // Use t.traverseFast which doesn't require a Program scope
  // We need to use simple traversal instead of @babel/traverse
  function visit(node: t.Node, ancestors: t.Node[]): void {
    const ctx = getContextFromAncestors(node, ancestors);
    const newAncestors = [...ancestors, node];

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
        for (const arg of node.arguments) {
          if (t.isArrowFunctionExpression(arg) || t.isFunctionExpression(arg)) {
            setCallbackContext(arg.body, 'deferred', callee.name);
          }
        }
      }

      // Check if this is a promise method call (.then/.catch/.finally)
      if (
        t.isMemberExpression(callee) &&
        t.isIdentifier(callee.property) &&
        PROMISE_METHODS.has(callee.property.name)
      ) {
        for (const arg of node.arguments) {
          if (t.isArrowFunctionExpression(arg) || t.isFunctionExpression(arg)) {
            setCallbackContext(arg.body, 'promise');
          }
        }
      }

      // Continue traversal into callee and arguments
      visit(callee, newAncestors);
      for (const arg of node.arguments) {
        visit(arg as t.Node, newAncestors);
      }
      return;
    }

    // Skip nested function declarations (they're not executed immediately)
    if (t.isFunctionDeclaration(node)) {
      return;
    }

    // Skip nested arrow/function expressions unless they're callback bodies we've marked
    if (t.isArrowFunctionExpression(node) || t.isFunctionExpression(node)) {
      if (nodeContext.has(node.body)) {
        // This is a callback body we want to traverse
        visit(node.body, newAncestors);
      }
      return;
    }

    // Mark conditional branches
    if (t.isIfStatement(node)) {
      visit(node.test, newAncestors);
      markConditional(node.consequent, ctx);
      visit(node.consequent, newAncestors);
      if (node.alternate) {
        markConditional(node.alternate, ctx);
        visit(node.alternate, newAncestors);
      }
      return;
    }

    if (t.isConditionalExpression(node)) {
      visit(node.test, newAncestors);
      markConditional(node.consequent, ctx);
      visit(node.consequent, newAncestors);
      markConditional(node.alternate, ctx);
      visit(node.alternate, newAncestors);
      return;
    }

    if (t.isLogicalExpression(node)) {
      visit(node.left, newAncestors);
      // Right side of && or || is conditional
      markConditional(node.right, ctx);
      visit(node.right, newAncestors);
      return;
    }

    // Loop bodies are conditional
    if (
      t.isForStatement(node) ||
      t.isWhileStatement(node) ||
      t.isDoWhileStatement(node) ||
      t.isForInStatement(node) ||
      t.isForOfStatement(node)
    ) {
      if (t.isForStatement(node)) {
        if (node.init) visit(node.init as t.Node, newAncestors);
        if (node.test) visit(node.test, newAncestors);
        if (node.update) visit(node.update, newAncestors);
      }
      if (t.isWhileStatement(node) || t.isDoWhileStatement(node)) {
        visit(node.test, newAncestors);
      }
      if (t.isForInStatement(node) || t.isForOfStatement(node)) {
        visit(node.right, newAncestors);
      }
      markConditional(node.body, ctx);
      visit(node.body, newAncestors);
      return;
    }

    // Switch statement
    if (t.isSwitchStatement(node)) {
      visit(node.discriminant, newAncestors);
      for (const caseClause of node.cases) {
        if (caseClause.test) visit(caseClause.test, newAncestors);
        for (const stmt of caseClause.consequent) {
          markConditional(stmt, ctx);
          visit(stmt, newAncestors);
        }
      }
      return;
    }

    // Try statement - catch block is conditional on an error being thrown
    if (t.isTryStatement(node)) {
      visit(node.block, newAncestors);
      if (node.handler) {
        // The catch block is conditional on an error being thrown
        markConditional(node.handler.body, ctx);
        visit(node.handler.body, newAncestors);
      }
      if (node.finalizer) {
        // The finally block executes regardless of an error
        visit(node.finalizer, newAncestors);
      }
      return;
    }

    // Use VISITOR_KEYS for generic traversal of other node types
    const keys = t.VISITOR_KEYS[node.type];
    if (!keys) return;

    for (const key of keys) {
      const value = (node as unknown as Record<string, unknown>)[key];
      if (value && typeof value === 'object') {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item && typeof item === 'object' && 'type' in item) {
              visit(item as t.Node, newAncestors);
            }
          }
        } else if ('type' in value) {
          visit(value as t.Node, newAncestors);
        }
      }
    }
  }

  visit(body, []);
  return foundSetters;
}
