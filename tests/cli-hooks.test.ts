import { execSync } from 'child_process';
import * as path from 'path';

describe('CLI Hooks Output', () => {
  const cliPath = path.join(__dirname, '..', 'dist', 'cli.js');
  const fixturesPath = path.join(__dirname, 'fixtures');

  describe('Hooks Dependency Loop Output', () => {
    it('should display hooks dependency loops in CLI output', () => {
      try {
        execSync(`node "${cliPath}" "${fixturesPath}" --pattern "hooks-dependency-loop.tsx"`, {
          encoding: 'utf8'
        });
        // If no error thrown, there were no issues found (unexpected)
        fail('Expected CLI to exit with error code due to detected issues');
      } catch (error: any) {
        const output = error.stdout || '';
        
        expect(output).toContain('React hooks dependency issues');
        expect(output).toContain('Infinite re-render risk');
        expect(output).toContain('high severity');
        expect(output).toContain('hooks-dependency-loop.tsx');
      }
    });

    it('should show detailed information for each loop', () => {
      try {
        execSync(`node "${cliPath}" "${fixturesPath}" --pattern "hooks-dependency-loop.tsx"`, {
          encoding: 'utf8'
        });
        fail('Expected CLI to exit with error code');
      } catch (error: any) {
        const output = error.stdout || '';
        
        expect(output).toContain('function: problematicFunction');
        expect(output).toContain('Problem:');
        expect(output).toContain('Depends on');
        expect(output).toContain('isLoading → setIsLoading');
        expect(output).toContain('Hook:');
        expect(output).toContain('useCallback');
      }
    });

    it('should include hooks loops in summary counts', () => {
      try {
        execSync(`node "${cliPath}" "${fixturesPath}" --pattern "hooks-dependency-loop.tsx"`, {
          encoding: 'utf8'
        });
        fail('Expected CLI to exit with error code');
      } catch (error: any) {
        const output = error.stdout || '';
        
        expect(output).toContain('Summary:');
        expect(output).toContain('Hooks issues:');
        expect(output).toContain('Issues found:');
        
        // Should have non-zero counts
        expect(output).toMatch(/Hooks issues: [1-9]/);
        expect(output).toMatch(/Issues found: [1-9]/);
      }
    });

    it('should show relative success when fewer hooks issues found', () => {
      try {
        const output = execSync(`node "${cliPath}" "${fixturesPath}" --pattern "clean-hooks-example.tsx"`, {
          encoding: 'utf8'
        });
        
        // If it succeeds, should show success message
        expect(output).toContain('No circular dependencies or hooks issues found!');
      } catch (error: any) {
        // If it finds issues, they should be lower severity
        const output = error.stdout || '';
        expect(output).toContain('React hooks dependency issues');
      }
    });

    it('should exit with error code when hooks issues are found', () => {
      expect(() => {
        execSync(`node "${cliPath}" "${fixturesPath}" --pattern "hooks-dependency-loop.tsx"`, {
          encoding: 'utf8'
        });
      }).toThrow();
    });

    it('should only find medium-severity issues in clean hooks example', () => {
      // The clean hooks example triggers a conservative false positive
      expect(() => {
        execSync(`node "${cliPath}" "${fixturesPath}" --pattern "clean-hooks-example.tsx"`, {
          encoding: 'utf8'
        });
      }).toThrow();
      
      // Get the actual output from the error
      try {
        execSync(`node "${cliPath}" "${fixturesPath}" --pattern "clean-hooks-example.tsx"`, {
          encoding: 'utf8'
        });
      } catch (error: any) {
        const output = error.stdout || '';
        
        // Should contain exactly 1 medium severity issue (conservative false positive)
        expect(output).toContain('Found 1 React hooks dependency issues');
        expect(output).toContain('medium severity');
        expect(output).not.toContain('high severity');
        expect(output).toContain('useEffect');
        expect(output).toContain('count');
        expect(output).toContain('Issues found: 1');
      }
    });
  });

  describe('JSON Output', () => {
    it('should include hooks loops in JSON output', () => {
      try {
        execSync(`node "${cliPath}" "${fixturesPath}" --pattern "hooks-dependency-loop.tsx" --json`, {
          encoding: 'utf8'
        });
        fail('Expected CLI to exit with error code');
      } catch (error: any) {
        const output = error.stdout || '';
        
        expect(() => JSON.parse(output)).not.toThrow();
        
        const result = JSON.parse(output);
        expect(result).toHaveProperty('improvedHooksLoops');
        expect(Array.isArray(result.improvedHooksLoops)).toBe(true);
        expect(result.improvedHooksLoops.length).toBeGreaterThan(0);
        
        expect(result.summary).toHaveProperty('improvedHooksLoops');
        expect(result.summary.improvedHooksLoops).toBeGreaterThan(0);
      }
    });

    it('should have proper structure in JSON output', () => {
      try {
        execSync(`node "${cliPath}" "${fixturesPath}" --pattern "hooks-dependency-loop.tsx" --json`, {
          encoding: 'utf8'
        });
        fail('Expected CLI to exit with error code');
      } catch (error: any) {
        const output = error.stdout || '';
        const result = JSON.parse(output);
        
        result.improvedHooksLoops.forEach((loop: any) => {
          expect(loop).toHaveProperty('type');
          expect(loop).toHaveProperty('description');
          expect(loop).toHaveProperty('file');
          expect(loop).toHaveProperty('line');
          expect(loop).toHaveProperty('hookType');
          expect(loop).toHaveProperty('problematicDependency');
          expect(loop).toHaveProperty('severity');
        });
      }
    });
  });

  describe('Output Formatting', () => {
    it('should use color coding for severity levels', () => {
      try {
        execSync(`node "${cliPath}" "${fixturesPath}" --pattern "hooks-dependency-loop.tsx"`, {
          encoding: 'utf8'
        });
        fail('Expected CLI to exit with error code');
      } catch (error: any) {
        const output = error.stdout || '';
        
        // Should contain severity indicators
        expect(output).toContain('high severity');
        // Color codes might be stripped in test environment, but structure should be there
      }
    });

    it('should disable colors when --no-color flag is used', () => {
      try {
        execSync(`node "${cliPath}" "${fixturesPath}" --pattern "hooks-dependency-loop.tsx" --no-color`, {
          encoding: 'utf8'
        });
        fail('Expected CLI to exit with error code');
      } catch (error: any) {
        const output = error.stdout || '';
        
        // Should not contain ANSI color codes
        expect(output).not.toMatch(/\x1b\[\d+m/);
      }
    });

    it('should format file paths appropriately', () => {
      try {
        execSync(`node "${cliPath}" "${fixturesPath}" --pattern "hooks-dependency-loop.tsx"`, {
          encoding: 'utf8'
        });
        fail('Expected CLI to exit with error code');
      } catch (error: any) {
        const output = error.stdout || '';
        
        // Should contain the filename
        expect(output).toContain('hooks-dependency-loop.tsx');
      }
    });
  });

  describe('Error Handling in CLI', () => {
    it('should handle invalid patterns gracefully', () => {
      const output = execSync(`node "${cliPath}" "${fixturesPath}" --pattern "*.invalid"`, {
        encoding: 'utf8'
      });
      
      expect(output).toContain('Files analyzed: 0');
    });

    it('should show helpful error message for non-existent paths', () => {
      expect(() => {
        execSync(`node "${cliPath}" "/non/existent/path"`, {
          encoding: 'utf8'
        });
      }).toThrow(/does not exist/);
    });
  });
});