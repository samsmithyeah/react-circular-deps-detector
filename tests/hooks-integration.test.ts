import { detectCircularDependencies } from '../src/detector';
import * as path from 'path';

describe('Hooks Integration Tests', () => {
  const fixturesPath = path.join(__dirname, 'fixtures');

  describe('Full Detection Pipeline', () => {
    it('should detect hooks dependency loops in integration', async () => {
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: 'hooks-dependency-loop.tsx',
        ignore: []
      });

      expect(results).toHaveProperty('improvedHooksLoops');
      expect(results.improvedHooksLoops.length).toBeGreaterThan(0);
      
      expect(results.summary.improvedHooksLoops).toBeGreaterThan(0);
      expect(results.summary.filesAnalyzed).toBe(1);
    });

    it('should have fewer issues in clean hooks file', async () => {
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: 'clean-hooks-example.tsx',
        ignore: []
      });

      // Clean hooks should have fewer high-severity issues
      const highSeverityIssues = results.improvedHooksLoops.filter(l => l.severity === 'high');
      expect(highSeverityIssues.length).toBeLessThanOrEqual(1);
    });

    it('should handle edge cases without crashing', async () => {
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: 'edge-case-hooks.tsx',
        ignore: []
      });

      expect(results).toHaveProperty('improvedHooksLoops');
      expect(Array.isArray(results.improvedHooksLoops)).toBe(true);
    });

    it('should include hooks loops in total issue count', async () => {
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: 'hooks-dependency-loop.tsx',
        ignore: []
      });

      const totalExpected = 
        results.summary.circularDependencies + 
        results.summary.crossFileCycles + 
        results.summary.hooksDependencyLoops + 
        results.summary.simpleHooksLoops + 
        results.summary.improvedHooksLoops;

      expect(totalExpected).toBeGreaterThan(0);
    });
  });

  describe('Multiple Analyzer Integration', () => {
    it('should run all analyzers without conflicts', async () => {
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: '*.tsx',
        ignore: ['clean-*']
      });

      expect(results).toHaveProperty('circularDependencies');
      expect(results).toHaveProperty('crossFileCycles');
      expect(results).toHaveProperty('hooksDependencyLoops');
      expect(results).toHaveProperty('simpleHooksLoops');
      expect(results).toHaveProperty('improvedHooksLoops');

      // Verify all result arrays exist and have expected structure
      expect(results.circularDependencies).toBeDefined();
      expect(results.crossFileCycles).toBeDefined();
      expect(results.hooksDependencyLoops).toBeDefined();
      expect(results.simpleHooksLoops).toBeDefined();
      expect(results.improvedHooksLoops).toBeDefined();
    });

    it('should provide comprehensive summary', async () => {
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: 'hooks-dependency-loop.tsx',
        ignore: []
      });

      expect(results.summary).toHaveProperty('filesAnalyzed');
      expect(results.summary).toHaveProperty('hooksAnalyzed');
      expect(results.summary).toHaveProperty('circularDependencies');
      expect(results.summary).toHaveProperty('crossFileCycles');
      expect(results.summary).toHaveProperty('hooksDependencyLoops');
      expect(results.summary).toHaveProperty('simpleHooksLoops');
      expect(results.summary).toHaveProperty('improvedHooksLoops');

      expect(results.summary.filesAnalyzed).toBeGreaterThan(0);
      expect(results.summary.hooksAnalyzed).toBeGreaterThan(0);
    });
  });

  describe('Performance and Scalability', () => {
    it('should handle multiple files efficiently', async () => {
      const startTime = Date.now();
      
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: '*.{tsx,ts}',
        ignore: []
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
        ignore: []
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
        ignore: []
      });
      
      expect(results.summary.filesAnalyzed).toBe(0);
    });

    it('should continue processing other files when one file fails', async () => {
      // Mix of valid and potentially problematic files
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: '*.{tsx,ts}',
        ignore: []
      });

      expect(results.summary.filesAnalyzed).toBeGreaterThan(0);
      // Should have processed files even if some had issues
    });
  });

  describe('Real-world Patterns', () => {
    it('should detect patterns similar to SignalContext issue', async () => {
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: 'hooks-dependency-loop.tsx',
        ignore: []
      });

      // Should detect state-setter-dependency patterns
      const hasStateDependencyPattern = results.improvedHooksLoops.some(loop => 
        loop.type === 'state-setter-dependency'
      );

      expect(hasStateDependencyPattern).toBe(true);
    });

    it('should provide actionable error messages', async () => {
      const results = await detectCircularDependencies(fixturesPath, {
        pattern: 'hooks-dependency-loop.tsx',
        ignore: []
      });

      results.improvedHooksLoops.forEach(loop => {
        expect(loop.description).toContain('creating infinite');
        expect(loop.description.length).toBeGreaterThan(20);
        expect(loop.file).toContain('.tsx');
        expect(loop.line).toBeGreaterThan(0);
      });
    });
  });
});