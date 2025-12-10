import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import {
  isGitRepository,
  getGitRoot,
  getChangedFilesSinceRef,
  getCurrentBranch,
  isValidGitRef,
} from '../src/git-utils';

/**
 * Check if we have enough git history for tests that require it.
 * GitHub Actions uses shallow clones by default, which don't have full history.
 */
function hasGitHistory(ref: string, cwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', ref], {
      cwd,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

describe('Git Utils', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const hasFullHistory = hasGitHistory('HEAD~1', projectRoot);

  describe('isGitRepository', () => {
    it('should return true for a git repository', () => {
      expect(isGitRepository(projectRoot)).toBe(true);
    });

    it('should return false for a non-git directory', () => {
      expect(isGitRepository('/tmp')).toBe(false);
    });
  });

  describe('getGitRoot', () => {
    it('should return the git root directory', () => {
      const root = getGitRoot(projectRoot);
      expect(root).toBe(projectRoot);
    });

    it('should return null for a non-git directory', () => {
      expect(getGitRoot('/tmp')).toBeNull();
    });
  });

  describe('getCurrentBranch', () => {
    it('should return the current branch name', () => {
      const branch = getCurrentBranch(projectRoot);
      expect(branch).toBeTruthy();
      expect(typeof branch).toBe('string');
    });
  });

  describe('isValidGitRef', () => {
    it('should return true for HEAD', () => {
      expect(isValidGitRef('HEAD', projectRoot)).toBe(true);
    });

    // This test requires git history - skip in shallow clones
    (hasFullHistory ? it : it.skip)('should return true for HEAD~1 (requires git history)', () => {
      expect(isValidGitRef('HEAD~1', projectRoot)).toBe(true);
    });

    it('should return false for invalid refs', () => {
      expect(isValidGitRef('nonexistent-branch-12345', projectRoot)).toBe(false);
    });
  });

  describe('getChangedFilesSinceRef', () => {
    // Tests that require git history - skip in shallow clones (CI)
    (hasFullHistory ? it : it.skip)(
      'should return changed files since HEAD~1 (requires git history)',
      () => {
        const result = getChangedFilesSinceRef({
          since: 'HEAD~1',
          cwd: projectRoot,
        });

        expect(result.isGitRepo).toBe(true);
        expect(result.baseRef).toBe('HEAD~1');
        expect(Array.isArray(result.changedFiles)).toBe(true);
        // All returned files should be absolute paths
        for (const file of result.changedFiles) {
          expect(path.isAbsolute(file)).toBe(true);
        }
      }
    );

    (hasFullHistory ? it : it.skip)('should filter by extension (requires git history)', () => {
      const result = getChangedFilesSinceRef({
        since: 'HEAD~5',
        cwd: projectRoot,
        extensions: ['.ts'],
      });

      // All returned files should have .ts extension
      for (const file of result.changedFiles) {
        expect(file.endsWith('.ts')).toBe(true);
      }
    });

    it('should return isGitRepo=false for non-git directories', () => {
      const result = getChangedFilesSinceRef({
        since: 'main',
        cwd: '/tmp',
      });

      expect(result.isGitRepo).toBe(false);
      expect(result.changedFiles).toHaveLength(0);
    });

    it('should throw for invalid git refs', () => {
      expect(() =>
        getChangedFilesSinceRef({
          since: 'nonexistent-branch-xyz',
          cwd: projectRoot,
        })
      ).toThrow('Invalid git reference');
    });

    (hasFullHistory ? it : it.skip)(
      'should only return files that exist (requires git history)',
      () => {
        const result = getChangedFilesSinceRef({
          since: 'HEAD~5',
          cwd: projectRoot,
        });

        // All returned files should exist
        for (const file of result.changedFiles) {
          expect(fs.existsSync(file)).toBe(true);
        }
      }
    );
  });
});

describe('Detector with --since option', () => {
  const { detectCircularDependencies } = require('../src/detector');
  const projectRoot = path.resolve(__dirname, '..');
  const hasFullHistory = hasGitHistory('HEAD~1', projectRoot);

  // Tests that require git history - skip in shallow clones (CI)
  (hasFullHistory ? it : it.skip)(
    'should analyze only changed files when --since is provided (requires git history)',
    async () => {
      const result = await detectCircularDependencies(projectRoot, {
        pattern: '**/*.{ts,tsx}',
        ignore: ['**/node_modules/**', '**/dist/**', '**/tests/**'],
        since: 'HEAD~3',
      });

      // Should complete without errors
      expect(result.summary.filesAnalyzed).toBeGreaterThanOrEqual(0);
    }
  );

  it('should throw error when --since is used in non-git directory', async () => {
    await expect(
      detectCircularDependencies('/tmp', {
        pattern: '**/*.ts',
        ignore: [],
        since: 'main',
      })
    ).rejects.toThrow('is not inside a git repository');
  });

  (hasFullHistory ? it : it.skip)(
    'should include dependent files when --include-dependents is true (requires git history)',
    async () => {
      // First run without dependents
      const withoutDependents = await detectCircularDependencies(projectRoot, {
        pattern: '**/*.ts',
        ignore: ['**/node_modules/**', '**/dist/**', '**/tests/**'],
        since: 'HEAD~3',
        includeDependents: false,
      });

      // Then run with dependents
      const withDependents = await detectCircularDependencies(projectRoot, {
        pattern: '**/*.ts',
        ignore: ['**/node_modules/**', '**/dist/**', '**/tests/**'],
        since: 'HEAD~3',
        includeDependents: true,
      });

      // With dependents should analyze >= files than without
      expect(withDependents.summary.filesAnalyzed).toBeGreaterThanOrEqual(
        withoutDependents.summary.filesAnalyzed
      );
    }
  );
});
