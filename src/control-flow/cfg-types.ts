/**
 * Control Flow Graph (CFG) types for analyzing code execution paths.
 *
 * A CFG represents all possible execution paths through a function or block.
 * Each node represents a statement or expression, and edges represent the
 * flow of control between them.
 */

import type * as t from '@babel/types';

/**
 * Types of CFG nodes that represent different control flow constructs.
 */
export type CFGNodeType =
  | 'entry' // Function/block entry point
  | 'exit' // Function/block exit point (normal termination)
  | 'statement' // Regular statement (expression, declaration, etc.)
  | 'branch' // Conditional branch point (if condition, ternary, switch discriminant)
  | 'loop-test' // Loop condition test (while condition, for condition)
  | 'loop-update' // Loop update expression (for update)
  | 'try' // Try block entry
  | 'catch' // Catch block entry
  | 'finally' // Finally block entry
  | 'throw' // Throw statement (connects to catch or exit)
  | 'return' // Return statement (connects to finally or exit)
  | 'break' // Break statement (connects to loop exit or switch exit)
  | 'continue' // Continue statement (connects to loop test)
  | 'merge'; // Merge point where branches rejoin

/**
 * A node in the Control Flow Graph.
 */
export interface CFGNode {
  /** Unique identifier for this node */
  id: string;

  /** The type of control flow construct this node represents */
  type: CFGNodeType;

  /** The AST node this CFG node corresponds to (null for synthetic nodes like entry/exit/merge) */
  astNode: t.Node | null;

  /** Human-readable label for debugging/visualization */
  label: string;

  /** Predecessor nodes (nodes that can transfer control to this node) */
  predecessors: CFGNode[];

  /** Successor nodes (nodes that can receive control from this node) */
  successors: CFGNode[];

  /**
   * Whether this node is reachable from the entry node.
   * Nodes after unconditional return/throw are unreachable.
   */
  reachable: boolean;

  /**
   * For branch nodes: the successor taken when condition is true.
   * For loop-test nodes: the loop body.
   */
  trueSuccessor?: CFGNode;

  /**
   * For branch nodes: the successor taken when condition is false.
   * For loop-test nodes: the node after the loop.
   */
  falseSuccessor?: CFGNode;

  /**
   * For break/continue: the target label (if labeled statement).
   */
  targetLabel?: string;

  /**
   * Source location for error reporting.
   */
  loc?: {
    line: number;
    column: number;
  };
}

/**
 * A complete Control Flow Graph for a function or block.
 */
export interface CFG {
  /** The entry node (first node executed) */
  entry: CFGNode;

  /** The exit node (normal termination point) */
  exit: CFGNode;

  /** All nodes in the graph, keyed by ID */
  nodes: Map<string, CFGNode>;

  /** Map from AST nodes to their corresponding CFG nodes */
  astNodeToCFGNode: Map<t.Node, CFGNode>;

  /**
   * Exception exit node - where uncaught exceptions go.
   * This is separate from the normal exit.
   */
  exceptionExit?: CFGNode;
}

/**
 * Result of analyzing whether a node is reachable and under what conditions.
 */
export interface ReachabilityResult {
  /** Whether the node is reachable at all */
  reachable: boolean;

  /**
   * Whether the node is guaranteed to execute (no conditional branches
   * or early returns can prevent it from executing).
   */
  guaranteedToExecute: boolean;

  /**
   * All paths from entry to this node.
   * Each path is a sequence of CFG nodes.
   */
  paths: CFGNode[][];

  /**
   * Conditions that must hold for each path.
   */
  pathConditions: PathCondition[][];

  /**
   * Whether any path has an effective guard that prevents infinite loops.
   */
  hasEffectiveGuard: boolean;

  /**
   * Details about detected guards.
   */
  guardAnalysis?: GuardAnalysis;
}

/**
 * A condition that must be true/false for a particular path to execute.
 */
export interface PathCondition {
  /** The condition AST node (e.g., the test of an if statement) */
  conditionNode: t.Node;

  /** Whether this condition must be true or false for this path */
  branchTaken: 'true' | 'false';

  /** The AST node that contains this condition (if statement, while loop, etc.) */
  parentNode: t.Node;

  /**
   * Whether this condition involves the state variable we're analyzing.
   * This is important for detecting guards like `if (x !== prevX)`.
   */
  involvesStateVariable: boolean;

  /**
   * If the condition involves a comparison with the state variable,
   * what is it being compared to?
   */
  comparedTo?: {
    type: 'identifier' | 'literal' | 'expression';
    value?: string | number | boolean;
    node: t.Node;
  };
}

/**
 * Analysis of guard conditions that may prevent infinite loops.
 */
export interface GuardAnalysis {
  /** Type of guard detected */
  guardType:
    | 'equality-guard' // if (x !== newValue) setX(newValue)
    | 'toggle-guard' // if (!flag) setFlag(true)
    | 'early-return' // if (x === prevX) return;
    | 'conditional-set' // General conditional with state check
    | 'none';

  /** Whether the guard is effective at preventing infinite loops */
  isEffective: boolean;

  /** The condition node that acts as a guard */
  guardCondition?: t.Node;

  /** Explanation of why the guard is/isn't effective */
  explanation: string;

  /**
   * Risk level if the guard might not be effective.
   * - 'safe': Guard definitely prevents loops
   * - 'risky': Guard might not prevent loops (e.g., object spread)
   * - 'unsafe': Guard does not prevent loops
   */
  riskLevel: 'safe' | 'risky' | 'unsafe';
}

/**
 * Edge in the CFG representing control flow between nodes.
 * This is an implicit structure - edges are represented by
 * predecessors/successors arrays in CFGNode.
 */
interface CFGEdge {
  /** Source node */
  from: CFGNode;

  /** Target node */
  to: CFGNode;

  /** Type of edge */
  type: CFGEdgeType;

  /** For conditional edges, which branch (true/false) */
  branch?: 'true' | 'false';

  /** For exception edges, the exception type if known */
  exceptionType?: string;
}

/**
 * Types of edges in the CFG.
 */
export type CFGEdgeType =
  | 'sequential' // Normal sequential flow
  | 'conditional-true' // True branch of conditional
  | 'conditional-false' // False branch of conditional
  | 'loop-back' // Back edge in a loop
  | 'loop-exit' // Exit edge from a loop
  | 'break' // Break statement edge
  | 'continue' // Continue statement edge
  | 'return' // Return statement edge
  | 'throw' // Throw statement edge
  | 'exception' // Implicit exception edge (any statement can throw)
  | 'finally-normal' // Normal entry to finally block
  | 'finally-exception'; // Exception entry to finally block

/**
 * Options for building a CFG.
 */
export interface CFGBuilderOptions {
  /**
   * Whether to include implicit exception edges.
   * If true, any statement that could throw will have an edge to the
   * nearest catch block or exception exit.
   * Default: false (for performance; we mainly care about explicit control flow)
   */
  includeExceptionEdges?: boolean;

  /**
   * Whether to track detailed source locations.
   * Default: true
   */
  trackSourceLocations?: boolean;

  /**
   * Whether to include unreachable nodes in the graph.
   * If false, unreachable nodes are still created but marked as such.
   * Default: true
   */
  includeUnreachableNodes?: boolean;
}

/**
 * Context maintained while building the CFG.
 * Tracks the current state of loop/try stacks for handling
 * break/continue/return/throw.
 */
export interface CFGBuilderContext {
  /** Stack of active loops for break/continue handling */
  loopStack: LoopContext[];

  /** Stack of active try statements for exception handling */
  tryStack: TryContext[];

  /** Stack of active switch statements for break handling */
  switchStack: SwitchContext[];

  /** Current finally blocks that must be executed before returning */
  finallyStack: CFGNode[];

  /** Map of labels to their target contexts */
  labelMap: Map<string, LoopContext | SwitchContext>;
}

/**
 * Context for a loop construct (for, while, do-while, for-in, for-of).
 */
export interface LoopContext {
  /** The loop test node (continue target) */
  testNode: CFGNode;

  /** The node after the loop (break target) */
  exitNode: CFGNode;

  /** Optional label for the loop */
  label?: string;

  /** Type of loop */
  type: 'for' | 'while' | 'do-while' | 'for-in' | 'for-of';
}

/**
 * Context for a try statement.
 */
export interface TryContext {
  /** The catch block entry (if present) */
  catchNode?: CFGNode;

  /** The finally block entry (if present) */
  finallyNode?: CFGNode;

  /** The node after the entire try statement */
  afterNode: CFGNode;
}

/**
 * Context for a switch statement.
 */
export interface SwitchContext {
  /** The node after the switch (break target) */
  exitNode: CFGNode;

  /** Optional label for the switch */
  label?: string;
}

/**
 * Result of checking if a setState call causes an infinite loop.
 */
export interface SetStateAnalysisResult {
  /** Whether this setState definitely causes an infinite loop */
  causesInfiniteLoop: boolean;

  /** Whether this setState might cause an infinite loop under some conditions */
  mightCauseInfiniteLoop: boolean;

  /** Confidence level of the analysis */
  confidence: 'high' | 'medium' | 'low';

  /** Reachability analysis for the setState call */
  reachability: ReachabilityResult;

  /** Explanation of the analysis */
  explanation: string;

  /** Suggested fix if there's an issue */
  suggestedFix?: string;
}
