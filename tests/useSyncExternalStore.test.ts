import { detectCircularDependencies } from '../src/detector';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('useSyncExternalStore Detection (RLD-407)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcd-sync-external-store-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Inline getSnapshot returning new object', () => {
    it('should detect inline arrow function returning object literal', async () => {
      // This is the most common bug pattern - causes synchronous infinite loop
      const testFile = path.join(tempDir, 'InlineObjectSnapshot.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useSyncExternalStore } from 'react';

        const store = {
          subscribe: (callback: () => void) => {
            return () => {};
          },
          getState: () => ({ count: 0 }),
        };

        function Counter() {
          // BUG: getSnapshot returns new object every call
          const state = useSyncExternalStore(
            store.subscribe,
            () => ({ count: store.getState().count })
          );

          return <div>{state.count}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-407'
      );

      expect(issues.length).toBe(1);
      expect(issues[0].type).toBe('confirmed-infinite-loop');
      expect(issues[0].category).toBe('critical');
      expect(issues[0].severity).toBe('high');
      expect(issues[0].hookType).toBe('useSyncExternalStore');
      expect(issues[0].explanation).toMatch(/getSnapshot.*returns.*new object/i);
    });

    it('should detect inline arrow function returning array literal', async () => {
      const testFile = path.join(tempDir, 'InlineArraySnapshot.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useSyncExternalStore } from 'react';

        const store = {
          subscribe: (cb: () => void) => () => {},
          getItems: () => ['a', 'b', 'c'],
        };

        function ItemList() {
          // BUG: getSnapshot returns new array every call
          const items = useSyncExternalStore(
            store.subscribe,
            () => [...store.getItems()]
          );

          return <ul>{items.map(i => <li key={i}>{i}</li>)}</ul>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-407'
      );

      expect(issues.length).toBe(1);
      expect(issues[0].type).toBe('confirmed-infinite-loop');
    });

    it('should detect function expression with return statement creating object', async () => {
      const testFile = path.join(tempDir, 'FunctionExpressionSnapshot.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useSyncExternalStore } from 'react';

        const store = {
          subscribe: (cb: () => void) => () => {},
          getValue: () => 42,
        };

        function Component() {
          // BUG: Function expression creates new object on return
          const data = useSyncExternalStore(
            store.subscribe,
            function getSnapshot() {
              return { value: store.getValue() };
            }
          );

          return <div>{data.value}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-407'
      );

      expect(issues.length).toBe(1);
      expect(issues[0].type).toBe('confirmed-infinite-loop');
    });
  });

  describe('Unstable function variable as getSnapshot', () => {
    it('should detect unstable function variable passed as getSnapshot', async () => {
      const testFile = path.join(tempDir, 'UnstableVariableSnapshot.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useSyncExternalStore } from 'react';

        const store = {
          subscribe: (cb: () => void) => () => {},
          getState: () => ({ count: 0 }),
        };

        function Counter() {
          // Function recreated on every render
          const getSnapshot = () => store.getState();

          // getSnapshot is recreated each render, causing re-subscriptions
          const state = useSyncExternalStore(store.subscribe, getSnapshot);

          return <div>{state.count}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-407'
      );

      expect(issues.length).toBe(1);
      expect(issues[0].type).toBe('potential-issue');
      expect(issues[0].category).toBe('performance');
      expect(issues[0].problematicDependency).toBe('getSnapshot');
    });
  });

  describe('Safe patterns (no detection)', () => {
    it('should NOT flag stable memoized getSnapshot', async () => {
      const testFile = path.join(tempDir, 'MemoizedSnapshot.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useSyncExternalStore, useCallback } from 'react';

        const store = {
          subscribe: (cb: () => void) => () => {},
          getState: () => ({ count: 0 }),
        };

        function Counter() {
          // Memoized - stable reference
          const getSnapshot = useCallback(() => store.getState(), []);

          const state = useSyncExternalStore(store.subscribe, getSnapshot);

          return <div>{state.count}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-407'
      );

      expect(issues.length).toBe(0);
    });

    it('should NOT flag module-level getSnapshot function', async () => {
      const testFile = path.join(tempDir, 'ModuleLevelSnapshot.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useSyncExternalStore } from 'react';

        const store = {
          subscribe: (cb: () => void) => () => {},
          getState: () => ({ count: 0 }),
        };

        // Defined at module level - stable
        const getSnapshot = () => store.getState();

        function Counter() {
          const state = useSyncExternalStore(store.subscribe, getSnapshot);
          return <div>{state.count}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-407'
      );

      expect(issues.length).toBe(0);
    });

    it('should NOT flag inline function returning primitive', async () => {
      const testFile = path.join(tempDir, 'PrimitiveSnapshot.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useSyncExternalStore } from 'react';

        let count = 0;
        const subscribe = (cb: () => void) => () => {};

        function Counter() {
          // Returns primitive - safe (primitives compared by value)
          const value = useSyncExternalStore(
            subscribe,
            () => count
          );

          return <div>{value}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-407'
      );

      expect(issues.length).toBe(0);
    });

    it('should NOT flag store.getSnapshot method reference', async () => {
      const testFile = path.join(tempDir, 'StoreMethodSnapshot.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useSyncExternalStore } from 'react';

        const store = {
          subscribe: (cb: () => void) => () => {},
          getSnapshot: () => ({ count: 0 }),
        };

        function Counter() {
          // Method reference - stable (bound to store object)
          const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
          return <div>{state.count}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-407'
      );

      expect(issues.length).toBe(0);
    });
  });

  describe('Ignore comments', () => {
    it('should respect rld-ignore-next-line comment', async () => {
      const testFile = path.join(tempDir, 'IgnoredSnapshot.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useSyncExternalStore } from 'react';

        const store = {
          subscribe: (cb: () => void) => () => {},
          getState: () => ({ count: 0 }),
        };

        function Counter() {
          // rld-ignore-next-line
          const state = useSyncExternalStore(
            store.subscribe,
            () => ({ count: store.getState().count })
          );

          return <div>{state.count}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-407'
      );

      expect(issues.length).toBe(0);
    });
  });

  describe('Real-world patterns', () => {
    it('should detect Zustand-like selector returning new object', async () => {
      const testFile = path.join(tempDir, 'ZustandSelector.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useSyncExternalStore } from 'react';

        // Simulated Zustand-like store
        const store = {
          state: { user: { name: 'John', email: 'john@example.com' }, count: 0 },
          listeners: new Set<() => void>(),
          subscribe(listener: () => void) {
            this.listeners.add(listener);
            return () => this.listeners.delete(listener);
          },
          getState() {
            return this.state;
          }
        };

        function UserInfo() {
          // BUG: Creates new object on every call
          const user = useSyncExternalStore(
            (cb) => store.subscribe(cb),
            () => ({ name: store.getState().user.name })
          );

          return <div>{user.name}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-407'
      );

      expect(issues.length).toBe(1);
      expect(issues[0].type).toBe('confirmed-infinite-loop');
    });

    it('should detect browser API wrapper with unstable snapshot', async () => {
      const testFile = path.join(tempDir, 'MediaQueryHook.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useSyncExternalStore } from 'react';

        function useMediaQuery(query: string) {
          const subscribe = (callback: () => void) => {
            const mql = window.matchMedia(query);
            mql.addEventListener('change', callback);
            return () => mql.removeEventListener('change', callback);
          };

          // BUG: Returns new object with matches property
          return useSyncExternalStore(
            subscribe,
            () => ({ matches: window.matchMedia(query).matches, query })
          );
        }

        function Component() {
          const { matches } = useMediaQuery('(min-width: 768px)');
          return <div>{matches ? 'Desktop' : 'Mobile'}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-407'
      );

      expect(issues.length).toBe(1);
    });
  });

  describe('Edge cases', () => {
    it('should handle useSyncExternalStore with only 2 arguments', async () => {
      const testFile = path.join(tempDir, 'TwoArguments.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useSyncExternalStore } from 'react';

        const store = {
          subscribe: (cb: () => void) => () => {},
          getState: () => ({ count: 0 }),
        };

        function Counter() {
          // Valid 2-argument call, but with unstable snapshot
          const state = useSyncExternalStore(
            store.subscribe,
            () => ({ count: store.getState().count })
          );

          return <div>{state.count}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-407'
      );

      expect(issues.length).toBe(1);
    });

    it('should handle useSyncExternalStore with 3 arguments (getServerSnapshot)', async () => {
      const testFile = path.join(tempDir, 'ThreeArguments.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useSyncExternalStore } from 'react';

        const store = {
          subscribe: (cb: () => void) => () => {},
          getState: () => ({ count: 0 }),
        };

        function Counter() {
          // 3-argument call with server snapshot
          const state = useSyncExternalStore(
            store.subscribe,
            () => ({ count: store.getState().count }),  // Unstable
            () => ({ count: 0 })  // Server snapshot
          );

          return <div>{state.count}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-407'
      );

      // Should detect the unstable getSnapshot (2nd argument)
      expect(issues.length).toBe(1);
    });

    it('should handle multiple useSyncExternalStore calls in same component', async () => {
      const testFile = path.join(tempDir, 'MultipleStores.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useSyncExternalStore } from 'react';

        const userStore = {
          subscribe: (cb: () => void) => () => {},
          getState: () => ({ name: 'John' }),
        };

        const countStore = {
          subscribe: (cb: () => void) => () => {},
          getState: () => 0,
        };

        function Dashboard() {
          // First store - unstable
          const user = useSyncExternalStore(
            userStore.subscribe,
            () => ({ name: userStore.getState().name })
          );

          // Second store - stable (returns primitive)
          const count = useSyncExternalStore(
            countStore.subscribe,
            () => countStore.getState()
          );

          return <div>{user.name}: {count}</div>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-407'
      );

      // Should only detect the first unstable one
      expect(issues.length).toBe(1);
      expect(issues[0].line).toBeLessThan(20); // First store
    });
  });
});
