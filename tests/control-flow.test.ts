import * as parser from '@babel/parser';
import * as t from '@babel/types';
import {
  buildCFG,
  analyzeReachability,
  findAllPaths,
  isGuaranteedToExecute,
  cfgToDot,
  cfgStats,
  hasUnconditionalSetStateCFG,
  analyzeSetStateCalls,
} from '../src/control-flow';
import type { CFG, CFGNode } from '../src/control-flow';

/**
 * Helper to parse a function body and build a CFG.
 */
function buildCFGFromCode(code: string): CFG {
  const ast = parser.parse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'],
  });

  // Find the first function or arrow function
  let body: t.BlockStatement | t.Expression | null = null;

  for (const node of ast.program.body) {
    if (t.isFunctionDeclaration(node) && node.body) {
      body = node.body;
      break;
    }
    if (t.isVariableDeclaration(node)) {
      for (const decl of node.declarations) {
        if (t.isArrowFunctionExpression(decl.init)) {
          body = decl.init.body as t.BlockStatement | t.Expression;
          break;
        }
        if (t.isFunctionExpression(decl.init) && decl.init.body) {
          body = decl.init.body;
          break;
        }
      }
      if (body) break;
    }
    if (t.isExpressionStatement(node)) {
      if (t.isArrowFunctionExpression(node.expression)) {
        body = node.expression.body as t.BlockStatement | t.Expression;
        break;
      }
    }
  }

  if (!body) {
    throw new Error('No function body found in code');
  }

  return buildCFG(body);
}

/**
 * Helper to count nodes by type.
 */
function countNodesByType(cfg: CFG): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of cfg.nodes.values()) {
    counts[node.type] = (counts[node.type] || 0) + 1;
  }
  return counts;
}

/**
 * Helper to find a node by label substring.
 */
function findNodeByLabel(cfg: CFG, labelSubstring: string): CFGNode | undefined {
  for (const node of cfg.nodes.values()) {
    if (node.label.includes(labelSubstring)) {
      return node;
    }
  }
  return undefined;
}

describe('Control Flow Graph', () => {
  describe('CFG Builder - Basic Statements', () => {
    it('should create entry and exit nodes for empty function', () => {
      const cfg = buildCFGFromCode('function test() {}');

      expect(cfg.entry).toBeDefined();
      expect(cfg.exit).toBeDefined();
      expect(cfg.entry.type).toBe('entry');
      expect(cfg.exit.type).toBe('exit');
      expect(cfg.entry.successors).toContain(cfg.exit);
    });

    it('should create nodes for sequential statements', () => {
      const cfg = buildCFGFromCode(`
        function test() {
          const a = 1;
          const b = 2;
          const c = 3;
        }
      `);

      const counts = countNodesByType(cfg);
      expect(counts['entry']).toBe(1);
      expect(counts['exit']).toBe(1);
      expect(counts['statement']).toBe(3);

      // All nodes should be reachable
      for (const node of cfg.nodes.values()) {
        expect(node.reachable).toBe(true);
      }
    });

    it('should handle expression statements', () => {
      const cfg = buildCFGFromCode(`
        function test() {
          console.log('hello');
          x = 5;
        }
      `);

      const logNode = findNodeByLabel(cfg, 'log(...)');
      expect(logNode).toBeDefined();
      expect(logNode!.reachable).toBe(true);
    });
  });

  describe('CFG Builder - If Statements', () => {
    it('should create branch nodes for if statements', () => {
      const cfg = buildCFGFromCode(`
        function test(x) {
          if (x > 0) {
            console.log('positive');
          }
        }
      `);

      const counts = countNodesByType(cfg);
      expect(counts['branch']).toBe(1);
      expect(counts['merge']).toBe(1);

      const branchNode = findNodeByLabel(cfg, 'if');
      expect(branchNode).toBeDefined();
      expect(branchNode!.trueSuccessor).toBeDefined();
      expect(branchNode!.falseSuccessor).toBeDefined();
    });

    it('should handle if-else statements', () => {
      const cfg = buildCFGFromCode(`
        function test(x) {
          if (x > 0) {
            console.log('positive');
          } else {
            console.log('non-positive');
          }
        }
      `);

      const branchNode = findNodeByLabel(cfg, 'if');
      expect(branchNode).toBeDefined();
      expect(branchNode!.trueSuccessor).toBeDefined();
      expect(branchNode!.falseSuccessor).toBeDefined();

      // Both branches should merge
      const mergeNode = findNodeByLabel(cfg, 'merge');
      expect(mergeNode).toBeDefined();
      expect(mergeNode!.predecessors.length).toBeGreaterThanOrEqual(2);
    });

    it('should handle nested if statements', () => {
      const cfg = buildCFGFromCode(`
        function test(x, y) {
          if (x > 0) {
            if (y > 0) {
              console.log('both positive');
            }
          }
        }
      `);

      const counts = countNodesByType(cfg);
      expect(counts['branch']).toBe(2);
      expect(counts['merge']).toBe(2);
    });
  });

  describe('CFG Builder - Loops', () => {
    it('should create loop structure for while loops', () => {
      const cfg = buildCFGFromCode(`
        function test() {
          let i = 0;
          while (i < 10) {
            i++;
          }
        }
      `);

      const testNode = findNodeByLabel(cfg, 'while');
      expect(testNode).toBeDefined();
      expect(testNode!.type).toBe('loop-test');
      expect(testNode!.trueSuccessor).toBeDefined(); // loop body
      expect(testNode!.falseSuccessor).toBeDefined(); // loop exit

      // Should have a back edge (loop body -> test)
      const bodyNode = testNode!.trueSuccessor;
      expect(bodyNode).toBeDefined();
    });

    it('should create loop structure for for loops', () => {
      const cfg = buildCFGFromCode(`
        function test() {
          for (let i = 0; i < 10; i++) {
            console.log(i);
          }
        }
      `);

      const counts = countNodesByType(cfg);
      expect(counts['loop-test']).toBe(1);
      expect(counts['loop-update']).toBe(1);
    });

    it('should handle break statements', () => {
      const cfg = buildCFGFromCode(`
        function test() {
          while (true) {
            break;
          }
        }
      `);

      const breakNode = findNodeByLabel(cfg, 'break');
      expect(breakNode).toBeDefined();
      expect(breakNode!.type).toBe('break');

      // Break should connect to loop exit
      const exitNode = findNodeByLabel(cfg, 'loop-exit');
      expect(exitNode).toBeDefined();
      expect(breakNode!.successors).toContain(exitNode);
    });

    it('should handle continue statements', () => {
      const cfg = buildCFGFromCode(`
        function test() {
          while (true) {
            continue;
          }
        }
      `);

      const continueNode = findNodeByLabel(cfg, 'continue');
      expect(continueNode).toBeDefined();
      expect(continueNode!.type).toBe('continue');

      // Continue should connect to loop test
      const testNode = findNodeByLabel(cfg, 'while');
      expect(testNode).toBeDefined();
      expect(continueNode!.successors).toContain(testNode);
    });

    it('should handle do-while loops', () => {
      const cfg = buildCFGFromCode(`
        function test() {
          let i = 0;
          do {
            i++;
          } while (i < 10);
        }
      `);

      const testNode = findNodeByLabel(cfg, 'while');
      expect(testNode).toBeDefined();
      expect(testNode!.type).toBe('loop-test');

      // Body should be entered before test in do-while
      const doNode = findNodeByLabel(cfg, 'do');
      expect(doNode).toBeDefined();
      expect(cfg.entry.successors).not.toContain(testNode);
    });
  });

  describe('CFG Builder - Return Statements', () => {
    it('should mark code after return as unreachable', () => {
      const cfg = buildCFGFromCode(`
        function test() {
          return 1;
          console.log('unreachable');
        }
      `);

      const returnNode = findNodeByLabel(cfg, 'return');
      expect(returnNode).toBeDefined();
      expect(returnNode!.reachable).toBe(true);

      // The log statement should not be reachable
      const logNode = findNodeByLabel(cfg, 'log(...)');
      expect(logNode).toBeUndefined(); // Not even created after return
    });

    it('should connect return to exit', () => {
      const cfg = buildCFGFromCode(`
        function test() {
          return 42;
        }
      `);

      const returnNode = findNodeByLabel(cfg, 'return');
      expect(returnNode).toBeDefined();
      expect(returnNode!.successors).toContain(cfg.exit);
    });

    it('should handle early return in if statement', () => {
      const cfg = buildCFGFromCode(`
        function test(x) {
          if (x === 0) {
            return 0;
          }
          return x * 2;
        }
      `);

      const counts = countNodesByType(cfg);
      expect(counts['return']).toBe(2);

      // Both returns should be reachable
      for (const node of cfg.nodes.values()) {
        if (node.type === 'return') {
          expect(node.reachable).toBe(true);
        }
      }
    });
  });

  describe('CFG Builder - Try-Catch-Finally', () => {
    it('should create try-catch structure', () => {
      const cfg = buildCFGFromCode(`
        function test() {
          try {
            riskyOperation();
          } catch (e) {
            handleError(e);
          }
        }
      `);

      // Find try node by type instead of label (entry might match 'try' in some labels)
      let tryNode: CFGNode | undefined;
      let catchNode: CFGNode | undefined;
      for (const node of cfg.nodes.values()) {
        if (node.type === 'try') tryNode = node;
        if (node.type === 'catch') catchNode = node;
      }

      expect(tryNode).toBeDefined();
      expect(tryNode!.type).toBe('try');

      expect(catchNode).toBeDefined();
      expect(catchNode!.type).toBe('catch');
    });

    it('should create try-finally structure', () => {
      const cfg = buildCFGFromCode(`
        function test() {
          try {
            riskyOperation();
          } finally {
            cleanup();
          }
        }
      `);

      const tryNode = findNodeByLabel(cfg, 'try');
      expect(tryNode).toBeDefined();

      const finallyNode = findNodeByLabel(cfg, 'finally');
      expect(finallyNode).toBeDefined();
      expect(finallyNode!.type).toBe('finally');
    });

    it('should connect throw to catch', () => {
      const cfg = buildCFGFromCode(`
        function test() {
          try {
            throw new Error('test');
          } catch (e) {
            console.log(e);
          }
        }
      `);

      const throwNode = findNodeByLabel(cfg, 'throw');
      expect(throwNode).toBeDefined();
      expect(throwNode!.type).toBe('throw');

      const catchNode = findNodeByLabel(cfg, 'catch');
      expect(catchNode).toBeDefined();
      expect(throwNode!.successors).toContain(catchNode);
    });
  });

  describe('CFG Builder - Logical Expressions', () => {
    it('should create branches for && operator in expression statements', () => {
      const cfg = buildCFGFromCode(`
        function test(a, b) {
          a && b;
        }
      `);

      const counts = countNodesByType(cfg);
      // && creates a branch for short-circuit evaluation when used as expression statement
      expect(counts['branch']).toBeGreaterThanOrEqual(1);
    });

    it('should create branches for || operator in expression statements', () => {
      const cfg = buildCFGFromCode(`
        function test(a, b) {
          a || b;
        }
      `);

      const counts = countNodesByType(cfg);
      expect(counts['branch']).toBeGreaterThanOrEqual(1);
    });

    it('should create branches for ternary operator in expression statements', () => {
      const cfg = buildCFGFromCode(`
        function test(x) {
          x > 0 ? console.log('positive') : console.log('non-positive');
        }
      `);

      const counts = countNodesByType(cfg);
      expect(counts['branch']).toBeGreaterThanOrEqual(1);
      expect(counts['merge']).toBeGreaterThanOrEqual(1);
    });

    it('should handle logical expressions in if conditions', () => {
      const cfg = buildCFGFromCode(`
        function test(a, b) {
          if (a && b) {
            console.log('both truthy');
          }
        }
      `);

      // The && in the condition creates a branch
      const counts = countNodesByType(cfg);
      expect(counts['branch']).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Reachability Analysis', () => {
    it('should identify guaranteed execution', () => {
      const cfg = buildCFGFromCode(`
        function test() {
          const a = 1;
          console.log(a);
        }
      `);

      const logNode = findNodeByLabel(cfg, 'log(...)');
      expect(logNode).toBeDefined();
      expect(isGuaranteedToExecute(cfg, logNode!)).toBe(true);
    });

    it('should identify conditional execution', () => {
      const cfg = buildCFGFromCode(`
        function test(x) {
          if (x > 0) {
            console.log('positive');
          }
        }
      `);

      const logNode = findNodeByLabel(cfg, 'log(...)');
      expect(logNode).toBeDefined();
      expect(isGuaranteedToExecute(cfg, logNode!)).toBe(false);
    });

    it('should find all paths to a node', () => {
      const cfg = buildCFGFromCode(`
        function test(x) {
          if (x > 0) {
            console.log('positive');
          } else {
            console.log('negative');
          }
          done();
        }
      `);

      const doneNode = findNodeByLabel(cfg, 'done(...)');
      expect(doneNode).toBeDefined();

      const paths = findAllPaths(cfg.entry, doneNode!);
      // Should have 2 paths: through true branch and through false branch
      expect(paths.length).toBe(2);
    });

    it('should analyze reachability with path conditions', () => {
      const cfg = buildCFGFromCode(`
        function test(x) {
          if (x > 0) {
            console.log('positive');
          }
        }
      `);

      const logNode = findNodeByLabel(cfg, 'log(...)');
      expect(logNode).toBeDefined();

      const result = analyzeReachability(cfg, logNode!);
      expect(result.reachable).toBe(true);
      expect(result.guaranteedToExecute).toBe(false);
      expect(result.paths.length).toBe(1);
      expect(result.pathConditions.length).toBe(1);
      expect(result.pathConditions[0].length).toBe(1);
      expect(result.pathConditions[0][0].branchTaken).toBe('true');
    });
  });

  describe('CFG Visualization', () => {
    it('should generate DOT format', () => {
      const cfg = buildCFGFromCode(`
        function test(x) {
          if (x > 0) {
            return 1;
          }
          return 0;
        }
      `);

      const dot = cfgToDot(cfg, { title: 'Test CFG' });
      expect(dot).toContain('digraph CFG');
      expect(dot).toContain('label="Test CFG"');
      expect(dot).toContain('entry');
      expect(dot).toContain('exit');
      expect(dot).toContain('->'); // edges
    });

    it('should generate CFG stats', () => {
      const cfg = buildCFGFromCode(`
        function test(x) {
          if (x > 0) {
            return 1;
          }
          return 0;
        }
      `);

      const stats = cfgStats(cfg);
      expect(stats).toContain('Total nodes:');
      expect(stats).toContain('Reachable:');
      expect(stats).toContain('Branch points:');
    });
  });

  describe('Real-World Patterns', () => {
    it('should handle useEffect-like pattern with guard', () => {
      const cfg = buildCFGFromCode(`
        function effect() {
          if (value !== prevValue) {
            setValue(value);
          }
        }
      `);

      const setValueNode = findNodeByLabel(cfg, 'setValue(...)');
      expect(setValueNode).toBeDefined();

      const result = analyzeReachability(cfg, setValueNode!);
      expect(result.reachable).toBe(true);
      expect(result.guaranteedToExecute).toBe(false);
      // Should have a condition involving inequality check
      expect(result.pathConditions[0][0].branchTaken).toBe('true');
    });

    it('should handle early return guard pattern', () => {
      const cfg = buildCFGFromCode(`
        function effect() {
          if (value === prevValue) {
            return;
          }
          setValue(value);
        }
      `);

      const setValueNode = findNodeByLabel(cfg, 'setValue(...)');
      expect(setValueNode).toBeDefined();
      expect(setValueNode!.reachable).toBe(true);

      // setValue is only reachable when value !== prevValue
      expect(isGuaranteedToExecute(cfg, setValueNode!)).toBe(false);
    });

    it('should detect unreachable setState after unconditional return', () => {
      const cfg = buildCFGFromCode(`
        function effect() {
          return;
          setValue(value);
        }
      `);

      // setValue should not even be in the graph (code after return is not processed)
      const setValueNode = findNodeByLabel(cfg, 'setValue(...)');
      expect(setValueNode).toBeUndefined();
    });

    it('should handle async callback pattern (simplified)', () => {
      const cfg = buildCFGFromCode(`
        function effect() {
          fetchData().then(data => {
            setValue(data);
          });
        }
      `);

      // The then callback is processed as part of the expression
      const thenNode = findNodeByLabel(cfg, 'then(...)');
      expect(thenNode).toBeDefined();
      expect(thenNode!.reachable).toBe(true);
    });
  });

  describe('setState Analyzer', () => {
    /**
     * Helper to get the function body from parsed code.
     */
    function getFunctionBody(
      code: string
    ): t.ArrowFunctionExpression | t.FunctionExpression | null {
      const ast = parser.parse(code, {
        sourceType: 'module',
        plugins: ['jsx', 'typescript'],
      });

      for (const node of ast.program.body) {
        if (t.isVariableDeclaration(node)) {
          for (const decl of node.declarations) {
            if (t.isArrowFunctionExpression(decl.init)) {
              return decl.init;
            }
            if (t.isFunctionExpression(decl.init)) {
              return decl.init;
            }
          }
        }
      }
      return null;
    }

    it('should detect unconditional setState', () => {
      const code = `
        const effect = () => {
          setValue(123);
        };
      `;
      const body = getFunctionBody(code);
      expect(body).not.toBeNull();

      const stateInfo = new Map([['value', 'setValue']]);
      const hasUnconditional = hasUnconditionalSetStateCFG(body!, stateInfo);
      expect(hasUnconditional).toBe(true);
    });

    it('should not flag conditional setState as unconditional', () => {
      const code = `
        const effect = () => {
          if (condition) {
            setValue(123);
          }
        };
      `;
      const body = getFunctionBody(code);
      expect(body).not.toBeNull();

      const stateInfo = new Map([['value', 'setValue']]);
      const hasUnconditional = hasUnconditionalSetStateCFG(body!, stateInfo);
      expect(hasUnconditional).toBe(false);
    });

    it('should analyze setState calls with dependencies', () => {
      const code = `
        const effect = () => {
          if (value !== newValue) {
            setValue(newValue);
          }
        };
      `;
      const body = getFunctionBody(code);
      expect(body).not.toBeNull();

      const stateInfo = new Map([['value', 'setValue']]);
      const analysis = analyzeSetStateCalls(body!, stateInfo, ['value']);

      expect(analysis.size).toBe(1);
      const setValueAnalysis = analysis.get('setValue');
      expect(setValueAnalysis).toBeDefined();
      expect(setValueAnalysis!.isUnconditional).toBe(false);
      expect(setValueAnalysis!.isReachable).toBe(true);
    });

    it('should detect early return as guard', () => {
      const code = `
        const effect = () => {
          if (value === prevValue) return;
          setValue(value);
        };
      `;
      const body = getFunctionBody(code);
      expect(body).not.toBeNull();

      const stateInfo = new Map([['value', 'setValue']]);
      const hasUnconditional = hasUnconditionalSetStateCFG(body!, stateInfo);
      // Early return makes it conditional
      expect(hasUnconditional).toBe(false);
    });

    it('should handle multiple setState calls', () => {
      const code = `
        const effect = () => {
          setA(1);
          if (condition) {
            setB(2);
          }
        };
      `;
      const body = getFunctionBody(code);
      expect(body).not.toBeNull();

      const stateInfo = new Map([
        ['a', 'setA'],
        ['b', 'setB'],
      ]);
      const analysis = analyzeSetStateCalls(body!, stateInfo, []);

      expect(analysis.size).toBe(2);

      const setAAnalysis = analysis.get('setA');
      expect(setAAnalysis).toBeDefined();
      expect(setAAnalysis!.isUnconditional).toBe(true);

      const setBAnalysis = analysis.get('setB');
      expect(setBAnalysis).toBeDefined();
      expect(setBAnalysis!.isUnconditional).toBe(false);
    });
  });
});
