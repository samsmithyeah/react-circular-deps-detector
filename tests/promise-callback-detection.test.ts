import { detectCircularDependencies } from '../src/detector';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
 * Tests for detecting unconditional setState calls inside promise callbacks.
 *
 * The key insight is that `.then()`, `.catch()`, and `.finally()` callbacks
 * on unconditionally-called promises are NOT truly conditional - if the promise
 * resolves/rejects, the callback WILL run.
 *
 * This is different from truly deferred callbacks like setTimeout/setInterval
 * which might never run (could be cleared).
 *
 * Pattern that causes infinite loop:
 *   useEffect(() => {
 *     fetchData().then(result => setState(result));
 *   }, [unstableRef]);  // unstableRef changes every render
 *
 * The setState inside .then() is "unconditional" because:
 * 1. The effect runs (because unstableRef changed)
 * 2. fetchData() is called unconditionally
 * 3. When the promise resolves, setState is called unconditionally
 * 4. setState triggers re-render
 * 5. unstableRef is recreated (new reference)
 * 6. Effect runs again -> infinite loop
 */
describe('Promise callback setState detection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcd-promise-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Basic .then() callback detection', () => {
    it('should detect setState inside .then() with unstable dependency as infinite loop', async () => {
      const testFile = path.join(tempDir, 'ThenCallback.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect } from 'react';

        function Component() {
          const [data, setData] = useState(null);

          // Unstable object - new reference every render
          const config = { url: '/api' };

          useEffect(() => {
            fetch(config.url).then(response => {
              setData(response);  // Unconditional setState inside .then()
            });
          }, [config]);

          return <div />;
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
      expect(issues[0].explanation).toMatch(/infinite|loop|unconditional/i);
    });

    it('should detect setState inside chained .then().then() as infinite loop', async () => {
      const testFile = path.join(tempDir, 'ChainedThen.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect } from 'react';

        function Component() {
          const [data, setData] = useState(null);

          const config = { url: '/api' };

          useEffect(() => {
            fetch(config.url)
              .then(response => response.json())
              .then(json => {
                setData(json);  // setState in second .then()
              });
          }, [config]);

          return <div />;
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

    it('should detect setState inside arrow function .then() callback', async () => {
      const testFile = path.join(tempDir, 'ArrowThen.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect } from 'react';

        function Component() {
          const [data, setData] = useState(null);

          const options = { method: 'GET' };

          useEffect(() => {
            fetchData().then(result => setData(result));
          }, [options]);

          return <div />;
        }

        function fetchData() {
          return Promise.resolve({ data: 'test' });
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

    it('should detect setState inside function expression .then() callback', async () => {
      const testFile = path.join(tempDir, 'FunctionExprThen.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect } from 'react';

        function Component() {
          const [data, setData] = useState(null);

          const options = { method: 'GET' };

          useEffect(() => {
            fetchData().then(function(result) {
              setData(result);
            });
          }, [options]);

          return <div />;
        }

        function fetchData() {
          return Promise.resolve({ data: 'test' });
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
  });

  describe('.catch() callback detection', () => {
    it('should detect setState inside .catch() with unstable dependency as infinite loop', async () => {
      const testFile = path.join(tempDir, 'CatchCallback.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect } from 'react';

        function Component() {
          const [error, setError] = useState(null);

          const config = { url: '/api' };

          useEffect(() => {
            fetch(config.url).catch(err => {
              setError(err);  // Unconditional setState inside .catch()
            });
          }, [config]);

          return <div />;
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
  });

  describe('.finally() callback detection', () => {
    it('should detect setState inside .finally() with unstable dependency as infinite loop', async () => {
      const testFile = path.join(tempDir, 'FinallyCallback.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect } from 'react';

        function Component() {
          const [loading, setLoading] = useState(true);

          const config = { url: '/api' };

          useEffect(() => {
            setLoading(true);
            fetch(config.url).finally(() => {
              setLoading(false);  // Unconditional setState inside .finally()
            });
          }, [config]);

          return <div />;
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
  });

  describe('Mixed promise chain detection', () => {
    it('should detect setState in .then().catch() chain', async () => {
      const testFile = path.join(tempDir, 'ThenCatchChain.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect } from 'react';

        function Component() {
          const [data, setData] = useState(null);
          const [error, setError] = useState(null);

          const config = { url: '/api' };

          useEffect(() => {
            fetch(config.url)
              .then(response => {
                setData(response);
              })
              .catch(err => {
                setError(err);
              });
          }, [config]);

          return <div />;
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
  });

  describe('Conditional setState inside promise callbacks', () => {
    it('should still detect loop when setState is conditional inside .then()', async () => {
      // Even if setState is inside an if statement within .then(),
      // we still consider it a potential loop because the effect runs every render
      const testFile = path.join(tempDir, 'ConditionalThen.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect } from 'react';

        function Component() {
          const [data, setData] = useState(null);

          const config = { url: '/api' };

          useEffect(() => {
            fetch(config.url).then(response => {
              if (response.ok) {
                setData(response);  // Conditional setState inside .then()
              }
            });
          }, [config]);

          return <div />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      // This should at least be flagged as a potential issue
      // (the unstable config causes the effect to run every render)
      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue'
      );
      expect(issues.length).toBeGreaterThan(0);
    });
  });

  describe('setTimeout/setInterval should remain conditional', () => {
    it('should NOT flag setState inside setTimeout as confirmed infinite loop', async () => {
      // setTimeout callbacks are truly deferred and might not run
      // (could be cleared, component unmounted, etc.)
      const testFile = path.join(tempDir, 'SetTimeoutCallback.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect } from 'react';

        function Component() {
          const [data, setData] = useState(null);

          const config = { delay: 1000 };

          useEffect(() => {
            const timer = setTimeout(() => {
              setData('loaded');  // setState inside setTimeout - truly deferred
            }, config.delay);
            return () => clearTimeout(timer);
          }, [config]);

          return <div />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      // Should be flagged as performance issue (unstable config), not confirmed loop
      // because the setTimeout callback is truly conditional (might be cleared)
      const confirmedLoops = result.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'confirmed-infinite-loop'
      );
      expect(confirmedLoops).toHaveLength(0);

      // But it should still be flagged as a potential issue (performance)
      const potentialIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'potential-issue'
      );
      expect(potentialIssues.length).toBeGreaterThan(0);
    });

    it('should NOT flag setState inside setInterval as confirmed infinite loop', async () => {
      const testFile = path.join(tempDir, 'SetIntervalCallback.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect } from 'react';

        function Component() {
          const [count, setCount] = useState(0);

          const config = { interval: 1000 };

          useEffect(() => {
            const intervalId = setInterval(() => {
              setCount(c => c + 1);  // setState inside setInterval
            }, config.interval);
            return () => clearInterval(intervalId);
          }, [config]);

          return <div />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      // Should be flagged as performance issue, not confirmed loop
      const confirmedLoops = result.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'confirmed-infinite-loop'
      );
      expect(confirmedLoops).toHaveLength(0);

      const potentialIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'potential-issue'
      );
      expect(potentialIssues.length).toBeGreaterThan(0);
    });
  });

  describe('async/await patterns', () => {
    it('should detect unconditional setState after await with unstable dependency', async () => {
      const testFile = path.join(tempDir, 'AsyncAwait.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect } from 'react';

        function Component() {
          const [data, setData] = useState(null);

          const config = { url: '/api' };

          useEffect(() => {
            async function fetchData() {
              const response = await fetch(config.url);
              setData(response);  // Unconditional setState after await
            }
            fetchData();
          }, [config]);

          return <div />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      // This is a known limitation - async/await is harder to analyze statically
      // The nested async function prevents detection.
      // At minimum it should be flagged as a potential issue (unstable config)
      const issues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'confirmed-infinite-loop' || issue.type === 'potential-issue'
      );
      expect(issues.length).toBeGreaterThan(0);
    });
  });

  describe('Real-world Cloudflare-style pattern', () => {
    it('should detect the exact Cloudflare outage pattern', async () => {
      // This is the exact pattern that caused the Cloudflare outage
      const testFile = path.join(tempDir, 'CloudflarePattern.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect } from 'react';

        export function BuggyDashboard({ onApiCall }) {
          const [userData, setUserData] = useState(null);

          // BUG: This object is recreated on EVERY render
          const apiConfig = {
            endpoint: '/api/tenant',
            method: 'GET',
            headers: { 'Authorization': 'Bearer xxx' }
          };

          useEffect(() => {
            // This runs on EVERY render because apiConfig is always "new"
            fakeApiCall('buggy').then(result => {
              onApiCall(result, 'buggy');
              setUserData(result);
            });
          }, [apiConfig]); // <-- THE BUG: object reference changes every render

          return <div>{userData}</div>;
        }

        function fakeApiCall(source) {
          return Promise.resolve({ data: source });
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
      expect(issues[0].problematicDependency).toBe('apiConfig');
      expect(issues[0].severity).toBe('high');
    });
  });

  describe('Safe patterns that should NOT be flagged as infinite loops', () => {
    it('should NOT flag stable dependency with .then() setState', async () => {
      const testFile = path.join(tempDir, 'StableThen.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect, useMemo } from 'react';

        function Component() {
          const [data, setData] = useState(null);

          // Stable reference via useMemo
          const config = useMemo(() => ({ url: '/api' }), []);

          useEffect(() => {
            fetch(config.url).then(response => {
              setData(response);
            });
          }, [config]);

          return <div />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const issues = result.intelligentHooksAnalysis.filter(
        (issue) =>
          issue.type === 'confirmed-infinite-loop' && issue.problematicDependency === 'config'
      );
      expect(issues).toHaveLength(0);
    });

    it('should NOT flag empty dependency array with .then() setState', async () => {
      const testFile = path.join(tempDir, 'EmptyDepsThen.tsx');
      fs.writeFileSync(
        testFile,
        `
        import { useState, useEffect } from 'react';

        function Component() {
          const [data, setData] = useState(null);

          useEffect(() => {
            fetch('/api').then(response => {
              setData(response);
            });
          }, []);  // Empty deps - runs once

          return <div />;
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
      expect(issues).toHaveLength(0);
    });
  });
});
