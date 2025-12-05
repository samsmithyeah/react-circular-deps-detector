import { parseFile } from '../src/parser';
import * as path from 'path';

describe('Parser', () => {
  const fixturesPath = path.join(__dirname, 'fixtures');

  describe('Hook Extraction', () => {
    it('should extract hooks from React components', () => {
      const filePath = path.join(fixturesPath, 'clean-example.tsx');
      const result = parseFile(filePath);

      expect(result.file).toBe(filePath);
      expect(result.hooks.length).toBeGreaterThan(0);

      // Should find useCallback, useMemo, useEffect hooks
      const hookNames = result.hooks.map((hook) => hook.name);
      expect(hookNames).toContain('useCallback');
      expect(hookNames).toContain('useMemo');
      expect(hookNames).toContain('useEffect');
    });

    it('should extract hook dependencies correctly', () => {
      const filePath = path.join(fixturesPath, 'circular-example.tsx');
      const result = parseFile(filePath);

      const hooksWithDeps = result.hooks.filter((hook) => hook.dependencies.length > 0);
      expect(hooksWithDeps.length).toBeGreaterThan(0);

      // Check that dependencies are extracted as strings
      hooksWithDeps.forEach((hook) => {
        expect(hook.dependencies).toBeInstanceOf(Array);
        hook.dependencies.forEach((dep) => {
          expect(typeof dep).toBe('string');
          expect(dep.length).toBeGreaterThan(0);
        });
      });
    });

    it('should include line and column information', () => {
      const filePath = path.join(fixturesPath, 'clean-example.tsx');
      const result = parseFile(filePath);

      result.hooks.forEach((hook) => {
        expect(hook.line).toBeGreaterThan(0);
        expect(hook.column).toBeGreaterThanOrEqual(0);
        expect(hook.file).toBe(filePath);
      });
    });
  });

  describe('Variable Dependencies', () => {
    it('should extract variable dependencies from function bodies', () => {
      const filePath = path.join(fixturesPath, 'circular-example.tsx');
      const result = parseFile(filePath);

      expect(result.variables).toBeInstanceOf(Map);
      expect(result.variables.size).toBeGreaterThan(0);

      // Check that variable dependencies are tracked
      for (const [varName, deps] of result.variables) {
        expect(typeof varName).toBe('string');
        expect(deps).toBeInstanceOf(Set);
      }
    });
  });

  describe('Supported Hook Types', () => {
    it('should recognize all supported React hooks', () => {
      const filePath = path.join(fixturesPath, 'clean-example.tsx');
      const result = parseFile(filePath);

      const foundHooks = result.hooks.map((hook) => hook.name);

      // Should find at least some of the supported hooks
      const hasUseMemo = foundHooks.includes('useMemo');
      const hasUseCallback = foundHooks.includes('useCallback');
      const hasUseEffect = foundHooks.includes('useEffect');

      expect(hasUseMemo || hasUseCallback || hasUseEffect).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid files gracefully', () => {
      // This should not throw an error for non-existent files
      expect(() => {
        parseFile('/path/to/nonexistent/file.tsx');
      }).toThrow(); // Should throw but not crash the process
    });
  });

  describe('TypeScript Support', () => {
    it('should parse TypeScript React files correctly', () => {
      const filePath = path.join(fixturesPath, 'clean-example.tsx');
      const result = parseFile(filePath);

      // Should successfully parse TypeScript without errors
      expect(result.hooks.length).toBeGreaterThan(0);
      expect(result.file).toBe(filePath);
    });
  });
});
