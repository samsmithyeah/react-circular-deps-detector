import { detectCircularDependencies } from '../src/detector';
import * as path from 'path';

describe('useReducer dispatch loop detection', () => {
  const fixturesPath = path.join(__dirname, 'fixtures');

  it('should detect infinite loop when dispatch modifies state that effect depends on', async () => {
    const results = await detectCircularDependencies(fixturesPath, {
      pattern: 'useReducer-loops.tsx',
      ignore: [],
    });

    // Pattern 1: UseReducerInfiniteLoop (line 41)
    const infiniteLoopIssues = results.intelligentHooksAnalysis.filter(
      (issue) =>
        issue.line === 41 &&
        issue.type === 'confirmed-infinite-loop' &&
        issue.errorCode === 'RLD-200'
    );

    expect(infiniteLoopIssues.length).toBe(1);
    expect(infiniteLoopIssues[0].setterFunction).toBe('dispatch1');
    expect(infiniteLoopIssues[0].problematicDependency).toBe('state1');
  });

  it('should detect infinite loop with different action types', async () => {
    const results = await detectCircularDependencies(fixturesPath, {
      pattern: 'useReducer-loops.tsx',
      ignore: [],
    });

    // Pattern 2: UseReducerSetData (line 53)
    const setDataIssues = results.intelligentHooksAnalysis.filter(
      (issue) =>
        issue.line === 53 &&
        issue.type === 'confirmed-infinite-loop' &&
        issue.errorCode === 'RLD-200'
    );

    expect(setDataIssues.length).toBe(1);
    expect(setDataIssues[0].setterFunction).toBe('dispatch2');
  });

  it('should detect guarded dispatch as potential issue (not confirmed loop)', async () => {
    const results = await detectCircularDependencies(fixturesPath, {
      pattern: 'useReducer-loops.tsx',
      ignore: [],
    });

    // Pattern 3: UseReducerWithGuard (line 65)
    const guardedIssues = results.intelligentHooksAnalysis.filter(
      (issue) => issue.line === 65 && issue.problematicDependency === 'state3'
    );

    expect(guardedIssues.length).toBe(1);
    // Should be potential-issue, not confirmed-infinite-loop (guard detected)
    expect(guardedIssues[0].type).toBe('potential-issue');
    expect(guardedIssues[0].errorCode).toBe('RLD-501');
  });

  it('should not flag dispatch with empty dependency array', async () => {
    const results = await detectCircularDependencies(fixturesPath, {
      pattern: 'useReducer-loops.tsx',
      ignore: [],
    });

    // Pattern 4: UseReducerNoDeps (lines 75-84)
    // No issues should be reported for this component
    const noDepsIssues = results.intelligentHooksAnalysis.filter(
      (issue) => issue.line >= 75 && issue.line <= 84
    );

    expect(noDepsIssues.length).toBe(0);
  });

  it('should detect loops with renamed dispatch (e.g., send instead of dispatch)', async () => {
    const results = await detectCircularDependencies(fixturesPath, {
      pattern: 'useReducer-loops.tsx',
      ignore: [],
    });

    // Pattern 5: UseReducerRenamedDispatch (line 93)
    // The dispatch function is renamed to 'send' but should still be tracked
    const renamedIssues = results.intelligentHooksAnalysis.filter(
      (issue) =>
        issue.line === 93 &&
        issue.type === 'confirmed-infinite-loop' &&
        issue.errorCode === 'RLD-200'
    );

    expect(renamedIssues.length).toBe(1);
    expect(renamedIssues[0].setterFunction).toBe('send');
    expect(renamedIssues[0].problematicDependency).toBe('state5');
  });

  it('should detect useCallback patterns that lead to loops', async () => {
    const results = await detectCircularDependencies(fixturesPath, {
      pattern: 'useReducer-loops.tsx',
      ignore: [],
    });

    // Pattern 6: UseReducerInCallback (line 105)
    const callbackIssues = results.intelligentHooksAnalysis.filter(
      (issue) => issue.line === 105 && issue.problematicDependency === 'state6'
    );

    expect(callbackIssues.length).toBe(1);
    // useCallback doesn't cause direct loops but is flagged as potential issue
    expect(callbackIssues[0].type).toBe('potential-issue');
    expect(callbackIssues[0].errorCode).toBe('RLD-420');
  });

  it('should not flag safe callback patterns with empty deps', async () => {
    const results = await detectCircularDependencies(fixturesPath, {
      pattern: 'useReducer-loops.tsx',
      ignore: [],
    });

    // Pattern 7: UseReducerSafeCallback (lines 117-133)
    // Callback has empty deps array, should not be flagged
    const safeCallbackIssues = results.intelligentHooksAnalysis.filter(
      (issue) => issue.line >= 117 && issue.line <= 133
    );

    expect(safeCallbackIssues.length).toBe(0);
  });

  it('should detect dispatch inside async IIFE', async () => {
    const results = await detectCircularDependencies(fixturesPath, {
      pattern: 'useReducer-loops.tsx',
      ignore: [],
    });

    // Pattern 8: UseReducerAsyncIIFE (line 140)
    const asyncIssues = results.intelligentHooksAnalysis.filter(
      (issue) =>
        issue.line === 140 &&
        issue.type === 'confirmed-infinite-loop' &&
        issue.errorCode === 'RLD-200'
    );

    expect(asyncIssues.length).toBe(1);
    expect(asyncIssues[0].setterFunction).toBe('dispatch8');
  });

  it('should properly track all useReducer state/dispatch pairs in the file', async () => {
    const results = await detectCircularDependencies(fixturesPath, {
      pattern: 'useReducer-loops.tsx',
      ignore: [],
    });

    // Should have analyzed the file
    expect(results.summary.filesAnalyzed).toBe(1);
    expect(results.summary.hooksAnalyzed).toBeGreaterThan(0);

    // Verify we found issues for multiple dispatch functions
    const dispatchers = new Set(
      results.intelligentHooksAnalysis.map((i) => i.setterFunction).filter(Boolean)
    );
    expect(dispatchers.size).toBeGreaterThanOrEqual(4);
    expect(dispatchers.has('dispatch1')).toBe(true);
    expect(dispatchers.has('dispatch2')).toBe(true);
    expect(dispatchers.has('send')).toBe(true); // renamed dispatch
    expect(dispatchers.has('dispatch8')).toBe(true);
  });

  describe('comparison with useState behavior', () => {
    it('should detect useReducer loops similar to useState loops', async () => {
      const [reducerResults, hookResults] = await Promise.all([
        detectCircularDependencies(fixturesPath, {
          pattern: 'useReducer-loops.tsx',
          ignore: [],
        }),
        detectCircularDependencies(fixturesPath, {
          pattern: 'hooks-dependency-loop.tsx',
          ignore: [],
        }),
      ]);

      // Both should have confirmed infinite loops
      const reducerConfirmed = reducerResults.intelligentHooksAnalysis.filter(
        (i) => i.type === 'confirmed-infinite-loop'
      );
      const hookConfirmed = hookResults.intelligentHooksAnalysis.filter(
        (i) => i.type === 'confirmed-infinite-loop'
      );

      // useReducer patterns should be detected
      expect(reducerConfirmed.length).toBeGreaterThanOrEqual(3);
      // useState patterns should also be detected
      expect(hookConfirmed.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('edge cases', () => {
    it('should handle multiple useReducer calls in the same file', async () => {
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: 'useReducer-loops.tsx',
        ignore: [],
      });

      // Should have detected issues from multiple components
      const uniqueLines = new Set(results.intelligentHooksAnalysis.map((i) => i.line));
      expect(uniqueLines.size).toBeGreaterThanOrEqual(5);
    });

    it('should not report false positives for safe patterns', async () => {
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: 'useReducer-loops.tsx',
        ignore: [],
      });

      // Pattern 4 (empty deps) and Pattern 7 (safe callback) should not be flagged
      const falsePositives = results.intelligentHooksAnalysis.filter(
        (issue) =>
          // Empty deps effect (lines 78-81)
          (issue.line >= 78 && issue.line <= 81) ||
          // Safe callback effect (lines 127-130)
          (issue.line >= 127 && issue.line <= 130)
      );

      expect(falsePositives.length).toBe(0);
    });
  });

  // ============================================================================
  // Previously skipped tests - now implemented!
  // ============================================================================

  describe('advanced patterns', () => {
    it('should detect loops with member expression dependencies (e.g., state.count)', async () => {
      // Pattern 9: UseReducerMemberExpressionDep (line 160)
      // Implementation: extractRootIdentifier() in hook-analyzer.ts extracts root from MemberExpressions
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: 'useReducer-loops.tsx',
        ignore: [],
      });

      const memberExprIssues = results.intelligentHooksAnalysis.filter(
        (issue) =>
          issue.line === 160 &&
          (issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue')
      );

      // When implemented, this should find the loop
      expect(memberExprIssues.length).toBeGreaterThanOrEqual(1);
      expect(memberExprIssues[0].setterFunction).toBe('dispatch9');
    });

    it('should detect dispatch in cleanup function causing loops', async () => {
      // Pattern 10: UseReducerCleanupLoop (line 174)
      // Implementation: cleanupFunctionNodes tracking in effect-analyzer.ts detects return () => dispatch()
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: 'useReducer-loops.tsx',
        ignore: [],
      });

      const cleanupIssues = results.intelligentHooksAnalysis.filter(
        (issue) =>
          issue.line === 174 &&
          (issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue')
      );

      // When implemented, this should detect the cleanup loop
      expect(cleanupIssues.length).toBeGreaterThanOrEqual(1);
      expect(cleanupIssues[0].setterFunction).toBe('dispatch10');
    });

    it('should detect dispatch through deeply nested function calls', async () => {
      // Pattern 11: UseReducerNestedFunction (line 196)
      // Implementation: buildLocalFunctionSetterMap() in effect-analyzer.ts traces transitive setter calls
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: 'useReducer-loops.tsx',
        ignore: [],
      });

      const nestedIssues = results.intelligentHooksAnalysis.filter(
        (issue) =>
          issue.line === 196 &&
          (issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue')
      );

      // When implemented, this should detect the nested dispatch
      expect(nestedIssues.length).toBeGreaterThanOrEqual(1);
      expect(nestedIssues[0].setterFunction).toBe('dispatch11');
    });
  });
});
