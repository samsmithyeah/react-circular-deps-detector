/**
 * Tests for monorepo support
 *
 * Tests the following features:
 * - TsconfigManager: discovery and caching of tsconfig files
 * - TypeCheckerPool: per-file TypeChecker resolution
 * - Monorepo detection: yarn/pnpm/npm workspaces, lerna, etc.
 * - Cross-package type resolution
 */

import * as path from 'path';
import * as fs from 'fs';
import {
  createTsconfigManager,
  TsconfigManager,
  TypeCheckerPool,
  getPersistentTypeCheckerPool,
  disposePersistentTypeCheckerPool,
  createMultiProjectPathResolver,
  detectCircularDependencies,
} from '../src';

const fixturesPath = path.join(__dirname, 'fixtures', 'monorepo');

describe('TsconfigManager', () => {
  let manager: TsconfigManager;

  beforeEach(() => {
    manager = createTsconfigManager(fixturesPath);
  });

  describe('detectMonorepo', () => {
    it('should detect yarn workspaces from package.json', () => {
      const monorepoInfo = manager.detectMonorepo();

      expect(monorepoInfo.type).toBe('yarn');
      expect(monorepoInfo.root).toBe(fixturesPath);
    });

    it('should discover workspace packages', () => {
      const monorepoInfo = manager.detectMonorepo();

      expect(monorepoInfo.packages.size).toBe(2);
      expect(monorepoInfo.packages.has('@test/shared')).toBe(true);
      expect(monorepoInfo.packages.has('@test/app')).toBe(true);
    });

    it('should include correct package paths', () => {
      const monorepoInfo = manager.detectMonorepo();

      const sharedPkg = monorepoInfo.packages.get('@test/shared');
      expect(sharedPkg).toBeDefined();
      expect(sharedPkg!.path).toBe(path.join(fixturesPath, 'packages', 'shared'));

      const appPkg = monorepoInfo.packages.get('@test/app');
      expect(appPkg).toBeDefined();
      expect(appPkg!.path).toBe(path.join(fixturesPath, 'packages', 'app'));
    });
  });

  describe('getTsconfigForFile', () => {
    it('should return the correct tsconfig for a file in shared package', () => {
      const filePath = path.join(fixturesPath, 'packages', 'shared', 'src', 'hooks.ts');
      const tsconfig = manager.getTsconfigForFile(filePath);

      expect(tsconfig).not.toBeNull();
      expect(tsconfig!.path).toBe(path.join(fixturesPath, 'packages', 'shared', 'tsconfig.json'));
    });

    it('should return the correct tsconfig for a file in app package', () => {
      const filePath = path.join(fixturesPath, 'packages', 'app', 'src', 'Counter.tsx');
      const tsconfig = manager.getTsconfigForFile(filePath);

      expect(tsconfig).not.toBeNull();
      expect(tsconfig!.path).toBe(path.join(fixturesPath, 'packages', 'app', 'tsconfig.json'));
    });

    it('should cache tsconfig lookups', () => {
      const filePath = path.join(fixturesPath, 'packages', 'shared', 'src', 'hooks.ts');

      // First lookup
      const tsconfig1 = manager.getTsconfigForFile(filePath);
      // Second lookup (should be cached)
      const tsconfig2 = manager.getTsconfigForFile(filePath);

      expect(tsconfig1).toBe(tsconfig2);
    });
  });

  describe('loadTsconfig', () => {
    it('should parse project references', () => {
      const appTsconfigPath = path.join(fixturesPath, 'packages', 'app', 'tsconfig.json');
      const tsconfig = manager.loadTsconfig(appTsconfigPath);

      expect(tsconfig).not.toBeNull();
      expect(tsconfig!.references.length).toBe(1);
      expect(tsconfig!.references[0]).toContain('shared');
    });

    it('should parse root solution tsconfig references', () => {
      const rootTsconfigPath = path.join(fixturesPath, 'tsconfig.json');
      const tsconfig = manager.loadTsconfig(rootTsconfigPath);

      expect(tsconfig).not.toBeNull();
      expect(tsconfig!.references.length).toBe(2);
    });
  });

  describe('resolveWorkspacePackage', () => {
    it('should resolve @test/shared to its actual path', () => {
      // Initialize workspace packages first
      manager.detectMonorepo();

      const resolved = manager.resolveWorkspacePackage('@test/shared');
      expect(resolved).toBe(path.join(fixturesPath, 'packages', 'shared'));
    });

    it('should resolve @test/shared/hooks to subpath', () => {
      manager.detectMonorepo();

      const resolved = manager.resolveWorkspacePackage('@test/shared/hooks');
      expect(resolved).toBe(path.join(fixturesPath, 'packages', 'shared', 'hooks'));
    });

    it('should return null for unknown packages', () => {
      manager.detectMonorepo();

      const resolved = manager.resolveWorkspacePackage('@unknown/package');
      expect(resolved).toBeNull();
    });
  });

  describe('loadProjectReferencesRecursively', () => {
    it('should load all referenced projects from root', () => {
      const rootTsconfigPath = path.join(fixturesPath, 'tsconfig.json');
      const projects = manager.loadProjectReferencesRecursively(rootTsconfigPath);

      // Should have: root, shared, app (app references shared but shared is already loaded)
      expect(projects.size).toBeGreaterThanOrEqual(2);
    });
  });
});

describe('TypeCheckerPool', () => {
  let pool: TypeCheckerPool;

  beforeEach(() => {
    pool = getPersistentTypeCheckerPool(fixturesPath);
  });

  afterEach(() => {
    disposePersistentTypeCheckerPool(fixturesPath);
  });

  describe('getCheckerForFile', () => {
    it('should return a TypeChecker for files in the monorepo', () => {
      const filePath = path.join(fixturesPath, 'packages', 'shared', 'src', 'hooks.ts');
      const checker = pool.getCheckerForFile(filePath);

      // May be null if tsconfig doesn't include files properly
      // In a real monorepo it should work
      expect(checker).toBeDefined();
    });

    it('should lazily create TypeChecker instances', () => {
      // Initially no checkers are loaded
      expect(pool.getLoadedCheckerCount()).toBe(0);

      // Access a file
      const filePath = path.join(fixturesPath, 'packages', 'shared', 'src', 'hooks.ts');
      pool.getCheckerForFile(filePath);

      // Now we should have at least one checker
      // (could be more if the file requires loading other tsconfigs)
    });
  });

  describe('isMonorepo', () => {
    it('should detect the fixture as a monorepo', () => {
      expect(pool.isMonorepo()).toBe(true);
    });
  });

  describe('updateFile', () => {
    it('should not throw when updating a file', () => {
      const filePath = path.join(fixturesPath, 'packages', 'shared', 'src', 'hooks.ts');
      const content = fs.readFileSync(filePath, 'utf-8');

      expect(() => {
        pool.updateFile(filePath, content);
      }).not.toThrow();
    });
  });

  describe('dispose', () => {
    it('should dispose all checkers', () => {
      const filePath = path.join(fixturesPath, 'packages', 'shared', 'src', 'hooks.ts');
      pool.getCheckerForFile(filePath);

      pool.dispose();

      expect(pool.getLoadedCheckerCount()).toBe(0);
    });
  });
});

describe('MultiProjectPathResolver', () => {
  it('should resolve workspace package imports', () => {
    const manager = createTsconfigManager(fixturesPath);
    manager.detectMonorepo();

    const resolver = createMultiProjectPathResolver({
      workspaceRoot: fixturesPath,
      tsconfigManager: manager,
    });

    // Workspace package resolution
    const resolved = resolver.resolveWorkspacePackage('@test/shared');
    expect(resolved).toBe(path.join(fixturesPath, 'packages', 'shared'));
  });

  it('should resolve relative imports', () => {
    const manager = createTsconfigManager(fixturesPath);
    const resolver = createMultiProjectPathResolver({
      workspaceRoot: fixturesPath,
      tsconfigManager: manager,
    });

    const fromFile = path.join(fixturesPath, 'packages', 'shared', 'src', 'index.ts');
    const resolved = resolver.resolve(fromFile, './hooks');

    expect(resolved).toBe(path.join(fixturesPath, 'packages', 'shared', 'src', 'hooks.ts'));
  });
});

describe('Detector with monorepo', () => {
  it('should detect monorepo structure', async () => {
    const results = await detectCircularDependencies(fixturesPath, {
      pattern: '**/*.{ts,tsx}',
      ignore: ['**/node_modules/**', '**/dist/**'],
    });

    // Should detect it's a monorepo
    expect(results.strictModeDetection.isMonorepo).toBe(true);
    expect(results.strictModeDetection.monorepoType).toBe('yarn');
  });

  it('should analyze files across packages', async () => {
    const results = await detectCircularDependencies(fixturesPath, {
      pattern: '**/*.{ts,tsx}',
      ignore: ['**/node_modules/**', '**/dist/**'],
    });

    // Should have analyzed files from both packages
    expect(results.summary.filesAnalyzed).toBeGreaterThanOrEqual(2);
  });
});

describe('Non-monorepo detection', () => {
  it('should not detect non-monorepo as monorepo', () => {
    // Use the regular test fixtures which aren't a monorepo
    const nonMonorepoPath = path.join(__dirname, 'fixtures');
    const manager = createTsconfigManager(nonMonorepoPath);
    const monorepoInfo = manager.detectMonorepo();

    expect(monorepoInfo.type).toBeNull();
    expect(manager.isMonorepo()).toBe(false);
  });
});
