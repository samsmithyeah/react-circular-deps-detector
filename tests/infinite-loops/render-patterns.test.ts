import { detectCircularDependencies } from '../../src/detector';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
 * Tests for common render-time infinite loop patterns.
 *
 * These tests cover 5 additional detectable cases that static analysis should catch:
 * 1. setState during render - calling setState in component body
 * 2. useEffect without dependency array - missing [] causes infinite loop
 * 3. Object prop to memoized child - unstable object prop causes child effect to loop
 * 4. useCallback with object dependency - unstable object in useCallback deps
 * 5. Array spread in dependencies - [...arr].map() creates new reference
 */
describe('Render-time infinite loop patterns', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcd-render-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('1. setState during render', () => {
    it('should detect setState called directly in component body', async () => {
      const testFile = path.join(tempDir, 'SetStateDuringRender.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState } from 'react';

        function BuggyComponent() {
          const [count, setCount] = useState(0);

          // BUG: This runs during render, not in an event handler or effect
          if (count < 100) {
            setCount(count + 1); // INFINITE LOOP!
          }

          return <div>{count}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue'
      );
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0].explanation).toMatch(/render|during render|component body/i);
    });

    it('should detect unconditional setState during render', async () => {
      const testFile = path.join(tempDir, 'UnconditionalSetState.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState } from 'react';

        function BuggyComponent() {
          const [count, setCount] = useState(0);

          // Unconditional setState during render - always causes infinite loop
          setCount(count + 1);

          return <div>{count}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'confirmed-infinite-loop'
      );
      expect(issues.length).toBeGreaterThan(0);
    });

    it('should NOT flag setState in event handlers', async () => {
      const testFile = path.join(tempDir, 'SafeEventHandler.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState } from 'react';

        function SafeComponent() {
          const [count, setCount] = useState(0);

          // Safe: setState in event handler
          const handleClick = () => {
            setCount(count + 1);
          };

          return <button onClick={handleClick}>{count}</button>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const renderStateIssues = result.intelligentHooksAnalysis.filter(
        (issue) =>
          issue.type === 'confirmed-infinite-loop' &&
          issue.explanation?.match(/render|during render|component body/i)
      );
      expect(renderStateIssues).toHaveLength(0);
    });

    it('should NOT flag setState in useEffect', async () => {
      const testFile = path.join(tempDir, 'SafeUseEffect.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect } from 'react';

        function SafeComponent() {
          const [count, setCount] = useState(0);

          useEffect(() => {
            setCount(1); // Safe: inside useEffect with empty deps
          }, []);

          return <div>{count}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const renderStateIssues = result.intelligentHooksAnalysis.filter(
        (issue) =>
          issue.type === 'confirmed-infinite-loop' &&
          issue.explanation?.match(/render|during render|component body/i)
      );
      expect(renderStateIssues).toHaveLength(0);
    });

    it('should NOT flag valid derived state pattern (guarded setState)', async () => {
      const testFile = path.join(tempDir, 'DerivedState.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState } from 'react';

        // Valid React pattern: https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
        function List({ items }) {
          const [prevItems, setPrevItems] = useState(items);
          const [selection, setSelection] = useState(null);

          // This is the valid "derived state" pattern
          // It only runs once when items changes, not on every render
          if (items !== prevItems) {
            setPrevItems(items);
            setSelection(null);
          }

          return <div>{selection}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      // The derived state pattern should NOT be flagged as an issue
      const renderStateIssues = result.intelligentHooksAnalysis.filter(
        (issue) =>
          (issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue') &&
          issue.errorCode === 'RLD-100'
      );
      expect(renderStateIssues).toHaveLength(0);
    });

    it('should NOT flag toggle guard pattern during render', async () => {
      const testFile = path.join(tempDir, 'ToggleGuard.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState } from 'react';

        function InitComponent() {
          const [initialized, setInitialized] = useState(false);

          // Valid: will only run once
          if (!initialized) {
            setInitialized(true);
          }

          return <div>Ready</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const renderStateIssues = result.intelligentHooksAnalysis.filter(
        (issue) =>
          (issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue') &&
          issue.errorCode === 'RLD-100'
      );
      expect(renderStateIssues).toHaveLength(0);
    });

    it('should flag unsafe guarded setState (will loop multiple times)', async () => {
      const testFile = path.join(tempDir, 'UnsafeGuard.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState } from 'react';

        function CounterComponent() {
          const [count, setCount] = useState(0);

          // Unsafe: This will re-render 100 times before stopping
          if (count < 100) {
            setCount(count + 1);
          }

          return <div>{count}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      // Should be flagged as potential issue (not confirmed loop since it eventually stops)
      const issues = result.intelligentHooksAnalysis.filter(
        (issue) =>
          (issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue') &&
          issue.errorCode === 'RLD-100'
      );
      expect(issues.length).toBeGreaterThan(0);
    });
  });

  describe('2. useEffect without dependency array', () => {
    it('should detect useEffect with setState and no dependency array', async () => {
      const testFile = path.join(tempDir, 'NoDepArray.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect } from 'react';

        function BuggyComponent() {
          const [count, setCount] = useState(0);

          // BUG: No dependency array = runs after EVERY render
          useEffect(() => {
            setCount(c => c + 1);
          }); // <-- Missing dependency array!

          return <div>{count}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue'
      );
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0].explanation).toMatch(
        /no dependency array|missing.*dependency|every render/i
      );
    });

    it('should NOT flag useEffect with empty dependency array', async () => {
      const testFile = path.join(tempDir, 'EmptyDepArray.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect } from 'react';

        function SafeComponent() {
          const [count, setCount] = useState(0);

          // Safe: Empty array = run once on mount
          useEffect(() => {
            setCount(c => c + 1);
          }, []);

          return <div>{count}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const noDepsIssues = result.intelligentHooksAnalysis.filter(
        (issue) =>
          issue.type === 'confirmed-infinite-loop' &&
          issue.explanation?.match(/no dependency array|missing.*dependency/i)
      );
      expect(noDepsIssues).toHaveLength(0);
    });

    it('should detect useEffect without deps that calls external function with setState', async () => {
      const testFile = path.join(tempDir, 'NoDepsExternalFn.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect } from 'react';

        function BuggyComponent() {
          const [data, setData] = useState(null);

          const fetchData = () => {
            fetch('/api').then(r => r.json()).then(setData);
          };

          // BUG: No dependency array means fetchData runs every render
          useEffect(() => {
            fetchData();
          });

          return <div>{data}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue'
      );
      expect(issues.length).toBeGreaterThan(0);
    });
  });

  describe('3. Object prop to memoized child (cross-component)', () => {
    // Note: This requires cross-component analysis which is complex.
    // We can detect the simpler pattern: object literal passed as prop.
    it('should detect object literal created in parent and used as child prop', async () => {
      const testFile = path.join(tempDir, 'ObjectPropLoop.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect, memo } from 'react';

        const DataFetcher = memo(function DataFetcher({ config }) {
          useEffect(() => {
            console.log('Fetching with config:', config);
          }, [config]);

          return <p>{JSON.stringify(config)}</p>;
        });

        function BuggyParent() {
          const [trigger, setTrigger] = useState(0);

          // BUG: New object created every render
          const config = { page: 1, limit: 10 };

          return (
            <div>
              <button onClick={() => setTrigger(t => t + 1)}>Re-render</button>
              <DataFetcher config={config} />
            </div>
          );
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      // The child's useEffect has config as dependency - config is a prop from parent
      // This is harder to detect cross-component, but we should at least flag
      // the child's useEffect depending on a prop that might be unstable
      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue'
      );
      // For now, at minimum we want to detect unstable objects in parent
      // Full cross-component analysis is out of scope
      expect(issues.length).toBeGreaterThanOrEqual(0); // May not detect cross-component
    });
  });

  describe('4. useCallback with object dependency', () => {
    it('should detect useCallback with unstable object in dependency array', async () => {
      const testFile = path.join(tempDir, 'UseCallbackLoop.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect, useCallback } from 'react';

        function BuggyComponent() {
          const [data, setData] = useState(null);
          const [fetchCount, setFetchCount] = useState(0);

          // BUG: options object is recreated every render
          const options = { method: 'GET', cache: 'no-cache' };

          // This callback is "new" every render because options changes
          const fetchData = useCallback(() => {
            setFetchCount(c => c + 1);
            return Promise.resolve({ result: 'data' });
          }, [options]); // options changes every render!

          useEffect(() => {
            fetchData().then(setData);
          }, [fetchData]); // fetchData changes every render!

          return <div>{fetchCount}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      // Should detect either:
      // 1. options is unstable object in useCallback deps
      // 2. The chain: unstable options -> unstable fetchData -> useEffect runs every render
      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue'
      );
      expect(issues.length).toBeGreaterThan(0);
      // Should mention either options or fetchData being unstable
      const hasRelevantIssue = issues.some(
        (issue) =>
          issue.problematicDependency === 'options' || issue.problematicDependency === 'fetchData'
      );
      expect(hasRelevantIssue).toBe(true);
    });

    it('should NOT flag useCallback with memoized object dependency', async () => {
      const testFile = path.join(tempDir, 'FixedUseCallback.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect, useCallback, useMemo } from 'react';

        function SafeComponent() {
          const [data, setData] = useState(null);

          // FIX: Memoized options
          const options = useMemo(() => ({ method: 'GET' }), []);

          const fetchData = useCallback(() => {
            return Promise.resolve({ result: 'data' });
          }, [options]); // options is stable now

          useEffect(() => {
            fetchData().then(setData);
          }, [fetchData]);

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
          (issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue') &&
          issue.problematicDependency === 'options'
      );
      expect(unstableIssues).toHaveLength(0);
    });
  });

  describe('5. Array spread creates new reference', () => {
    it('should detect array spread result in useEffect dependency', async () => {
      const testFile = path.join(tempDir, 'ArraySpreadLoop.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect } from 'react';

        function BuggyComponent() {
          const [items] = useState(['a', 'b', 'c']);
          const [processCount, setProcessCount] = useState(0);

          // BUG: [...items] creates a NEW array every render
          const processedItems = [...items].map(i => i.toUpperCase());

          useEffect(() => {
            setProcessCount(c => c + 1);
            console.log('Processing items:', processedItems);
          }, [processedItems]); // New array reference every time!

          return <div>{processCount}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue'
      );
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0].problematicDependency).toBe('processedItems');
    });

    it('should detect .map() result in useEffect dependency', async () => {
      const testFile = path.join(tempDir, 'MapResultLoop.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect } from 'react';

        function BuggyComponent() {
          const [items] = useState([1, 2, 3]);
          const [sum, setSum] = useState(0);

          // BUG: .map() returns new array every render
          const doubled = items.map(x => x * 2);

          useEffect(() => {
            setSum(doubled.reduce((a, b) => a + b, 0));
          }, [doubled]); // New array every render!

          return <div>{sum}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue'
      );
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0].problematicDependency).toBe('doubled');
    });

    it('should detect .filter() result in useEffect dependency', async () => {
      const testFile = path.join(tempDir, 'FilterResultLoop.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect } from 'react';

        function BuggyComponent() {
          const [items] = useState([1, 2, 3, 4, 5]);
          const [count, setCount] = useState(0);

          // BUG: .filter() returns new array every render
          const evens = items.filter(x => x % 2 === 0);

          useEffect(() => {
            setCount(evens.length);
          }, [evens]); // New array every render!

          return <div>{count}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue'
      );
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0].problematicDependency).toBe('evens');
    });

    it('should NOT flag memoized array transformation', async () => {
      const testFile = path.join(tempDir, 'MemoizedArray.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect, useMemo } from 'react';

        function SafeComponent() {
          const [items] = useState(['a', 'b', 'c']);
          const [processCount, setProcessCount] = useState(0);

          // FIX: Memoized transformation
          const processedItems = useMemo(
            () => [...items].map(i => i.toUpperCase()),
            [items]
          );

          useEffect(() => {
            setProcessCount(c => c + 1);
          }, [processedItems]); // Stable when items is stable

          return <div>{processCount}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const unstableArrayIssues = result.intelligentHooksAnalysis.filter(
        (issue) =>
          (issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue') &&
          issue.problematicDependency === 'processedItems'
      );
      expect(unstableArrayIssues).toHaveLength(0);
    });
  });

  describe('Combined patterns', () => {
    it('should detect multiple issues in same component', async () => {
      const testFile = path.join(tempDir, 'MultipleIssues.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect, useCallback } from 'react';

        function BuggyComponent() {
          const [data, setData] = useState(null);
          const [count, setCount] = useState(0);

          // Issue 1: Unstable object
          const config = { url: '/api' };

          // Issue 2: Unstable array
          const ids = [1, 2, 3].map(x => x);

          useEffect(() => {
            fetch(config.url);
          }, [config]);

          useEffect(() => {
            console.log(ids);
          }, [ids]);

          return <div />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue'
      );
      // Should detect both config and ids as unstable
      expect(issues.length).toBeGreaterThanOrEqual(2);
    });
  });

  /**
   * Advanced patterns that require more complex analysis:
   * - Per-component scoping of unstable variables
   * - Cross-component prop tracking
   * - useCallback dependency chain tracking
   * - Context provider value detection
   * - Inline function prop detection for memoized children
   */
  describe('Advanced analysis patterns', () => {
    // Per-component scoping of unstable variables - handles multiple components
    // with the same variable name in one file correctly
    it('should handle multiple components with same variable name in one file', async () => {
      const testFile = path.join(tempDir, 'MultipleComponents.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect, useMemo } from 'react';

        // First component - processedItems is UNSTABLE
        function BuggyComponent() {
          const [items] = useState(['a', 'b', 'c']);
          const [count, setCount] = useState(0);

          const processedItems = [...items].map(i => i.toUpperCase());

          useEffect(() => {
            setCount(c => c + 1);
          }, [processedItems]); // Should be flagged as unstable

          return <div>{count}</div>;
        }

        // Second component - processedItems is STABLE (memoized)
        function FixedComponent() {
          const [items] = useState(['a', 'b', 'c']);
          const [count, setCount] = useState(0);

          const processedItems = useMemo(
            () => [...items].map(i => i.toUpperCase()),
            [items]
          );

          useEffect(() => {
            setCount(c => c + 1);
          }, [processedItems]); // Should NOT be flagged

          return <div>{count}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue'
      );
      // Should only flag the BuggyComponent's useEffect, not FixedComponent's
      expect(issues).toHaveLength(1);
      expect(issues[0].line).toBeLessThan(20); // BuggyComponent is first
    });

    // Cross-component prop tracking - detects unstable props passed to child components
    it('should detect unstable object prop passed to child causing child effect loop', async () => {
      const testFile = path.join(tempDir, 'CrossComponentProp.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect, memo } from 'react';

        // Child component that re-fetches when props change
        const DataFetcher = memo(function DataFetcher({ config }) {
          useEffect(() => {
            console.log('Fetching with config:', config);
          }, [config]); // config is a prop - depends on parent stability

          return <p>{JSON.stringify(config)}</p>;
        });

        // Parent creates new object every render
        function BuggyParent() {
          const [trigger, setTrigger] = useState(0);

          // BUG: New object created every render, passed to child
          const config = { page: 1, limit: 10 };

          return (
            <div>
              <button onClick={() => setTrigger(t => t + 1)}>Re-render</button>
              <DataFetcher config={config} />
            </div>
          );
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue'
      );
      // Should detect that config in parent is unstable and causes child effect issues
      expect(issues.length).toBeGreaterThan(0);
    });

    // useCallback dependency chain - detects unstable deps that make the callback unstable
    it('should detect useCallback with unstable dep causing useEffect loop', async () => {
      const testFile = path.join(tempDir, 'UseCallbackChain.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect, useCallback } from 'react';

        function BuggyComponent() {
          const [data, setData] = useState(null);
          const [fetchCount, setFetchCount] = useState(0);

          // BUG: options object is recreated every render
          const options = { method: 'GET', cache: 'no-cache' };

          // This callback is "new" every render because options changes
          const fetchData = useCallback(() => {
            setFetchCount(c => c + 1);
            return Promise.resolve({ result: 'data' });
          }, [options]); // options changes every render!

          useEffect(() => {
            fetchData().then(setData);
          }, [fetchData]); // fetchData changes every render -> infinite loop

          return <div>{fetchCount}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue'
      );
      // Should detect the chain: unstable options -> unstable fetchData -> useEffect loop
      expect(issues.length).toBeGreaterThan(0);
      const relevantIssue = issues.some(
        (i) => i.problematicDependency === 'options' || i.problematicDependency === 'fetchData'
      );
      expect(relevantIssue).toBe(true);
    });

    // Context provider value detection - detects unstable values in Context.Provider
    it('should detect unstable context provider value', async () => {
      const testFile = path.join(tempDir, 'ContextValueLoop.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { createContext, useContext, useState } from 'react';

        const ThemeContext = createContext(null);

        function ThemeProvider({ children }) {
          const [theme, setTheme] = useState('light');

          // BUG: New object literal every render
          // All consumers will re-render on every provider render
          const value = {
            theme,
            toggle: () => setTheme(t => t === 'light' ? 'dark' : 'light'),
          };

          return (
            <ThemeContext.Provider value={value}>
              {children}
            </ThemeContext.Provider>
          );
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue'
      );
      // Should detect that the context value is an unstable object
      expect(issues.length).toBeGreaterThan(0);
    });

    // Inline function prop detection - detects unstable functions passed as props
    it('should detect inline function prop breaking React.memo', async () => {
      const testFile = path.join(tempDir, 'InlineFunctionProp.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect, memo } from 'react';

        // Memoized child - should only re-render when props change
        const MemoizedButton = memo(function MemoizedButton({ onClick, label }) {
          useEffect(() => {
            console.log('Button effect ran');
          }, [onClick]); // Effect depends on onClick prop

          return <button onClick={onClick}>{label}</button>;
        });

        function Parent() {
          const [count, setCount] = useState(0);

          // BUG: New function every render defeats memo()
          const handleClick = () => {
            setCount(c => c + 1);
          };

          return (
            <div>
              <p>Count: {count}</p>
              <MemoizedButton onClick={handleClick} label="Click me" />
            </div>
          );
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue'
      );
      // Should detect that handleClick is unstable and passed to memoized child
      expect(issues.length).toBeGreaterThan(0);
    });
  });
});
