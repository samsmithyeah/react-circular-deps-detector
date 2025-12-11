import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('CLI Integration', () => {
  let tempDir: string;
  const cliPath = path.join(__dirname, '..', 'dist', 'cli.js');

  beforeAll(() => {
    // Ensure the CLI is built
    try {
      execSync('npm run build', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
    } catch {
      throw new Error('Failed to build CLI before tests');
    }
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcd-cli-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Basic CLI Functionality', () => {
    it('should show help when --help flag is used', () => {
      const output = execSync(`node ${cliPath} --help`, { encoding: 'utf8' });

      expect(output).toContain('Detect circular import dependencies and React hooks');
      expect(output).toContain('--pattern');
      expect(output).toContain('--ignore');
      expect(output).toContain('--json');
    });

    it('should show version when --version flag is used', () => {
      const output = execSync(`node ${cliPath} --version`, { encoding: 'utf8' });

      expect(output.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('should exit with error code 1 when path does not exist', () => {
      expect(() => {
        execSync(`node ${cliPath} /nonexistent/path`, { encoding: 'utf8' });
      }).toThrow();
    });
  });

  describe('File Analysis', () => {
    it('should analyze clean files and exit with code 0', () => {
      const testFile = path.join(tempDir, 'clean.tsx');
      fs.writeFileSync(
        testFile,
        `
        import React, { useState, useCallback } from 'react';
        
        function CleanComponent() {
          const [count, setCount] = useState(0);
          
          const increment = useCallback(() => {
            setCount(prev => prev + 1);
          }, []);
          
          return <div onClick={increment}>Count: {count}</div>;
        }
      `
      );

      const output = execSync(`node ${cliPath} ${tempDir}`, { encoding: 'utf8' });

      expect(output).toContain('All clear! No issues found');
      expect(output).toMatch(/1 files? • \d+ hooks?/);
    });

    it('should detect circular dependencies and exit with code 1', () => {
      const testFile = path.join(tempDir, 'circular.tsx');
      fs.writeFileSync(
        testFile,
        `
        import React, { useCallback } from 'react';
        
        function CircularComponent() {
          const funcA = useCallback(() => {
            funcB();
          }, [funcB]);
          
          const funcB = useCallback(() => {
            funcA();
          }, [funcA]);
          
          return <div />;
        }
      `
      );

      expect(() => {
        execSync(`node ${cliPath} ${tempDir}`, { encoding: 'utf8' });
      }).toThrow(); // Should exit with code 1
    });
  });

  describe('Output Formats', () => {
    it('should support JSON output format', () => {
      const testFile = path.join(tempDir, 'test.tsx');
      fs.writeFileSync(
        testFile,
        `
        import React, { useState } from 'react';
        function Component() {
          const [state] = useState(0);
          return <div>{state}</div>;
        }
      `
      );

      const output = execSync(`node ${cliPath} ${tempDir} --json`, { encoding: 'utf8' });

      const jsonResult = JSON.parse(output) as {
        circularDependencies: unknown[];
        summary: {
          filesAnalyzed: number;
          hooksAnalyzed: number;
          circularDependencies: number;
        };
      };

      expect(jsonResult).toHaveProperty('circularDependencies');
      expect(jsonResult).toHaveProperty('summary');
      expect(jsonResult.summary).toHaveProperty('filesAnalyzed');
      expect(jsonResult.summary).toHaveProperty('hooksAnalyzed');
      expect(jsonResult.summary).toHaveProperty('circularDependencies');
    });

    it('should support colored output by default', () => {
      const testFile = path.join(tempDir, 'test.tsx');
      fs.writeFileSync(
        testFile,
        `
        import React from 'react';
        function Component() {
          return <div />;
        }
      `
      );

      const output = execSync(`node ${cliPath} ${tempDir}`, { encoding: 'utf8' });

      // Should contain colored output (ANSI escape codes)
      expect(output).toContain('✓');
      expect(output).toMatch(/\d+ files? • \d+ hooks?/);
    });

    it('should disable colors when --no-color is used', () => {
      const testFile = path.join(tempDir, 'test.tsx');
      fs.writeFileSync(
        testFile,
        `
        import React from 'react';
        function Component() {
          return <div />;
        }
      `
      );

      const output = execSync(`node ${cliPath} ${tempDir} --no-color`, { encoding: 'utf8' });

      // Should contain plain text output
      expect(output).toContain('All clear! No issues found');
    });
  });

  describe('File Pattern Options', () => {
    it('should respect custom file patterns', () => {
      const jsFile = path.join(tempDir, 'component.js');
      const tsFile = path.join(tempDir, 'component.ts');

      fs.writeFileSync(
        jsFile,
        `
        import React from 'react';
        function Component() { return React.createElement('div'); }
      `
      );
      fs.writeFileSync(
        tsFile,
        `
        const utils = { helper: () => {} };
      `
      );

      // Only analyze .js files
      const output = execSync(`node ${cliPath} ${tempDir} --pattern "*.js"`, { encoding: 'utf8' });

      expect(output).toMatch(/1 files? •/);
    });

    it('should respect ignore patterns', () => {
      const file1 = path.join(tempDir, 'component.tsx');
      const file2 = path.join(tempDir, 'ignored.tsx');

      fs.writeFileSync(
        file1,
        `
        import React from 'react';
        function Component() { return <div />; }
      `
      );
      fs.writeFileSync(
        file2,
        `
        import React from 'react';
        function Ignored() { return <div />; }
      `
      );

      const output = execSync(`node ${cliPath} ${tempDir} --ignore "**/ignored.tsx"`, {
        encoding: 'utf8',
      });

      expect(output).toMatch(/1 files? •/);
    });
  });

  describe('Error Handling', () => {
    it('should handle parsing errors gracefully', () => {
      const testFile = path.join(tempDir, 'invalid.tsx');
      fs.writeFileSync(
        testFile,
        `
        import React from 'react'
        // Invalid syntax
        function Component() {
          const [count setCount] = useState(0); // Missing comma
          return <div />;
        }
      `
      );

      const output = execSync(`node ${cliPath} ${tempDir}`, { encoding: 'utf8' });

      // Should continue and show results even with parsing errors
      expect(output).toMatch(/\d+ files? •/);
    });
  });
});
