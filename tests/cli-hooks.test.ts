import { execSync } from 'child_process';
import * as path from 'path';

interface ExecError extends Error {
  stdout?: string;
  stderr?: string;
  status?: number;
}

interface IntelligentAnalysis {
  type: string;
  description: string;
  file: string;
  line: number;
  hookType: string;
  problematicDependency: string;
  severity: string;
  confidence: string;
  explanation: string;
}

describe('CLI Hooks Output', () => {
  const cliPath = path.join(__dirname, '..', 'dist', 'cli.js');
  const fixturesPath = path.join(__dirname, 'fixtures');

  describe('Hooks Dependency Loop Output', () => {
    it('should display hooks dependency loops in CLI output', () => {
      try {
        execSync(`node "${cliPath}" "${fixturesPath}" --pattern "hooks-dependency-loop.tsx"`, {
          encoding: 'utf8',
        });
        // If no error thrown, there were no issues found (unexpected)
        fail('Expected CLI to exit with error code due to detected issues');
      } catch (error: unknown) {
        const execError = error as ExecError;
        const output = execError.stdout || '';

        expect(output).toContain('Confirmed infinite loops:');
        expect(output).toContain('[RLD-200]');
        expect(output).toContain('critical issue');
        expect(output).toContain('hooks-dependency-loop.tsx');
      }
    });

    it('should show detailed information for each loop', () => {
      try {
        execSync(`node "${cliPath}" "${fixturesPath}" --pattern "hooks-dependency-loop.tsx"`, {
          encoding: 'utf8',
        });
        fail('Expected CLI to exit with error code');
      } catch (error: unknown) {
        const execError = error as ExecError;
        const output = execError.stdout || '';

        expect(output).toContain('📍 Location:');
        expect(output).toContain('❌ Problem:');
        expect(output).toContain('depends on');
        expect(output).toContain('isLoading');
        expect(output).toContain('setIsLoading');
        expect(output).toContain('useEffect'); // Changed from useCallback - useEffect can cause confirmed loops
      }
    });

    it('should include hooks loops in summary counts', () => {
      try {
        execSync(`node "${cliPath}" "${fixturesPath}" --pattern "hooks-dependency-loop.tsx"`, {
          encoding: 'utf8',
        });
        fail('Expected CLI to exit with error code');
      } catch (error: unknown) {
        const execError = error as ExecError;
        const output = execError.stdout || '';

        // Summary is now shown at the top with the verdict
        expect(output).toMatch(/\d+ critical issue/);
        expect(output).toMatch(/\d+ infinite loop/);
        expect(output).toContain('Confirmed infinite loops:');
      }
    });

    it('should show relative success when fewer hooks issues found', () => {
      try {
        const output = execSync(
          `node "${cliPath}" "${fixturesPath}" --pattern "clean-hooks-example.tsx"`,
          {
            encoding: 'utf8',
          }
        );

        // If it succeeds, should show success message
        expect(output).toContain('All clear! No issues found');
      } catch (error: unknown) {
        // If it finds issues, they should be lower severity
        const execError = error as ExecError;
        const output = execError.stdout || '';
        expect(output).toMatch(/issue.*found/);
      }
    });

    it('should exit with error code when hooks issues are found', () => {
      expect(() => {
        execSync(`node "${cliPath}" "${fixturesPath}" --pattern "hooks-dependency-loop.tsx"`, {
          encoding: 'utf8',
        });
      }).toThrow();
    });

    it('should not find issues in clean hooks example with intelligent analyzer', () => {
      // With the intelligent analyzer, clean hooks should not cause errors
      const output = execSync(
        `node "${cliPath}" "${fixturesPath}" --pattern "clean-hooks-example.tsx"`,
        {
          encoding: 'utf8',
        }
      );

      expect(output).toContain('All clear! No issues found');
      expect(output).toMatch(/\d+ files? • \d+ hooks?/);
      expect(output).not.toContain('Confirmed infinite loops:');
    });
  });

  describe('JSON Output', () => {
    it('should include hooks loops in JSON output', () => {
      // JSON output still exits with error code when issues found, so use try/catch
      try {
        execSync(
          `node "${cliPath}" "${fixturesPath}" --pattern "hooks-dependency-loop.tsx" --json`,
          {
            encoding: 'utf8',
          }
        );
        fail('Expected CLI to exit with error code');
      } catch (error: unknown) {
        const execError = error as ExecError;
        const output = execError.stdout || '';

        expect(() => JSON.parse(output)).not.toThrow();

        const result = JSON.parse(output);
        expect(result).toHaveProperty('intelligentHooksAnalysis');
        expect(Array.isArray(result.intelligentHooksAnalysis)).toBe(true);
        expect(result.intelligentHooksAnalysis.length).toBeGreaterThan(0);

        // Check for confirmed infinite loops in intelligent analysis
        const confirmedLoops = result.intelligentHooksAnalysis.filter(
          (a: IntelligentAnalysis) => a.type === 'confirmed-infinite-loop'
        );
        expect(confirmedLoops.length).toBeGreaterThan(0);

        expect(result.summary).toHaveProperty('intelligentAnalysisCount');
        expect(result.summary.intelligentAnalysisCount).toBeGreaterThan(0);
      }
    });

    it('should have proper structure in JSON output', () => {
      try {
        execSync(
          `node "${cliPath}" "${fixturesPath}" --pattern "hooks-dependency-loop.tsx" --json`,
          {
            encoding: 'utf8',
          }
        );
        fail('Expected CLI to exit with error code');
      } catch (error: unknown) {
        const execError = error as ExecError;
        const output = execError.stdout || '';
        const result = JSON.parse(output);

        // Check intelligent analyzer results (the primary analyzer)
        expect(result.intelligentHooksAnalysis).toBeDefined();
        expect(result.intelligentHooksAnalysis.length).toBeGreaterThan(0);

        result.intelligentHooksAnalysis.forEach((analysis: IntelligentAnalysis) => {
          expect(analysis).toHaveProperty('type');
          expect(analysis).toHaveProperty('description');
          expect(analysis).toHaveProperty('file');
          expect(analysis).toHaveProperty('line');
          expect(analysis).toHaveProperty('hookType');
          expect(analysis).toHaveProperty('problematicDependency');
          expect(analysis).toHaveProperty('severity');
          expect(analysis).toHaveProperty('confidence');
          expect(analysis).toHaveProperty('explanation');
        });

        // Check for at least one confirmed infinite loop
        const hasConfirmedLoop = result.intelligentHooksAnalysis.some(
          (a: IntelligentAnalysis) => a.type === 'confirmed-infinite-loop'
        );
        expect(hasConfirmedLoop).toBe(true);
      }
    });
  });

  describe('Output Formatting', () => {
    it('should use color coding for severity levels', () => {
      try {
        execSync(`node "${cliPath}" "${fixturesPath}" --pattern "hooks-dependency-loop.tsx"`, {
          encoding: 'utf8',
        });
        fail('Expected CLI to exit with error code');
      } catch (error: unknown) {
        const execError = error as ExecError;
        const output = execError.stdout || '';

        // Should contain critical issue indicators
        expect(output).toContain('critical issue');
        expect(output).toContain('Confirmed infinite loops:');
      }
    });

    it('should disable colors when --no-color flag is used', () => {
      try {
        execSync(
          `node "${cliPath}" "${fixturesPath}" --pattern "hooks-dependency-loop.tsx" --no-color`,
          {
            encoding: 'utf8',
          }
        );
        fail('Expected CLI to exit with error code');
      } catch (error: unknown) {
        const execError = error as ExecError;
        const output = execError.stdout || '';

        // Should not contain ANSI color codes
        expect(output).not.toMatch(/\x1b\[\d+m/);
      }
    });

    it('should format file paths appropriately', () => {
      try {
        execSync(`node "${cliPath}" "${fixturesPath}" --pattern "hooks-dependency-loop.tsx"`, {
          encoding: 'utf8',
        });
        fail('Expected CLI to exit with error code');
      } catch (error: unknown) {
        const execError = error as ExecError;
        const output = execError.stdout || '';

        // Should contain the filename
        expect(output).toContain('hooks-dependency-loop.tsx');
      }
    });
  });

  describe('Error Handling in CLI', () => {
    it('should handle invalid patterns gracefully', () => {
      const output = execSync(`node "${cliPath}" "${fixturesPath}" --pattern "*.invalid"`, {
        encoding: 'utf8',
      });

      expect(output).toMatch(/0 files •/);
    });

    it('should show helpful error message for non-existent paths', () => {
      expect(() => {
        execSync(`node "${cliPath}" "/non/existent/path"`, {
          encoding: 'utf8',
        });
      }).toThrow(/does not exist/);
    });
  });
});
