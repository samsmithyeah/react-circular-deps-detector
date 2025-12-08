/**
 * Tests for false positive cases discovered in story-app
 *
 * These tests ensure the detector doesn't flag legitimate patterns as issues:
 * 1. Variables wrapped in useCallback/useMemo
 * 2. Primitive values (strings from .join(), numbers from Math.round())
 * 3. Zustand's getState() pattern for stable actions
 */

import { analyzeHooks } from '../src/orchestrator';
import { parseFile, ParsedFile } from '../src/parser';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Helper to create a temp file and parse it
function createTestFile(content: string): ParsedFile {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcd-test-'));
  const filePath = path.join(tempDir, 'test.tsx');
  fs.writeFileSync(filePath, content);
  const parsed = parseFile(filePath);
  // Cleanup
  fs.unlinkSync(filePath);
  fs.rmdirSync(tempDir);
  return parsed;
}

describe('Story-App False Positives', () => {
  describe('useCallback-wrapped functions should be stable', () => {
    it('should NOT flag functions wrapped in useCallback as unstable', () => {
      // From IllustrationSelection.tsx - loadStyles is wrapped in useCallback
      const parsed = createTestFile(`
        import React, { useCallback, useEffect, useState } from 'react';

        export function IllustrationSelection() {
          const [styles, setStyles] = useState([]);
          const [loading, setLoading] = useState(false);

          const loadStyles = useCallback(async () => {
            setLoading(true);
            try {
              const loadedStyles = await fetchStyles();
              setStyles(loadedStyles);
            } finally {
              setLoading(false);
            }
          }, []);

          // Load styles on mount
          useEffect(() => {
            loadStyles();
          }, [loadStyles]);

          return <div>{styles.length} styles</div>;
        }

        async function fetchStyles() { return []; }
      `);

      const results = analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // loadStyles is wrapped in useCallback with [] deps, so it's stable
      expect(issues).toHaveLength(0);
    });

    it('should NOT flag useMemo-wrapped values as unstable', () => {
      const parsed = createTestFile(`
        import React, { useMemo, useEffect, useState } from 'react';

        export function Component() {
          const [items, setItems] = useState([]);

          const sortedItems = useMemo(() => {
            return [...items].sort((a, b) => a.name.localeCompare(b.name));
          }, [items]);

          useEffect(() => {
            console.log('Sorted items changed:', sortedItems.length);
          }, [sortedItems]);

          return <div>{sortedItems.length}</div>;
        }
      `);

      const results = analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // sortedItems is wrapped in useMemo, so it's stable when items is stable
      expect(issues).toHaveLength(0);
    });

    it('should NOT flag React.useCallback-wrapped functions as unstable', () => {
      // From IllustrationSelection.tsx - loadStyles is wrapped in React.useCallback
      const parsed = createTestFile(`
        import React, { useEffect, useState } from 'react';

        export function IllustrationSelection() {
          const [styles, setStyles] = useState([]);
          const [loading, setLoading] = useState(false);

          const loadStyles = React.useCallback(async () => {
            setLoading(true);
            try {
              const loadedStyles = await fetchStyles();
              setStyles(loadedStyles);
            } finally {
              setLoading(false);
            }
          }, []);

          // Load styles on mount
          useEffect(() => {
            loadStyles();
          }, [loadStyles]);

          return <div>{styles.length} styles</div>;
        }

        async function fetchStyles() { return []; }
      `);

      const results = analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // loadStyles is wrapped in React.useCallback with [] deps, so it's stable
      expect(issues).toHaveLength(0);
    });

    it('should NOT flag React.useMemo-wrapped values as unstable', () => {
      const parsed = createTestFile(`
        import React, { useEffect, useState } from 'react';

        export function Component() {
          const [items, setItems] = useState([]);

          const sortedItems = React.useMemo(() => {
            return [...items].sort((a, b) => a.name.localeCompare(b.name));
          }, [items]);

          useEffect(() => {
            console.log('Sorted items changed:', sortedItems.length);
          }, [sortedItems]);

          return <div>{sortedItems.length}</div>;
        }
      `);

      const results = analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // sortedItems is wrapped in React.useMemo, so it's stable
      expect(issues).toHaveLength(0);
    });
  });

  describe('Primitive values should be stable', () => {
    it('should NOT flag string from .join() as unstable', () => {
      // From CharacterSelection.tsx - childrenTimestampKey is a string
      const parsed = createTestFile(`
        import React, { useEffect, useState } from 'react';

        interface Child {
          id: string;
          updatedAt?: Date;
          createdAt?: Date;
        }

        export function CharacterSelection({ savedChildren }: { savedChildren: Child[] }) {
          const [photoUrls, setPhotoUrls] = useState<string[]>([]);

          // Create stable key for detecting when photos need to be reloaded
          const childrenTimestampKey = savedChildren
            .map((c) => \`\${c.id}-\${c.updatedAt?.getTime() || c.createdAt?.getTime()}\`)
            .join(",");

          useEffect(() => {
            const loadPhotoUrls = async () => {
              const urls = await Promise.all(
                savedChildren.map(async (child) => {
                  return await getAuthenticatedUrl(child.id);
                })
              );
              setPhotoUrls(urls);
            };

            if (savedChildren.length > 0) {
              loadPhotoUrls();
            }
          }, [savedChildren, childrenTimestampKey]);

          return <div>{photoUrls.length} photos</div>;
        }

        async function getAuthenticatedUrl(id: string) { return ''; }
      `);

      const results = analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // childrenTimestampKey is a string (primitive), compared by value not reference
      expect(issues).toHaveLength(0);
    });

    it('should NOT flag number from Math.round() as unstable', () => {
      // From StoryViewer.tsx - textPanelMaxHeight is a number
      const parsed = createTestFile(`
        import React, { useCallback, useState } from 'react';

        export function StoryViewer() {
          const [pages, setPages] = useState([]);
          const availableHeight = 800;
          const textPanelMaxPct = 0.48;

          const textPanelMaxHeight = Math.round(availableHeight * textPanelMaxPct);

          const renderPage = useCallback(
            (page: any, index: number) => {
              return (
                <div key={index} style={{ maxHeight: textPanelMaxHeight }}>
                  {page.text}
                </div>
              );
            },
            [textPanelMaxHeight]
          );

          return <div>{pages.map(renderPage)}</div>;
        }
      `);

      const results = analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // textPanelMaxHeight is a number (primitive), compared by value not reference
      expect(issues).toHaveLength(0);
    });

    it('should NOT flag boolean expressions as unstable', () => {
      const parsed = createTestFile(`
        import React, { useCallback, useState } from 'react';

        export function Component({ items }: { items: any[] }) {
          const hasItems = items.length > 0;
          const isEmpty = !hasItems;

          const handleClick = useCallback(() => {
            if (hasItems) {
              console.log('Has items');
            }
          }, [hasItems]);

          return <button onClick={handleClick}>{isEmpty ? 'Empty' : 'Has items'}</button>;
        }
      `);

      const results = analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // hasItems is a boolean (primitive)
      expect(issues).toHaveLength(0);
    });
  });

  describe('Zustand getState() pattern should be stable', () => {
    it('should NOT flag actions from useStore.getState() as unstable', () => {
      // From index.tsx - setStories comes from useLibraryStore.getState()
      const parsed = createTestFile(`
        import React, { useCallback, useEffect, useState } from 'react';
        import { useLibraryStore } from './store';

        export function LibraryScreen() {
          const stories = useLibraryStore((state) => state.stories);
          const [refreshing, setRefreshing] = useState(false);

          // Actions are stable and won't cause re-renders
          const { setStories, setShouldPreserveState } = useLibraryStore.getState();

          const handleRefresh = useCallback(async () => {
            setRefreshing(true);
            try {
              const newStories = await getStories();
              setStories(newStories);
            } finally {
              setRefreshing(false);
            }
          }, [setStories]);

          const openStory = useCallback(
            (storyId: string) => {
              setShouldPreserveState(true);
              navigate(storyId);
            },
            [setShouldPreserveState]
          );

          return <div>{stories.length} stories</div>;
        }

        async function getStories() { return []; }
        function navigate(id: string) {}
      `);

      const results = analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // setStories and setShouldPreserveState come from getState(), which returns stable refs
      expect(issues).toHaveLength(0);
    });

    it('should NOT flag actions from any store.getState() pattern', () => {
      const parsed = createTestFile(`
        import React, { useCallback } from 'react';
        import { useAuthStore } from './authStore';
        import { useCartStore } from './cartStore';

        export function Component() {
          const { login, logout } = useAuthStore.getState();
          const { addItem, removeItem, clearCart } = useCartStore.getState();

          const handleLogin = useCallback(() => {
            login('user@example.com');
          }, [login]);

          const handleAddToCart = useCallback((item: any) => {
            addItem(item);
          }, [addItem]);

          return <button onClick={handleLogin}>Login</button>;
        }
      `);

      const results = analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // All actions from getState() should be stable
      expect(issues).toHaveLength(0);
    });
  });

  describe('Array filter/sort without memoization', () => {
    it('should flag as potential-issue (not infinite loop) when setState is conditional', () => {
      // From credits.tsx - subscriptions array is recreated each render
      // This is flagged as potential-issue (not confirmed-infinite-loop) because:
      // 1. subscriptions is recreated every render (new array from .filter().sort())
      // 2. This WILL cause the useEffect to run on every render
      // 3. BUT setState is conditional, so it won't cause infinite re-renders
      const parsed = createTestFile(`
        import React, { useEffect, useState } from 'react';

        interface Package {
          product: { price: number; identifier: string };
        }

        export function CreditsScreen({ offerings }: { offerings: { availablePackages: Package[] } | null }) {
          const [selectedPackage, setSelectedPackage] = useState<Package | null>(null);

          // These arrays are recreated on every render - performance issue
          const subscriptions = (
            offerings?.availablePackages.filter((pkg) =>
              pkg.product.identifier.includes('subscription')
            ) || []
          ).sort((a, b) => a.product.price - b.product.price);

          useEffect(() => {
            if (!offerings?.availablePackages) return;

            // Only auto-select if nothing is currently selected (CONDITIONAL)
            if (!selectedPackage) {
              const popular = subscriptions.find((pkg) => pkg.product.price > 0);
              if (popular) {
                setSelectedPackage(popular);
              }
            }
          }, [offerings, subscriptions, selectedPackage]);

          return <div>{subscriptions.length} subscriptions</div>;
        }
      `);

      const results = analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');
      const potentialIssues = results.filter((r) => r.type === 'potential-issue');

      // Should NOT be flagged as infinite loop (setState is conditional)
      expect(infiniteLoops).toHaveLength(0);

      // SHOULD be flagged as potential issue (performance concern)
      expect(potentialIssues.length).toBeGreaterThan(0);
      expect(potentialIssues[0].problematicDependency).toBe('subscriptions');
      // Performance issues (unstable references) now have low severity
      expect(potentialIssues[0].severity).toBe('low');
      expect(potentialIssues[0].category).toBe('performance');
    });

    it('SHOULD flag as confirmed-infinite-loop when setState is unconditional', () => {
      // This is a TRUE infinite loop - setState is called unconditionally
      const parsed = createTestFile(`
        import React, { useEffect, useState } from 'react';

        export function BrokenComponent({ items }: { items: number[] }) {
          const [count, setCount] = useState(0);

          // Unstable array - recreated every render
          const doubled = items.map(x => x * 2);

          useEffect(() => {
            // UNCONDITIONAL setState - this WILL cause infinite loop
            setCount(doubled.length);
          }, [doubled]);

          return <div>{count}</div>;
        }
      `);

      const results = analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      // SHOULD be flagged as confirmed infinite loop
      expect(infiniteLoops.length).toBeGreaterThan(0);
      expect(infiniteLoops[0].problematicDependency).toBe('doubled');
      expect(infiniteLoops[0].severity).toBe('high');
    });
  });

  describe('Control tests - patterns that SHOULD be flagged', () => {
    it('SHOULD flag unstable object literals in dependencies', () => {
      const parsed = createTestFile(`
        import React, { useEffect } from 'react';

        export function Component() {
          const config = { timeout: 5000 }; // New object every render

          useEffect(() => {
            fetch('/api', config);
          }, [config]); // config changes every render!

          return <div>Loading...</div>;
        }
      `);

      const results = analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // config is an object literal, recreated every render
      expect(issues.length).toBeGreaterThan(0);
    });

    it('SHOULD flag unstable array literals in dependencies', () => {
      const parsed = createTestFile(`
        import React, { useEffect } from 'react';

        export function Component({ a, b }: { a: number; b: number }) {
          const items = [a, b]; // New array every render

          useEffect(() => {
            console.log('Items:', items);
          }, [items]); // items changes every render!

          return <div>{items.length}</div>;
        }
      `);

      const results = analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // items is an array literal, recreated every render
      expect(issues.length).toBeGreaterThan(0);
    });

    it('SHOULD flag inline functions in dependencies', () => {
      const parsed = createTestFile(`
        import React, { useEffect } from 'react';

        export function Component() {
          const handleClick = () => console.log('clicked'); // New function every render

          useEffect(() => {
            document.addEventListener('click', handleClick);
            return () => document.removeEventListener('click', handleClick);
          }, [handleClick]); // handleClick changes every render!

          return <div>Click me</div>;
        }
      `);

      const results = analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // handleClick is an inline function, recreated every render
      expect(issues.length).toBeGreaterThan(0);
    });
  });
});
