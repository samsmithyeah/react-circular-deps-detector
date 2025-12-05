import { detectCircularDependencies } from '../src/detector';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('Unstable Reference Detection (Cloudflare-style bugs)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcd-unstable-ref-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Object literals in dependency arrays', () => {
    it('should detect inline object in useEffect dependency array', async () => {
      // This is the exact Cloudflare bug pattern
      const testFile = path.join(tempDir, 'BuggyComponent.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect } from 'react';

        function BuggyComponent() {
          const [userData, setUserData] = useState(null);

          // BUG: Object recreated on every render
          const apiConfig = {
            endpoint: '/api/tenant',
            method: 'GET',
          };

          useEffect(() => {
            fetch(apiConfig.endpoint).then(r => r.json()).then(setUserData);
          }, [apiConfig]); // Infinite loop - apiConfig is new object each render

          return <div>{userData}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      // Should detect the unstable reference
      const unstableIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue'
      );
      expect(unstableIssues.length).toBeGreaterThan(0);
      expect(unstableIssues[0].explanation).toMatch(/unstable|object|reference|recreated/i);
    });

    it('should detect array literal in useEffect dependency array', async () => {
      const testFile = path.join(tempDir, 'ArrayDep.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useEffect, useState } from 'react';

        function ArrayDep() {
          const [data, setData] = useState([]);

          const options = ['a', 'b', 'c'];

          useEffect(() => {
            setData(options);
          }, [options]); // Array recreated every render

          return <div />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const unstableIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue'
      );
      expect(unstableIssues.length).toBeGreaterThan(0);
    });

    it('should detect function expression in useEffect dependency array', async () => {
      const testFile = path.join(tempDir, 'FunctionDep.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useEffect, useState } from 'react';

        function FunctionDep() {
          const [count, setCount] = useState(0);

          // Function recreated every render
          const handleClick = () => {
            console.log('clicked');
          };

          useEffect(() => {
            document.addEventListener('click', handleClick);
            return () => document.removeEventListener('click', handleClick);
          }, [handleClick]); // Function reference changes each render

          return <div>{count}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const unstableIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue'
      );
      expect(unstableIssues.length).toBeGreaterThan(0);
    });
  });

  describe('Safe patterns that should NOT be flagged', () => {
    it('should NOT flag useMemo-wrapped objects', async () => {
      const testFile = path.join(tempDir, 'MemoizedObject.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect, useMemo } from 'react';

        function MemoizedObject() {
          const [userData, setUserData] = useState(null);

          // Safe: memoized object
          const apiConfig = useMemo(() => ({
            endpoint: '/api/tenant',
            method: 'GET',
          }), []);

          useEffect(() => {
            fetch(apiConfig.endpoint).then(r => r.json()).then(setUserData);
          }, [apiConfig]); // Safe - apiConfig is stable

          return <div>{userData}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const unstableIssues = result.intelligentHooksAnalysis.filter(
        (issue) =>
          issue.type === 'confirmed-infinite-loop' &&
          issue.explanation?.match(/unstable|object|reference/i)
      );
      expect(unstableIssues).toHaveLength(0);
    });

    it('should NOT flag useCallback-wrapped functions', async () => {
      const testFile = path.join(tempDir, 'CallbackWrapped.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useEffect, useState, useCallback } from 'react';

        function CallbackWrapped() {
          const [count, setCount] = useState(0);

          // Safe: memoized callback
          const handleClick = useCallback(() => {
            console.log('clicked');
          }, []);

          useEffect(() => {
            document.addEventListener('click', handleClick);
            return () => document.removeEventListener('click', handleClick);
          }, [handleClick]); // Safe - handleClick is stable

          return <div>{count}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const unstableIssues = result.intelligentHooksAnalysis.filter(
        (issue) =>
          issue.type === 'confirmed-infinite-loop' &&
          issue.explanation?.match(/unstable|function|reference/i)
      );
      expect(unstableIssues).toHaveLength(0);
    });

    it('should NOT flag primitive values', async () => {
      const testFile = path.join(tempDir, 'Primitives.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useEffect, useState } from 'react';

        function Primitives() {
          const [data, setData] = useState(null);

          const count = 5;
          const name = 'test';
          const flag = true;

          useEffect(() => {
            setData({ count, name, flag });
          }, [count, name, flag]); // Safe - primitives have stable identity

          return <div />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const unstableIssues = result.intelligentHooksAnalysis.filter(
        (issue) =>
          issue.type === 'confirmed-infinite-loop' &&
          issue.explanation?.match(/unstable|reference/i)
      );
      expect(unstableIssues).toHaveLength(0);
    });

    it('should NOT flag state variables', async () => {
      const testFile = path.join(tempDir, 'StateVars.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useEffect, useState } from 'react';

        function StateVars() {
          const [user, setUser] = useState({ name: 'John' });

          useEffect(() => {
            console.log('User changed:', user.name);
          }, [user]); // Safe - state managed by React

          return <div />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      // State variables are managed by React and don't cause unstable reference issues
      const unstableIssues = result.intelligentHooksAnalysis.filter(
        (issue) =>
          issue.type === 'confirmed-infinite-loop' &&
          issue.explanation?.match(/unstable.*reference/i)
      );
      expect(unstableIssues).toHaveLength(0);
    });

    it('should NOT flag useRef values', async () => {
      const testFile = path.join(tempDir, 'RefValues.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useEffect, useRef } from 'react';

        function RefValues() {
          const configRef = useRef({ endpoint: '/api' });

          useEffect(() => {
            fetch(configRef.current.endpoint);
          }, [configRef]); // Safe - ref is stable

          return <div />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const unstableIssues = result.intelligentHooksAnalysis.filter(
        (issue) =>
          issue.type === 'confirmed-infinite-loop' &&
          issue.explanation?.match(/unstable|reference/i)
      );
      expect(unstableIssues).toHaveLength(0);
    });

    it('should NOT flag module-level constants', async () => {
      const testFile = path.join(tempDir, 'ModuleConstants.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useEffect, useState } from 'react';

        // Module-level constant - only created once
        const API_CONFIG = {
          endpoint: '/api/tenant',
          method: 'GET',
        };

        function ModuleConstants() {
          const [data, setData] = useState(null);

          useEffect(() => {
            fetch(API_CONFIG.endpoint).then(r => r.json()).then(setData);
          }, [API_CONFIG]); // Safe - module constant is stable

          return <div />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const unstableIssues = result.intelligentHooksAnalysis.filter(
        (issue) =>
          issue.type === 'confirmed-infinite-loop' &&
          issue.explanation?.match(/unstable|reference/i)
      );
      expect(unstableIssues).toHaveLength(0);
    });
  });

  describe('Edge cases', () => {
    it('should detect objects created inside component but used in useCallback deps', async () => {
      const testFile = path.join(tempDir, 'CallbackDeps.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useCallback, useState } from 'react';

        function CallbackDeps() {
          const config = { timeout: 5000 };

          const fetchData = useCallback(() => {
            return fetch('/api', { timeout: config.timeout });
          }, [config]); // config is recreated each render

          return <div />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      // useCallback with unstable dep causes unnecessary re-creation
      const unstableIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'potential-issue' || issue.type === 'confirmed-infinite-loop'
      );
      expect(unstableIssues.length).toBeGreaterThan(0);
    });

    it('should detect objects created via function call in component body', async () => {
      const testFile = path.join(tempDir, 'FunctionCallObject.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useEffect, useState } from 'react';

        function createConfig() {
          return { endpoint: '/api' };
        }

        function FunctionCallObject() {
          const [data, setData] = useState(null);

          const config = createConfig(); // New object each render

          useEffect(() => {
            fetch(config.endpoint).then(r => r.json()).then(setData);
          }, [config]); // Infinite loop

          return <div />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const unstableIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue'
      );
      expect(unstableIssues.length).toBeGreaterThan(0);
    });

    it('should detect destructured variables from unstable function calls', async () => {
      const testFile = path.join(tempDir, 'DestructuredUnstable.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useEffect, useState } from 'react';

        function getUnstableObject() {
          return { a: Math.random(), b: 'test' };
        }

        function DestructuredUnstable() {
          const [data, setData] = useState(null);

          const { a, b } = getUnstableObject(); // Destructured from unstable source

          useEffect(() => {
            setData({ a, b });
          }, [a]); // 'a' is unstable - new value each render

          return <div />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const unstableIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue'
      );
      expect(unstableIssues.length).toBeGreaterThan(0);
      expect(unstableIssues[0].problematicDependency).toBe('a');
    });

    it('should NOT flag destructured variables from React hooks', async () => {
      const testFile = path.join(tempDir, 'DestructuredFromHook.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useEffect, useState } from 'react';

        function useCustomHook() {
          return { value: 1, setValue: () => {} };
        }

        function DestructuredFromHook() {
          const { value, setValue } = useCustomHook(); // From hook - stable

          useEffect(() => {
            console.log(value);
          }, [value]); // Safe - hook return values are managed by React

          return <div />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const unstableIssues = result.intelligentHooksAnalysis.filter(
        (issue) =>
          issue.type === 'confirmed-infinite-loop' &&
          issue.explanation?.match(/unstable|reference/i)
      );
      expect(unstableIssues).toHaveLength(0);
    });
  });
});
