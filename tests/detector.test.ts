import { detectCircularDependencies } from '../src/detector';
import * as path from 'path';

describe('Circular Dependency Detector', () => {
  const fixturesPath = path.join(__dirname, 'fixtures');

  describe('Real Circular Dependencies', () => {
    it('should detect circular dependencies in problematic file', async () => {
      const result = await detectCircularDependencies(fixturesPath, {
        pattern: 'circular-example.tsx',
        ignore: [],
      });

      expect(result.circularDependencies.length).toBeGreaterThan(0);
      expect(result.summary.circularDependencies).toBeGreaterThan(0);

      // Check that it found the specific circular dependencies we created
      const cycles = result.circularDependencies.map((dep) => dep.cycle);

      // Should find functionA → functionB → functionA cycle
      const hasFunctionCycle = cycles.some(
        (cycle) => cycle.includes('functionA') && cycle.includes('functionB')
      );
      expect(hasFunctionCycle).toBe(true);
    });

    it('should provide detailed information about circular dependencies', async () => {
      const result = await detectCircularDependencies(fixturesPath, {
        pattern: 'circular-example.tsx',
        ignore: [],
      });

      expect(result.circularDependencies.length).toBeGreaterThan(0);

      result.circularDependencies.forEach((dep) => {
        expect(dep.file).toContain('circular-example.tsx');
        expect(dep.line).toBeGreaterThan(0);
        expect(dep.hookName).toMatch(/^use(Callback|Memo|Effect)$/);
        expect(dep.cycle).toBeInstanceOf(Array);
        expect(dep.cycle.length).toBeGreaterThanOrEqual(2);
      });
    });
  });

  describe('Clean Code (No Circular Dependencies)', () => {
    it('should not find circular dependencies in clean file', async () => {
      const result = await detectCircularDependencies(fixturesPath, {
        pattern: 'clean-example.tsx',
        ignore: [],
      });

      expect(result.circularDependencies).toHaveLength(0);
      expect(result.summary.circularDependencies).toBe(0);
      expect(result.summary.filesAnalyzed).toBe(1);
      expect(result.summary.hooksAnalyzed).toBeGreaterThan(0);
    });
  });

  describe('False Positive Prevention', () => {
    it('should not flag false positives as circular dependencies', async () => {
      const result = await detectCircularDependencies(fixturesPath, {
        pattern: 'false-positive-example.tsx',
        ignore: [],
      });

      expect(result.circularDependencies).toHaveLength(0);
      expect(result.summary.circularDependencies).toBe(0);
    });
  });

  describe('Multiple Files', () => {
    it('should analyze multiple files correctly', async () => {
      const result = await detectCircularDependencies(fixturesPath, {
        pattern: '*.tsx',
        ignore: [],
      });

      expect(result.summary.filesAnalyzed).toBe(8);
      expect(result.summary.hooksAnalyzed).toBeGreaterThan(0);

      // Should find circular dependencies in multiple files
      const circularFiles = result.circularDependencies.map((dep) => path.basename(dep.file));

      expect(circularFiles).toContain('circular-example.tsx');
      expect(circularFiles).toContain('real-circular-example.tsx');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty directories gracefully', async () => {
      const result = await detectCircularDependencies('/tmp/nonexistent', {
        pattern: '*.tsx',
        ignore: [],
      });

      expect(result.circularDependencies).toHaveLength(0);
      expect(result.summary.filesAnalyzed).toBe(0);
      expect(result.summary.hooksAnalyzed).toBe(0);
    });

    it('should handle ignore patterns correctly', async () => {
      const result = await detectCircularDependencies(fixturesPath, {
        pattern: '*.tsx',
        ignore: ['**/circular-example.tsx'],
      });

      // Should not analyze the ignored file
      expect(result.summary.filesAnalyzed).toBe(7); // 8 total - 1 ignored = 7
      const analyzedFilenames = result.circularDependencies.map((dep) => path.basename(dep.file));
      expect(analyzedFilenames.every((filename) => filename !== 'circular-example.tsx')).toBe(true);
      // May still find circular dependencies in other files like real-circular-example.tsx
    });
  });

  describe('Performance', () => {
    it('should complete analysis in reasonable time', async () => {
      const startTime = Date.now();

      await detectCircularDependencies(fixturesPath, {
        pattern: '*.tsx',
        ignore: [],
      });

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Should complete in under 5 seconds for small test files
      expect(duration).toBeLessThan(5000);
    });
  });
});
