/**
 * CFG Builder - Constructs a Control Flow Graph from a Babel AST.
 *
 * This builder creates a CFG that represents all possible execution paths
 * through a function or block. It handles:
 * - Sequential statements
 * - Conditional branches (if/else, ternary, switch)
 * - Loops (for, while, do-while, for-in, for-of)
 * - Exception handling (try-catch-finally)
 * - Control flow jumps (break, continue, return, throw)
 * - Short-circuit operators (&&, ||, ??)
 */

import * as t from '@babel/types';
import type {
  CFG,
  CFGNode,
  CFGNodeType,
  CFGBuilderOptions,
  CFGBuilderContext,
  LoopContext,
  TryContext,
  SwitchContext,
} from './cfg-types';

/**
 * Build a Control Flow Graph from a function body or block statement.
 */
export function buildCFG(
  body: t.BlockStatement | t.Expression,
  options: CFGBuilderOptions = {}
): CFG {
  const builder = new CFGBuilder(options);
  return builder.build(body);
}

/**
 * CFG Builder class that maintains state during graph construction.
 */
class CFGBuilder {
  private nodeIdCounter = 0;
  private nodes: Map<string, CFGNode> = new Map();
  private astNodeToCFGNode: Map<t.Node, CFGNode> = new Map();
  private options: CFGBuilderOptions;

  // Context for handling control flow jumps
  private context: CFGBuilderContext = {
    loopStack: [],
    tryStack: [],
    switchStack: [],
    finallyStack: [],
    labelMap: new Map(),
  };

  constructor(options: CFGBuilderOptions = {}) {
    this.options = {
      includeExceptionEdges: false,
      trackSourceLocations: true,
      includeUnreachableNodes: true,
      ...options,
    };
  }

  /**
   * Build the CFG from the given body.
   */
  build(body: t.BlockStatement | t.Expression): CFG {
    const entry = this.createNode('entry', null, 'entry');
    const exit = this.createNode('exit', null, 'exit');

    // Process the body starting from entry
    let current = entry;

    if (t.isBlockStatement(body)) {
      current = this.processBlock(body, current, exit);
    } else {
      // Expression body (arrow function with implicit return)
      current = this.processExpression(body, current);
    }

    // Connect final node to exit if not already connected
    if (current !== exit && !this.hasPathToExit(current, exit)) {
      this.connect(current, exit);
    }

    // Mark reachability
    this.markReachability(entry);

    return {
      entry,
      exit,
      nodes: this.nodes,
      astNodeToCFGNode: this.astNodeToCFGNode,
    };
  }

  /**
   * Create a new CFG node.
   */
  private createNode(
    type: CFGNodeType,
    astNode: t.Node | null,
    label: string
  ): CFGNode {
    const id = `node_${this.nodeIdCounter++}`;
    const node: CFGNode = {
      id,
      type,
      astNode,
      label,
      predecessors: [],
      successors: [],
      reachable: false,
    };

    if (
      astNode &&
      this.options.trackSourceLocations &&
      astNode.loc?.start
    ) {
      node.loc = {
        line: astNode.loc.start.line,
        column: astNode.loc.start.column,
      };
    }

    this.nodes.set(id, node);
    if (astNode) {
      this.astNodeToCFGNode.set(astNode, node);
    }

    return node;
  }

  /**
   * Connect two nodes with a directed edge.
   */
  private connect(from: CFGNode, to: CFGNode): void {
    if (!from.successors.includes(to)) {
      from.successors.push(to);
    }
    if (!to.predecessors.includes(from)) {
      to.predecessors.push(from);
    }
  }

  /**
   * Check if there's already a path from node to target.
   */
  private hasPathToExit(node: CFGNode, exit: CFGNode): boolean {
    const visited = new Set<string>();
    const queue = [node];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === exit) return true;
      if (visited.has(current.id)) continue;
      visited.add(current.id);
      queue.push(...current.successors);
    }

    return false;
  }

  /**
   * Mark nodes as reachable starting from entry.
   */
  private markReachability(entry: CFGNode): void {
    const visited = new Set<string>();
    const queue = [entry];

    while (queue.length > 0) {
      const node = queue.shift()!;
      if (visited.has(node.id)) continue;
      visited.add(node.id);
      node.reachable = true;
      queue.push(...node.successors);
    }
  }

  /**
   * Process a block statement (list of statements).
   * Returns the last node after processing all statements.
   */
  private processBlock(
    block: t.BlockStatement,
    current: CFGNode,
    exitNode: CFGNode
  ): CFGNode {
    for (const stmt of block.body) {
      current = this.processStatement(stmt, current, exitNode);

      // If we hit a terminator (return, throw, break, continue),
      // remaining statements are unreachable
      if (this.isTerminator(current)) {
        break;
      }
    }
    return current;
  }

  /**
   * Check if a node is a terminator (no fall-through).
   */
  private isTerminator(node: CFGNode): boolean {
    return (
      node.type === 'return' ||
      node.type === 'throw' ||
      node.type === 'break' ||
      node.type === 'continue'
    );
  }

  /**
   * Process a single statement.
   */
  private processStatement(
    stmt: t.Statement,
    current: CFGNode,
    exitNode: CFGNode
  ): CFGNode {
    // Handle labeled statements
    if (t.isLabeledStatement(stmt)) {
      return this.processLabeledStatement(stmt, current, exitNode);
    }

    if (t.isIfStatement(stmt)) {
      return this.processIfStatement(stmt, current, exitNode);
    }

    if (t.isWhileStatement(stmt)) {
      return this.processWhileStatement(stmt, current, exitNode);
    }

    if (t.isDoWhileStatement(stmt)) {
      return this.processDoWhileStatement(stmt, current, exitNode);
    }

    if (t.isForStatement(stmt)) {
      return this.processForStatement(stmt, current, exitNode);
    }

    if (t.isForInStatement(stmt) || t.isForOfStatement(stmt)) {
      return this.processForInOfStatement(stmt, current, exitNode);
    }

    if (t.isSwitchStatement(stmt)) {
      return this.processSwitchStatement(stmt, current, exitNode);
    }

    if (t.isTryStatement(stmt)) {
      return this.processTryStatement(stmt, current, exitNode);
    }

    if (t.isReturnStatement(stmt)) {
      return this.processReturnStatement(stmt, current, exitNode);
    }

    if (t.isThrowStatement(stmt)) {
      return this.processThrowStatement(stmt, current, exitNode);
    }

    if (t.isBreakStatement(stmt)) {
      return this.processBreakStatement(stmt, current);
    }

    if (t.isContinueStatement(stmt)) {
      return this.processContinueStatement(stmt, current);
    }

    if (t.isBlockStatement(stmt)) {
      return this.processBlock(stmt, current, exitNode);
    }

    if (t.isEmptyStatement(stmt)) {
      return current; // No-op
    }

    if (t.isExpressionStatement(stmt)) {
      return this.processExpressionStatement(stmt, current);
    }

    if (t.isVariableDeclaration(stmt)) {
      return this.processVariableDeclaration(stmt, current);
    }

    if (t.isFunctionDeclaration(stmt)) {
      // Function declarations are hoisted; they don't affect control flow
      // But we still create a node for them for completeness
      const node = this.createNode(
        'statement',
        stmt,
        `function ${stmt.id?.name || 'anonymous'}`
      );
      this.connect(current, node);
      return node;
    }

    // Default: treat as a simple statement
    const node = this.createNode(
      'statement',
      stmt,
      this.getStatementLabel(stmt)
    );
    this.connect(current, node);
    return node;
  }

  /**
   * Process an if statement.
   */
  private processIfStatement(
    stmt: t.IfStatement,
    current: CFGNode,
    exitNode: CFGNode
  ): CFGNode {
    // Create branch node for the condition
    const branchNode = this.createNode(
      'branch',
      stmt.test,
      `if (${this.getExpressionLabel(stmt.test)})`
    );
    this.connect(current, branchNode);

    // Create merge node for after the if statement
    const mergeNode = this.createNode('merge', null, 'merge');

    // Process true branch (consequent)
    let trueEnd: CFGNode;
    if (t.isBlockStatement(stmt.consequent)) {
      const trueStart = this.createNode('statement', null, 'then');
      this.connect(branchNode, trueStart);
      branchNode.trueSuccessor = trueStart;
      trueEnd = this.processBlock(stmt.consequent, trueStart, exitNode);
    } else {
      trueEnd = this.processStatement(stmt.consequent, branchNode, exitNode);
      branchNode.trueSuccessor = trueEnd;
    }

    // Connect true branch to merge if it doesn't terminate
    if (!this.isTerminator(trueEnd)) {
      this.connect(trueEnd, mergeNode);
    }

    // Process false branch (alternate) if present
    if (stmt.alternate) {
      let falseEnd: CFGNode;
      if (t.isBlockStatement(stmt.alternate)) {
        const falseStart = this.createNode('statement', null, 'else');
        this.connect(branchNode, falseStart);
        branchNode.falseSuccessor = falseStart;
        falseEnd = this.processBlock(stmt.alternate, falseStart, exitNode);
      } else {
        falseEnd = this.processStatement(stmt.alternate, branchNode, exitNode);
        branchNode.falseSuccessor = falseEnd;
      }

      // Connect false branch to merge if it doesn't terminate
      if (!this.isTerminator(falseEnd)) {
        this.connect(falseEnd, mergeNode);
      }
    } else {
      // No else branch - connect directly to merge
      branchNode.falseSuccessor = mergeNode;
      this.connect(branchNode, mergeNode);
    }

    // If both branches terminate, the merge node is unreachable
    // but we still return it for consistency
    return mergeNode;
  }

  /**
   * Process a while statement.
   */
  private processWhileStatement(
    stmt: t.WhileStatement,
    current: CFGNode,
    exitNode: CFGNode
  ): CFGNode {
    // Create test node
    const testNode = this.createNode(
      'loop-test',
      stmt.test,
      `while (${this.getExpressionLabel(stmt.test)})`
    );
    this.connect(current, testNode);

    // Create exit node for after the loop
    const loopExitNode = this.createNode('merge', null, 'loop-exit');

    // Push loop context
    const loopContext: LoopContext = {
      testNode,
      exitNode: loopExitNode,
      type: 'while',
    };
    this.context.loopStack.push(loopContext);

    // Process body
    let bodyEnd: CFGNode;
    if (t.isBlockStatement(stmt.body)) {
      const bodyStart = this.createNode('statement', null, 'loop-body');
      testNode.trueSuccessor = bodyStart;
      this.connect(testNode, bodyStart);
      bodyEnd = this.processBlock(stmt.body, bodyStart, exitNode);
    } else {
      bodyEnd = this.processStatement(stmt.body, testNode, exitNode);
      testNode.trueSuccessor = bodyEnd;
    }

    // Connect body end back to test (unless it terminates)
    if (!this.isTerminator(bodyEnd)) {
      this.connect(bodyEnd, testNode);
    }

    // False branch goes to exit
    testNode.falseSuccessor = loopExitNode;
    this.connect(testNode, loopExitNode);

    // Pop loop context
    this.context.loopStack.pop();

    return loopExitNode;
  }

  /**
   * Process a do-while statement.
   */
  private processDoWhileStatement(
    stmt: t.DoWhileStatement,
    current: CFGNode,
    exitNode: CFGNode
  ): CFGNode {
    // Create body entry node
    const bodyEntryNode = this.createNode('statement', null, 'do');
    this.connect(current, bodyEntryNode);

    // Create test node
    const testNode = this.createNode(
      'loop-test',
      stmt.test,
      `while (${this.getExpressionLabel(stmt.test)})`
    );

    // Create exit node
    const loopExitNode = this.createNode('merge', null, 'loop-exit');

    // Push loop context (continue goes to test in do-while)
    const loopContext: LoopContext = {
      testNode,
      exitNode: loopExitNode,
      type: 'do-while',
    };
    this.context.loopStack.push(loopContext);

    // Process body
    let bodyEnd: CFGNode;
    if (t.isBlockStatement(stmt.body)) {
      bodyEnd = this.processBlock(stmt.body, bodyEntryNode, exitNode);
    } else {
      bodyEnd = this.processStatement(stmt.body, bodyEntryNode, exitNode);
    }

    // Connect body to test (unless it terminates)
    if (!this.isTerminator(bodyEnd)) {
      this.connect(bodyEnd, testNode);
    }

    // True branch loops back to body
    testNode.trueSuccessor = bodyEntryNode;
    this.connect(testNode, bodyEntryNode);

    // False branch exits
    testNode.falseSuccessor = loopExitNode;
    this.connect(testNode, loopExitNode);

    // Pop loop context
    this.context.loopStack.pop();

    return loopExitNode;
  }

  /**
   * Process a for statement.
   */
  private processForStatement(
    stmt: t.ForStatement,
    current: CFGNode,
    exitNode: CFGNode
  ): CFGNode {
    // Process init
    if (stmt.init) {
      if (t.isVariableDeclaration(stmt.init)) {
        current = this.processVariableDeclaration(stmt.init, current);
      } else {
        current = this.processExpression(stmt.init, current);
      }
    }

    // Create test node (or synthetic always-true if no test)
    const testNode = stmt.test
      ? this.createNode(
          'loop-test',
          stmt.test,
          `for-test (${this.getExpressionLabel(stmt.test)})`
        )
      : this.createNode('loop-test', null, 'for-test (true)');
    this.connect(current, testNode);

    // Create update node if present
    const updateNode = stmt.update
      ? this.createNode(
          'loop-update',
          stmt.update,
          `for-update (${this.getExpressionLabel(stmt.update)})`
        )
      : null;

    // Create exit node
    const loopExitNode = this.createNode('merge', null, 'loop-exit');

    // Push loop context (continue goes to update, then test)
    const loopContext: LoopContext = {
      testNode: updateNode || testNode,
      exitNode: loopExitNode,
      type: 'for',
    };
    this.context.loopStack.push(loopContext);

    // Process body
    let bodyEnd: CFGNode;
    if (t.isBlockStatement(stmt.body)) {
      const bodyStart = this.createNode('statement', null, 'for-body');
      testNode.trueSuccessor = bodyStart;
      this.connect(testNode, bodyStart);
      bodyEnd = this.processBlock(stmt.body, bodyStart, exitNode);
    } else {
      bodyEnd = this.processStatement(stmt.body, testNode, exitNode);
      testNode.trueSuccessor = bodyEnd;
    }

    // Connect body to update (or test if no update)
    if (!this.isTerminator(bodyEnd)) {
      if (updateNode) {
        this.connect(bodyEnd, updateNode);
        this.connect(updateNode, testNode);
      } else {
        this.connect(bodyEnd, testNode);
      }
    }

    // False branch (or no test) exits
    testNode.falseSuccessor = loopExitNode;
    this.connect(testNode, loopExitNode);

    // Pop loop context
    this.context.loopStack.pop();

    return loopExitNode;
  }

  /**
   * Process for-in or for-of statement.
   */
  private processForInOfStatement(
    stmt: t.ForInStatement | t.ForOfStatement,
    current: CFGNode,
    exitNode: CFGNode
  ): CFGNode {
    const loopType = t.isForInStatement(stmt) ? 'for-in' : 'for-of';

    // Create implicit test node (checks if more items)
    const testNode = this.createNode(
      'loop-test',
      stmt.right,
      `${loopType} (${this.getExpressionLabel(stmt.right)})`
    );
    this.connect(current, testNode);

    // Create exit node
    const loopExitNode = this.createNode('merge', null, 'loop-exit');

    // Push loop context
    const loopContext: LoopContext = {
      testNode,
      exitNode: loopExitNode,
      type: loopType as 'for-in' | 'for-of',
    };
    this.context.loopStack.push(loopContext);

    // Process left (variable declaration or assignment)
    let bodyStart: CFGNode;
    if (t.isVariableDeclaration(stmt.left)) {
      bodyStart = this.createNode(
        'statement',
        stmt.left,
        this.getStatementLabel(stmt.left)
      );
    } else {
      bodyStart = this.createNode(
        'statement',
        stmt.left,
        this.getExpressionLabel(stmt.left as t.LVal)
      );
    }
    testNode.trueSuccessor = bodyStart;
    this.connect(testNode, bodyStart);

    // Process body
    let bodyEnd: CFGNode;
    if (t.isBlockStatement(stmt.body)) {
      bodyEnd = this.processBlock(stmt.body, bodyStart, exitNode);
    } else {
      bodyEnd = this.processStatement(stmt.body, bodyStart, exitNode);
    }

    // Connect body back to test
    if (!this.isTerminator(bodyEnd)) {
      this.connect(bodyEnd, testNode);
    }

    // No more items - exit
    testNode.falseSuccessor = loopExitNode;
    this.connect(testNode, loopExitNode);

    // Pop loop context
    this.context.loopStack.pop();

    return loopExitNode;
  }

  /**
   * Process a switch statement.
   */
  private processSwitchStatement(
    stmt: t.SwitchStatement,
    current: CFGNode,
    exitNode: CFGNode
  ): CFGNode {
    // Create discriminant node
    const discriminantNode = this.createNode(
      'branch',
      stmt.discriminant,
      `switch (${this.getExpressionLabel(stmt.discriminant)})`
    );
    this.connect(current, discriminantNode);

    // Create exit node
    const switchExitNode = this.createNode('merge', null, 'switch-exit');

    // Push switch context
    const switchContext: SwitchContext = {
      exitNode: switchExitNode,
    };
    this.context.switchStack.push(switchContext);

    let previousCaseEnd: CFGNode | null = null;
    let hasDefault = false;

    for (const caseClause of stmt.cases) {
      // Create case node
      const caseLabel = caseClause.test
        ? `case ${this.getExpressionLabel(caseClause.test)}`
        : 'default';
      const caseNode = this.createNode('statement', caseClause, caseLabel);

      if (caseClause.test === null) {
        hasDefault = true;
      }

      // Connect from discriminant
      this.connect(discriminantNode, caseNode);

      // Connect from previous case if it fell through
      if (previousCaseEnd && !this.isTerminator(previousCaseEnd)) {
        this.connect(previousCaseEnd, caseNode);
      }

      // Process case body
      let caseEnd = caseNode;
      for (const bodyStmt of caseClause.consequent) {
        caseEnd = this.processStatement(bodyStmt, caseEnd, exitNode);
        if (this.isTerminator(caseEnd)) break;
      }

      previousCaseEnd = caseEnd;
    }

    // Connect last case to exit if it doesn't terminate
    if (previousCaseEnd && !this.isTerminator(previousCaseEnd)) {
      this.connect(previousCaseEnd, switchExitNode);
    }

    // If no default case, discriminant can fall through to exit
    if (!hasDefault) {
      this.connect(discriminantNode, switchExitNode);
    }

    // Pop switch context
    this.context.switchStack.pop();

    return switchExitNode;
  }

  /**
   * Process a try statement.
   */
  private processTryStatement(
    stmt: t.TryStatement,
    current: CFGNode,
    exitNode: CFGNode
  ): CFGNode {
    // Create try entry node
    const tryNode = this.createNode('try', stmt, 'try');
    this.connect(current, tryNode);

    // Create after node (where control goes after try-catch-finally)
    const afterNode = this.createNode('merge', null, 'try-exit');

    // Create catch node if present
    let catchNode: CFGNode | undefined;
    if (stmt.handler) {
      const paramName = stmt.handler.param
        ? t.isIdentifier(stmt.handler.param)
          ? stmt.handler.param.name
          : 'error'
        : '';
      catchNode = this.createNode(
        'catch',
        stmt.handler,
        `catch (${paramName})`
      );
    }

    // Create finally node if present
    let finallyNode: CFGNode | undefined;
    if (stmt.finalizer) {
      finallyNode = this.createNode('finally', stmt.finalizer, 'finally');
    }

    // Push try context
    const tryContext: TryContext = {
      catchNode,
      finallyNode,
      afterNode,
    };
    this.context.tryStack.push(tryContext);

    // If there's a finally, push it to the finally stack
    if (finallyNode) {
      this.context.finallyStack.push(finallyNode);
    }

    // Process try block
    const tryEnd = this.processBlock(stmt.block, tryNode, exitNode);

    // Connect try end to finally or after
    if (!this.isTerminator(tryEnd)) {
      if (finallyNode) {
        this.connect(tryEnd, finallyNode);
      } else {
        this.connect(tryEnd, afterNode);
      }
    }

    // Process catch block if present
    if (stmt.handler && catchNode) {
      const catchEnd = this.processBlock(stmt.handler.body, catchNode, exitNode);

      // Connect catch end to finally or after
      if (!this.isTerminator(catchEnd)) {
        if (finallyNode) {
          this.connect(catchEnd, finallyNode);
        } else {
          this.connect(catchEnd, afterNode);
        }
      }
    }

    // Process finally block if present
    if (stmt.finalizer && finallyNode) {
      const finallyEnd = this.processBlock(stmt.finalizer, finallyNode, exitNode);

      // Finally always goes to after (unless it terminates)
      if (!this.isTerminator(finallyEnd)) {
        this.connect(finallyEnd, afterNode);
      }
    }

    // Pop finally from stack
    if (finallyNode) {
      this.context.finallyStack.pop();
    }

    // Pop try context
    this.context.tryStack.pop();

    return afterNode;
  }

  /**
   * Process a return statement.
   */
  private processReturnStatement(
    stmt: t.ReturnStatement,
    current: CFGNode,
    exitNode: CFGNode
  ): CFGNode {
    const label = stmt.argument
      ? `return ${this.getExpressionLabel(stmt.argument)}`
      : 'return';
    const returnNode = this.createNode('return', stmt, label);
    this.connect(current, returnNode);

    // If there are finally blocks, connect to them
    if (this.context.finallyStack.length > 0) {
      const finallyNode =
        this.context.finallyStack[this.context.finallyStack.length - 1];
      this.connect(returnNode, finallyNode);
    } else {
      // Connect directly to exit
      this.connect(returnNode, exitNode);
    }

    return returnNode;
  }

  /**
   * Process a throw statement.
   */
  private processThrowStatement(
    stmt: t.ThrowStatement,
    current: CFGNode,
    exitNode: CFGNode
  ): CFGNode {
    const throwNode = this.createNode(
      'throw',
      stmt,
      `throw ${this.getExpressionLabel(stmt.argument)}`
    );
    this.connect(current, throwNode);

    // Find the nearest catch block
    for (let i = this.context.tryStack.length - 1; i >= 0; i--) {
      const tryCtx = this.context.tryStack[i];
      if (tryCtx.catchNode) {
        this.connect(throwNode, tryCtx.catchNode);
        return throwNode;
      }
      // If there's a finally without catch, connect to finally
      if (tryCtx.finallyNode) {
        this.connect(throwNode, tryCtx.finallyNode);
        return throwNode;
      }
    }

    // No catch - goes to exception exit (or regular exit for simplicity)
    this.connect(throwNode, exitNode);
    return throwNode;
  }

  /**
   * Process a break statement.
   */
  private processBreakStatement(
    stmt: t.BreakStatement,
    current: CFGNode
  ): CFGNode {
    const label = stmt.label ? stmt.label.name : undefined;
    const breakNode = this.createNode(
      'break',
      stmt,
      label ? `break ${label}` : 'break'
    );
    breakNode.targetLabel = label;
    this.connect(current, breakNode);

    // Find target (labeled or nearest loop/switch)
    if (label) {
      const target = this.context.labelMap.get(label);
      if (target) {
        this.connect(breakNode, target.exitNode);
      }
    } else {
      // Break from nearest loop or switch
      const loopCtx = this.context.loopStack[this.context.loopStack.length - 1];
      const switchCtx =
        this.context.switchStack[this.context.switchStack.length - 1];

      // Use whichever is more recent (on top of their respective stacks)
      if (loopCtx && (!switchCtx || loopCtx.exitNode)) {
        this.connect(breakNode, loopCtx.exitNode);
      } else if (switchCtx) {
        this.connect(breakNode, switchCtx.exitNode);
      }
    }

    return breakNode;
  }

  /**
   * Process a continue statement.
   */
  private processContinueStatement(
    stmt: t.ContinueStatement,
    current: CFGNode
  ): CFGNode {
    const label = stmt.label ? stmt.label.name : undefined;
    const continueNode = this.createNode(
      'continue',
      stmt,
      label ? `continue ${label}` : 'continue'
    );
    continueNode.targetLabel = label;
    this.connect(current, continueNode);

    // Find target loop
    if (label) {
      const target = this.context.labelMap.get(label);
      if (target && 'testNode' in target) {
        this.connect(continueNode, target.testNode);
      }
    } else {
      // Continue to nearest loop
      const loopCtx = this.context.loopStack[this.context.loopStack.length - 1];
      if (loopCtx) {
        this.connect(continueNode, loopCtx.testNode);
      }
    }

    return continueNode;
  }

  /**
   * Process a labeled statement.
   * Note: Label tracking for break/continue is partially implemented.
   * The label is stored in the break/continue nodes for reference,
   * but full labeled loop support would require refactoring to pass
   * the label through to the loop processing methods.
   */
  private processLabeledStatement(
    stmt: t.LabeledStatement,
    current: CFGNode,
    exitNode: CFGNode
  ): CFGNode {
    // For loops, switches, and other statements, process the body
    // The label is captured in break/continue nodes via targetLabel property
    return this.processStatement(stmt.body, current, exitNode);
  }

  /**
   * Process an expression statement.
   */
  private processExpressionStatement(
    stmt: t.ExpressionStatement,
    current: CFGNode
  ): CFGNode {
    return this.processExpression(stmt.expression, current);
  }

  /**
   * Process an expression (may create multiple nodes for short-circuit operators).
   */
  private processExpression(expr: t.Expression, current: CFGNode): CFGNode {
    // Handle short-circuit operators
    if (t.isLogicalExpression(expr)) {
      return this.processLogicalExpression(expr, current);
    }

    if (t.isConditionalExpression(expr)) {
      return this.processConditionalExpression(expr, current);
    }

    if (t.isOptionalMemberExpression(expr) || t.isOptionalCallExpression(expr)) {
      return this.processOptionalChaining(expr, current);
    }

    // Regular expression - create single node
    const node = this.createNode(
      'statement',
      expr,
      this.getExpressionLabel(expr)
    );
    this.connect(current, node);
    return node;
  }

  /**
   * Process logical expressions (&&, ||, ??).
   * These create implicit branches because of short-circuit evaluation.
   */
  private processLogicalExpression(
    expr: t.LogicalExpression,
    current: CFGNode
  ): CFGNode {
    // Process left side
    const leftNode = this.createNode(
      'branch',
      expr.left,
      this.getExpressionLabel(expr.left)
    );
    this.connect(current, leftNode);

    // Create merge node
    const mergeNode = this.createNode('merge', null, 'logical-merge');

    // Process right side
    const rightNode = this.createNode(
      'statement',
      expr.right,
      this.getExpressionLabel(expr.right)
    );

    if (expr.operator === '&&') {
      // && : if left is truthy, evaluate right; otherwise short-circuit
      leftNode.trueSuccessor = rightNode;
      leftNode.falseSuccessor = mergeNode;
      this.connect(leftNode, rightNode);
      this.connect(leftNode, mergeNode);
    } else if (expr.operator === '||') {
      // || : if left is falsy, evaluate right; otherwise short-circuit
      leftNode.trueSuccessor = mergeNode;
      leftNode.falseSuccessor = rightNode;
      this.connect(leftNode, mergeNode);
      this.connect(leftNode, rightNode);
    } else {
      // ?? : if left is nullish, evaluate right; otherwise short-circuit
      leftNode.trueSuccessor = mergeNode; // non-nullish
      leftNode.falseSuccessor = rightNode; // nullish
      this.connect(leftNode, mergeNode);
      this.connect(leftNode, rightNode);
    }

    this.connect(rightNode, mergeNode);

    return mergeNode;
  }

  /**
   * Process conditional (ternary) expressions.
   */
  private processConditionalExpression(
    expr: t.ConditionalExpression,
    current: CFGNode
  ): CFGNode {
    // Create branch node for condition
    const branchNode = this.createNode(
      'branch',
      expr.test,
      `${this.getExpressionLabel(expr.test)} ?`
    );
    this.connect(current, branchNode);

    // Create merge node
    const mergeNode = this.createNode('merge', null, 'ternary-merge');

    // True branch (consequent)
    const trueNode = this.createNode(
      'statement',
      expr.consequent,
      this.getExpressionLabel(expr.consequent)
    );
    branchNode.trueSuccessor = trueNode;
    this.connect(branchNode, trueNode);
    this.connect(trueNode, mergeNode);

    // False branch (alternate)
    const falseNode = this.createNode(
      'statement',
      expr.alternate,
      this.getExpressionLabel(expr.alternate)
    );
    branchNode.falseSuccessor = falseNode;
    this.connect(branchNode, falseNode);
    this.connect(falseNode, mergeNode);

    return mergeNode;
  }

  /**
   * Process optional chaining (?.).
   */
  private processOptionalChaining(
    expr: t.OptionalMemberExpression | t.OptionalCallExpression,
    current: CFGNode
  ): CFGNode {
    // Optional chaining creates an implicit branch
    const checkNode = this.createNode(
      'branch',
      expr,
      `${this.getExpressionLabel(expr)}?`
    );
    this.connect(current, checkNode);

    const mergeNode = this.createNode('merge', null, 'optional-merge');

    // If not nullish, continue chain
    const continueNode = this.createNode(
      'statement',
      expr,
      this.getExpressionLabel(expr)
    );
    checkNode.trueSuccessor = continueNode;
    this.connect(checkNode, continueNode);
    this.connect(continueNode, mergeNode);

    // If nullish, short-circuit to undefined
    checkNode.falseSuccessor = mergeNode;
    this.connect(checkNode, mergeNode);

    return mergeNode;
  }

  /**
   * Process a variable declaration.
   */
  private processVariableDeclaration(
    stmt: t.VariableDeclaration,
    current: CFGNode
  ): CFGNode {
    // Create a node for the entire declaration
    const names = stmt.declarations
      .map((d) => (t.isIdentifier(d.id) ? d.id.name : '...'))
      .join(', ');
    const node = this.createNode(
      'statement',
      stmt,
      `${stmt.kind} ${names}`
    );
    this.connect(current, node);
    return node;
  }

  /**
   * Get a human-readable label for a statement.
   */
  private getStatementLabel(stmt: t.Statement): string {
    if (t.isExpressionStatement(stmt)) {
      return this.getExpressionLabel(stmt.expression);
    }
    if (t.isVariableDeclaration(stmt)) {
      const names = stmt.declarations
        .map((d) => (t.isIdentifier(d.id) ? d.id.name : '...'))
        .join(', ');
      return `${stmt.kind} ${names}`;
    }
    if (t.isReturnStatement(stmt)) {
      return stmt.argument
        ? `return ${this.getExpressionLabel(stmt.argument)}`
        : 'return';
    }
    return stmt.type;
  }

  /**
   * Get a human-readable label for an expression.
   */
  private getExpressionLabel(expr: t.Expression | t.LVal): string {
    if (t.isIdentifier(expr)) {
      return expr.name;
    }
    if (t.isCallExpression(expr)) {
      const callee = t.isIdentifier(expr.callee)
        ? expr.callee.name
        : t.isMemberExpression(expr.callee) && t.isIdentifier(expr.callee.property)
          ? expr.callee.property.name
          : 'call';
      return `${callee}(...)`;
    }
    if (t.isMemberExpression(expr)) {
      const obj = t.isIdentifier(expr.object) ? expr.object.name : '...';
      const prop = t.isIdentifier(expr.property) ? expr.property.name : '...';
      return `${obj}.${prop}`;
    }
    if (t.isAssignmentExpression(expr)) {
      const left = t.isIdentifier(expr.left) ? expr.left.name : '...';
      return `${left} ${expr.operator} ...`;
    }
    if (t.isBinaryExpression(expr) || t.isLogicalExpression(expr)) {
      return `... ${expr.operator} ...`;
    }
    if (t.isUnaryExpression(expr)) {
      return `${expr.operator}...`;
    }
    if (t.isUpdateExpression(expr)) {
      const arg = t.isIdentifier(expr.argument) ? expr.argument.name : '...';
      return expr.prefix ? `${expr.operator}${arg}` : `${arg}${expr.operator}`;
    }
    if (t.isLiteral(expr)) {
      if (t.isStringLiteral(expr)) return `"${expr.value}"`;
      if (t.isNumericLiteral(expr)) return String(expr.value);
      if (t.isBooleanLiteral(expr)) return String(expr.value);
      if (t.isNullLiteral(expr)) return 'null';
      return 'literal';
    }
    if (t.isArrayExpression(expr)) {
      return '[...]';
    }
    if (t.isObjectExpression(expr)) {
      return '{...}';
    }
    if (t.isArrowFunctionExpression(expr) || t.isFunctionExpression(expr)) {
      return 'function';
    }
    if (t.isConditionalExpression(expr)) {
      return '... ? ... : ...';
    }
    if (t.isAwaitExpression(expr)) {
      return `await ${this.getExpressionLabel(expr.argument)}`;
    }
    return expr.type;
  }
}

/**
 * Export the builder class for advanced usage.
 */
export { CFGBuilder };
