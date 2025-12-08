/**
 * CFG Analyzer - Analyzes Control Flow Graphs for reachability and path conditions.
 *
 * This module provides algorithms to:
 * - Find all paths from entry to a specific node
 * - Extract conditions that must be true for each path
 * - Determine if a node is guaranteed to execute
 * - Analyze guard effectiveness for preventing infinite loops
 */

import * as t from '@babel/types';
import type {
  CFG,
  CFGNode,
  ReachabilityResult,
  PathCondition,
  GuardAnalysis,
  SetStateAnalysisResult,
} from './cfg-types';

/**
 * Maximum number of paths to enumerate before giving up.
 * This prevents exponential blowup in highly branched code.
 */
const MAX_PATHS = 100;

/**
 * Maximum path length to prevent infinite loops in cyclic graphs.
 */
const MAX_PATH_LENGTH = 50;

/**
 * Analyze reachability and path conditions for a specific CFG node.
 */
export function analyzeReachability(cfg: CFG, targetNode: CFGNode): ReachabilityResult {
  // Quick check: if not reachable, return early
  if (!targetNode.reachable) {
    return {
      reachable: false,
      guaranteedToExecute: false,
      paths: [],
      pathConditions: [],
      hasEffectiveGuard: false,
    };
  }

  // Find all paths from entry to target
  const paths = findAllPaths(cfg.entry, targetNode);

  // Extract conditions for each path
  const pathConditions = paths.map((path) => extractPathConditions(path));

  // Check if guaranteed to execute (no conditional branches can skip it)
  const guaranteedToExecute = isGuaranteedToExecute(cfg, targetNode);

  // Analyze guard effectiveness
  const guardAnalysis = analyzeGuards(pathConditions);

  return {
    reachable: true,
    guaranteedToExecute,
    paths,
    pathConditions,
    hasEffectiveGuard: guardAnalysis.isEffective,
    guardAnalysis,
  };
}

/**
 * Analyze whether a setState call will cause an infinite loop.
 */
function analyzeSetStateCall(
  cfg: CFG,
  setStateNode: t.CallExpression,
  stateVariable: string,
  dependencyVariables: string[]
): SetStateAnalysisResult {
  // Find the CFG node for this setState call
  const cfgNode = cfg.astNodeToCFGNode.get(setStateNode);

  if (!cfgNode) {
    return {
      causesInfiniteLoop: false,
      mightCauseInfiniteLoop: false,
      confidence: 'low',
      reachability: {
        reachable: false,
        guaranteedToExecute: false,
        paths: [],
        pathConditions: [],
        hasEffectiveGuard: false,
      },
      explanation: 'Could not find setState call in CFG',
    };
  }

  // Analyze reachability
  const reachability = analyzeReachability(cfg, cfgNode);

  if (!reachability.reachable) {
    return {
      causesInfiniteLoop: false,
      mightCauseInfiniteLoop: false,
      confidence: 'high',
      reachability,
      explanation: 'setState call is unreachable (dead code)',
    };
  }

  // Check if state variable is in dependencies
  const stateInDeps = dependencyVariables.includes(stateVariable);

  if (!stateInDeps) {
    return {
      causesInfiniteLoop: false,
      mightCauseInfiniteLoop: false,
      confidence: 'high',
      reachability,
      explanation: `State variable "${stateVariable}" is not in dependency array`,
    };
  }

  // If guaranteed to execute with state in deps, it's definitely a loop
  if (reachability.guaranteedToExecute) {
    return {
      causesInfiniteLoop: true,
      mightCauseInfiniteLoop: true,
      confidence: 'high',
      reachability,
      explanation: `setState("${stateVariable}") is guaranteed to execute every render because "${stateVariable}" is in the dependency array`,
      suggestedFix: `Add a guard condition to prevent unnecessary state updates, or remove "${stateVariable}" from dependencies`,
    };
  }

  // Check if there's an effective guard
  if (reachability.hasEffectiveGuard && reachability.guardAnalysis) {
    const { guardAnalysis } = reachability;

    if (guardAnalysis.riskLevel === 'safe') {
      return {
        causesInfiniteLoop: false,
        mightCauseInfiniteLoop: false,
        confidence: 'high',
        reachability,
        explanation: `Guard condition prevents infinite loop: ${guardAnalysis.explanation}`,
      };
    }

    if (guardAnalysis.riskLevel === 'risky') {
      return {
        causesInfiniteLoop: false,
        mightCauseInfiniteLoop: true,
        confidence: 'medium',
        reachability,
        explanation: `Guard condition may not prevent infinite loop: ${guardAnalysis.explanation}`,
        suggestedFix: 'Ensure the guard condition reliably prevents the loop',
      };
    }
  }

  // Conditional execution but unclear if safe
  return {
    causesInfiniteLoop: false,
    mightCauseInfiniteLoop: true,
    confidence: 'medium',
    reachability,
    explanation: `setState("${stateVariable}") is conditionally executed with "${stateVariable}" in dependencies`,
    suggestedFix: 'Review the conditions to ensure they prevent infinite re-renders',
  };
}

/**
 * Find all paths from a source node to a target node.
 * Uses DFS with path tracking and cycle detection.
 */
export function findAllPaths(source: CFGNode, target: CFGNode): CFGNode[][] {
  const paths: CFGNode[][] = [];
  const currentPath: CFGNode[] = [];
  const visited = new Set<string>();

  function dfs(node: CFGNode): void {
    // Prevent infinite loops and excessive paths
    if (paths.length >= MAX_PATHS) return;
    if (currentPath.length >= MAX_PATH_LENGTH) return;

    // Cycle detection - don't revisit nodes in current path
    if (visited.has(node.id)) return;

    currentPath.push(node);
    visited.add(node.id);

    if (node === target) {
      paths.push([...currentPath]);
    } else {
      for (const successor of node.successors) {
        dfs(successor);
      }
    }

    currentPath.pop();
    visited.delete(node.id);
  }

  dfs(source);
  return paths;
}

/**
 * Extract the conditions that must hold for a path to execute.
 */
export function extractPathConditions(path: CFGNode[]): PathCondition[] {
  const conditions: PathCondition[] = [];

  for (let i = 0; i < path.length - 1; i++) {
    const node = path[i];
    const next = path[i + 1];

    // Only branch nodes and loop tests have conditions
    if (node.type !== 'branch' && node.type !== 'loop-test') continue;
    if (!node.astNode) continue;

    // Determine which branch was taken
    const isTrueBranch = node.trueSuccessor === next;
    const isFalseBranch = node.falseSuccessor === next;

    if (!isTrueBranch && !isFalseBranch) continue;

    const condition: PathCondition = {
      conditionNode: node.astNode,
      branchTaken: isTrueBranch ? 'true' : 'false',
      parentNode: node.astNode,
      involvesStateVariable: false, // Will be filled in by caller
    };

    conditions.push(condition);
  }

  return conditions;
}

/**
 * Check if a node is guaranteed to execute (dominates the exit).
 *
 * A node is guaranteed to execute if:
 * 1. It's the entry node, OR
 * 2. All paths from entry to exit pass through this node
 *
 * For our purposes, we use a simpler heuristic:
 * - No branch nodes between entry and this node have both successors
 *   that can reach exit without going through this node
 */
export function isGuaranteedToExecute(cfg: CFG, target: CFGNode): boolean {
  // If target is entry, it's guaranteed
  if (target === cfg.entry) return true;

  // Find all paths from entry to exit
  const pathsToExit = findAllPaths(cfg.entry, cfg.exit);

  // Check if target is on all paths
  for (const path of pathsToExit) {
    const containsTarget = path.some((node) => node === target);
    if (!containsTarget) {
      // Found a path that doesn't go through target
      return false;
    }
  }

  return true;
}

/**
 * Analyze conditions to determine guard effectiveness.
 */
export function analyzeGuards(pathConditions: PathCondition[][]): GuardAnalysis {
  // No conditions means guaranteed execution (already handled)
  if (pathConditions.length === 0) {
    return {
      guardType: 'none',
      isEffective: false,
      explanation: 'No path conditions found',
      riskLevel: 'unsafe',
    };
  }

  // Check each path's conditions
  for (const conditions of pathConditions) {
    const analysis = analyzePathGuard(conditions);
    if (analysis.isEffective) {
      return analysis;
    }
  }

  // No effective guards found
  return {
    guardType: 'none',
    isEffective: false,
    explanation: 'No effective guard conditions found on any path',
    riskLevel: 'unsafe',
  };
}

/**
 * Analyze conditions on a single path for guard patterns.
 */
function analyzePathGuard(conditions: PathCondition[]): GuardAnalysis {
  for (const condition of conditions) {
    const node = condition.conditionNode;

    // Early return pattern: if (condition) return;
    // If we're on the false branch of such a check, we passed the guard
    if (condition.branchTaken === 'false') {
      // Check if true branch is a return
      // This would be detected at a higher level
    }

    // Equality guard: if (x !== newValue) setX(newValue)
    if (t.isBinaryExpression(node)) {
      const analysis = analyzeEqualityGuard(node, condition.branchTaken);
      if (analysis) return analysis;
    }

    // Toggle guard: if (!flag) setFlag(true)
    if (t.isUnaryExpression(node) && node.operator === '!') {
      const analysis = analyzeToggleGuard(node, condition.branchTaken);
      if (analysis) return analysis;
    }

    // Simple identifier check: if (flag) ...
    if (t.isIdentifier(node)) {
      // This is a truthy check
      // Whether it's effective depends on what's being set
    }
  }

  return {
    guardType: 'none',
    isEffective: false,
    explanation: 'Could not identify guard pattern',
    riskLevel: 'unsafe',
  };
}

/**
 * Analyze equality guard pattern: if (x !== y) setX(y)
 */
function analyzeEqualityGuard(
  node: t.BinaryExpression,
  branchTaken: 'true' | 'false'
): GuardAnalysis | null {
  const { operator, left, right } = node;

  // Pattern: x !== y (or x != y)
  if (operator === '!==' || operator === '!=') {
    if (branchTaken === 'true') {
      // We're in the "not equal" branch - this is where setState should be
      return {
        guardType: 'equality-guard',
        isEffective: true,
        guardCondition: node,
        explanation: 'Equality guard ensures setState only runs when value differs',
        riskLevel: 'safe',
      };
    }
  }

  // Pattern: x === y (or x == y) with false branch
  if (operator === '===' || operator === '==') {
    if (branchTaken === 'false') {
      // We're in the "not equal" branch
      return {
        guardType: 'equality-guard',
        isEffective: true,
        guardCondition: node,
        explanation: 'Equality guard (inverted) ensures setState only runs when value differs',
        riskLevel: 'safe',
      };
    }
  }

  // Check for object property comparison (risky with spreads)
  if (t.isMemberExpression(left) || t.isMemberExpression(right)) {
    // This might be comparing a property like user.id !== 5
    // But if setState does { ...user, id: 5 }, it creates a new object
    return {
      guardType: 'equality-guard',
      isEffective: false,
      guardCondition: node,
      explanation:
        'Property comparison guard may not prevent loops if object spread creates new reference',
      riskLevel: 'risky',
    };
  }

  return null;
}

/**
 * Analyze toggle guard pattern: if (!flag) setFlag(true)
 */
function analyzeToggleGuard(
  node: t.UnaryExpression,
  branchTaken: 'true' | 'false'
): GuardAnalysis | null {
  if (node.operator !== '!') return null;

  // Pattern: if (!flag) - we're checking for falsy value
  if (branchTaken === 'true') {
    // We entered the "flag is falsy" branch
    // If we setFlag(true), next render flag will be truthy and we won't enter
    return {
      guardType: 'toggle-guard',
      isEffective: true,
      guardCondition: node,
      explanation: 'Toggle guard prevents re-execution after state is set',
      riskLevel: 'safe',
    };
  }

  return null;
}

/**
 * Check if a condition involves a specific variable.
 */
export function conditionInvolvesVariable(condition: t.Node, variableName: string): boolean {
  let found = false;

  function visit(node: t.Node | null | undefined): void {
    if (!node || found) return;

    if (t.isIdentifier(node) && node.name === variableName) {
      found = true;
      return;
    }

    // Traverse child nodes
    for (const key of Object.keys(node)) {
      const value = (node as unknown as Record<string, unknown>)[key];
      if (value && typeof value === 'object') {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item && typeof item === 'object' && 'type' in item) {
              visit(item as t.Node);
            }
          }
        } else if ('type' in value) {
          visit(value as t.Node);
        }
      }
    }
  }

  visit(condition);
  return found;
}

/**
 * Enrich path conditions with state variable information.
 */
function enrichPathConditions(
  conditions: PathCondition[],
  stateVariables: string[]
): PathCondition[] {
  return conditions.map((condition) => {
    for (const stateVar of stateVariables) {
      if (conditionInvolvesVariable(condition.conditionNode, stateVar)) {
        return {
          ...condition,
          involvesStateVariable: true,
        };
      }
    }
    return condition;
  });
}

/**
 * Compute dominators for all nodes in the CFG.
 * A node D dominates node N if every path from entry to N goes through D.
 *
 * Returns a Map where dominators.get(nodeId) is the set of node IDs that dominate it.
 */
export function computeDominators(cfg: CFG): Map<string, Set<string>> {
  const dominators = new Map<string, Set<string>>();
  const allNodeIds = new Set(cfg.nodes.keys());

  // Initialize: entry dominates itself, others dominated by all
  for (const [id] of cfg.nodes) {
    if (id === cfg.entry.id) {
      dominators.set(id, new Set([id]));
    } else {
      dominators.set(id, new Set(allNodeIds));
    }
  }

  // Iterate until fixed point
  let changed = true;
  while (changed) {
    changed = false;

    for (const [id, node] of cfg.nodes) {
      if (id === cfg.entry.id) continue;

      // New dominators = intersection of predecessors' dominators + self
      let newDoms: Set<string> | null = null;

      for (const pred of node.predecessors) {
        const predDoms = dominators.get(pred.id);
        if (!predDoms) continue;

        if (newDoms === null) {
          newDoms = new Set(predDoms);
        } else {
          // Intersection
          for (const d of newDoms) {
            if (!predDoms.has(d)) {
              newDoms.delete(d);
            }
          }
        }
      }

      if (newDoms === null) {
        newDoms = new Set();
      }
      newDoms.add(id);

      const oldDoms = dominators.get(id)!;
      if (newDoms.size !== oldDoms.size) {
        changed = true;
        dominators.set(id, newDoms);
      } else {
        for (const d of newDoms) {
          if (!oldDoms.has(d)) {
            changed = true;
            dominators.set(id, newDoms);
            break;
          }
        }
      }
    }
  }

  return dominators;
}

/**
 * Check if node A dominates node B.
 */
function dominates(
  cfg: CFG,
  a: CFGNode,
  b: CFGNode,
  dominators?: Map<string, Set<string>>
): boolean {
  const doms = dominators ?? computeDominators(cfg);
  const bDominators = doms.get(b.id);
  return bDominators?.has(a.id) ?? false;
}
