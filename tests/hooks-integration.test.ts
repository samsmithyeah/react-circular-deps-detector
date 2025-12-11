import { detectCircularDependencies } from '../src/detector';
import * as path from 'path';

describe('Hooks Integration Tests', () => {
  const fixturesPath = path.join(__dirname, 'fixtures');

  describe('Full Detection Pipeline', () => {
    it('should detect hooks dependency loops in integration', async () => {
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: 'hooks-dependency-loop.tsx',
        ignore: [],
      });

      expect(results).toHaveProperty('intelligentHooksAnalysis');
      expect(results.intelligentHooksAnalysis.length).toBeGreaterThan(0);

      expect(results.summary.intelligentAnalysisCount).toBeGreaterThan(0);
      expect(results.summary.filesAnalyzed).toBe(1);
    });

    it('should have fewer issues in clean hooks file', async () => {
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: 'clean-hooks-example.tsx',
        ignore: [],
      });

      // Clean hooks should have fewer high-severity confirmed loops
      const confirmedLoops = results.intelligentHooksAnalysis.filter(
        (l) => l.type === 'confirmed-infinite-loop'
      );
      expect(confirmedLoops.length).toBeLessThanOrEqual(1);
    });

    it('should handle edge cases without crashing', async () => {
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: 'edge-case-hooks.tsx',
        ignore: [],
      });

      expect(results).toHaveProperty('intelligentHooksAnalysis');
      expect(Array.isArray(results.intelligentHooksAnalysis)).toBe(true);
    });

    it('should include hooks loops in total issue count', async () => {
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: 'hooks-dependency-loop.tsx',
        ignore: [],
      });

      const totalExpected =
        results.summary.circularDependencies +
        results.summary.crossFileCycles +
        results.summary.intelligentAnalysisCount;

      expect(totalExpected).toBeGreaterThan(0);
    });
  });

  describe('Intelligent Analyzer Integration', () => {
    it('should run intelligent analyzer without conflicts', async () => {
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: '*.tsx',
        ignore: ['clean-*'],
      });

      expect(results).toHaveProperty('circularDependencies');
      expect(results).toHaveProperty('crossFileCycles');
      expect(results).toHaveProperty('intelligentHooksAnalysis');

      // Verify all result arrays exist and have expected structure
      expect(results.circularDependencies).toBeDefined();
      expect(results.crossFileCycles).toBeDefined();
      expect(results.intelligentHooksAnalysis).toBeDefined();
    });

    it('should provide comprehensive summary', async () => {
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: 'hooks-dependency-loop.tsx',
        ignore: [],
      });

      expect(results.summary).toHaveProperty('filesAnalyzed');
      expect(results.summary).toHaveProperty('hooksAnalyzed');
      expect(results.summary).toHaveProperty('circularDependencies');
      expect(results.summary).toHaveProperty('crossFileCycles');
      expect(results.summary).toHaveProperty('intelligentAnalysisCount');

      expect(results.summary.filesAnalyzed).toBeGreaterThan(0);
      expect(results.summary.hooksAnalyzed).toBeGreaterThan(0);
    });
  });

  describe('Performance and Scalability', () => {
    it('should handle multiple files efficiently', async () => {
      const startTime = Date.now();

      const results = await detectCircularDependencies(fixturesPath, {
        pattern: '*.{tsx,ts}',
        ignore: [],
      });

      const endTime = Date.now();
      const duration = endTime - startTime;

      expect(duration).toBeLessThan(5000); // Should complete within 5 seconds
      expect(results.summary.filesAnalyzed).toBeGreaterThan(1);
    });

    it('should not consume excessive memory', async () => {
      const initialMemory = process.memoryUsage().heapUsed;

      await detectCircularDependencies(fixturesPath, {
        pattern: '*.{tsx,ts}',
        ignore: [],
        strict: false, // Disable strict mode to test baseline memory (TypeChecker adds ~100MB)
      });

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;

      // Should not increase memory by more than 100MB
      expect(memoryIncrease).toBeLessThan(100 * 1024 * 1024);
    });
  });

  describe('Error Resilience', () => {
    it('should handle non-existent directories gracefully', async () => {
      const nonExistentPath = path.join(fixturesPath, 'non-existent-dir');

      // Our detector handles non-existent directories by returning empty results
      const results = await detectCircularDependencies(nonExistentPath, {
        pattern: '*.tsx',
        ignore: [],
      });

      expect(results.summary.filesAnalyzed).toBe(0);
    });

    it('should continue processing other files when one file fails', async () => {
      // Mix of valid and potentially problematic files
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: '*.{tsx,ts}',
        ignore: [],
      });

      expect(results.summary.filesAnalyzed).toBeGreaterThan(0);
      // Should have processed files even if some had issues
    });
  });

  describe('Real-world Patterns', () => {
    it('should detect patterns similar to SignalContext issue', async () => {
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: 'hooks-dependency-loop.tsx',
        ignore: [],
      });

      // Should detect confirmed or potential issues
      const hasIssues =
        results.intelligentHooksAnalysis.filter(
          (issue) => issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue'
        ).length > 0;

      expect(hasIssues).toBe(true);
    });

    it('should provide actionable error messages', async () => {
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: 'hooks-dependency-loop.tsx',
        ignore: [],
      });

      results.intelligentHooksAnalysis.forEach((issue) => {
        expect(issue.explanation).toBeDefined();
        expect(issue.explanation.length).toBeGreaterThan(20);
        expect(issue.file).toContain('.tsx');
        expect(issue.line).toBeGreaterThan(0);
      });
    });
  });

  describe('useRef Mutation Detection', () => {
    it('should NOT flag ref mutations inside effects - this is the safe usePrevious/useLatest pattern', async () => {
      // RLD-600 was previously triggered for effect-phase ref mutations with state values.
      // This was overly aggressive - ref mutations inside effects are SAFE.
      // The standard usePrevious/useLatest pattern mutates refs in effects.
      // See: docs/FEEDBACK_AND_ROADMAP.md "Refine RLD-600 Ref Mutation Logic"
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: 'ref-mutation-example.tsx',
        ignore: [],
        config: {
          minConfidence: 'low',
        },
      });

      // Effect-phase ref mutations should NOT trigger RLD-600
      const refMutationIssues = results.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-600'
      );

      // No RLD-600 issues should be reported for effect-phase ref mutations
      expect(refMutationIssues.length).toBe(0);
    });

    it('should analyze ref mutation examples without crashing', async () => {
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: 'ref-mutation-example.tsx',
        ignore: [],
      });

      // Should have analyzed the file successfully
      expect(results.summary.filesAnalyzed).toBe(1);

      // No RLD-600 issues - all patterns in the fixture are effect-phase (safe)
      const refMutationIssues = results.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-600'
      );
      expect(refMutationIssues.length).toBe(0);
    });

    it('should flag render-phase ref mutations (RLD-600)', async () => {
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: 'render-phase-ref-mutation.tsx',
        ignore: [],
        config: {
          minConfidence: 'low',
        },
      });

      // Should have analyzed the file successfully
      expect(results.summary.filesAnalyzed).toBe(1);

      // Should flag render-phase ref mutations
      const refMutationIssues = results.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-600'
      );

      // 4 problematic patterns in the fixture:
      // 1. RenderPhaseRefWithState - countRef.current = count
      // 2. RenderPhaseRefWithoutState - renderCountRef.current += 1
      // 3. RenderPhaseRefWithDerived - countRef.current = items.length
      // 4. ArrowComponentWithRefMutation - prevRef.current = value
      expect(refMutationIssues.length).toBe(4);

      // Verify each issue has the correct structure
      for (const issue of refMutationIssues) {
        expect(issue.errorCode).toBe('RLD-600');
        expect(issue.category).toBe('warning');
        expect(issue.confidence).toBe('high');
        expect(issue.explanation).toContain('during render');
        expect(issue.suggestion).toContain('useEffect');
      }
    });

    it('should NOT flag safe ref mutation patterns', async () => {
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: 'render-phase-ref-mutation.tsx',
        ignore: [],
        config: {
          minConfidence: 'low',
        },
      });

      const refMutationIssues = results.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-600'
      );

      // Safe patterns should NOT be flagged:
      // - SafeEffectRefMutation (ref mutation in useEffect)
      // - SafeLayoutEffectRefMutation (ref mutation in useLayoutEffect)
      // - SafeEventHandlerRefMutation (ref mutation in event handler)
      // - SafeCallbackRefMutation (ref mutation in useCallback)
      // - SafeNestedFunctionRefMutation (ref mutation in nested function)
      // - SafeTimerRef (ref mutation in effect)
      // - SafeRefRead (no mutation, just reading)

      // Only 4 problematic patterns should be flagged (not the 7 safe ones)
      expect(refMutationIssues.length).toBe(4);

      // These are the SAFE patterns - their lines should NOT be flagged
      // The safe patterns use refs inside effects/callbacks/handlers
      // Check that issues are only in the PROBLEMATIC components (lines ~13, 27, 38, 52)
      for (const issue of refMutationIssues) {
        // All flagged issues should be in the problematic components section (lines before ~60)
        expect(issue.line).toBeLessThan(60);
      }
    });

    it('should assign higher severity to ref mutations with state values', async () => {
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: 'render-phase-ref-mutation.tsx',
        ignore: [],
        config: {
          minConfidence: 'low',
        },
      });

      const refMutationIssues = results.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-600'
      );

      // RenderPhaseRefWithState (line ~13) and RenderPhaseRefWithDerived (line ~38)
      // should have high severity (they use state values)
      const highSeverityIssues = refMutationIssues.filter((i) => i.severity === 'high');
      const mediumSeverityIssues = refMutationIssues.filter((i) => i.severity === 'medium');

      // At least some should be high severity (using state)
      expect(highSeverityIssues.length).toBeGreaterThan(0);

      // At least one should be medium severity (not using state - RenderPhaseRefWithoutState)
      expect(mediumSeverityIssues.length).toBeGreaterThan(0);
    });
  });
});
