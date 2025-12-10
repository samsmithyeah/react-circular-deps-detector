import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export interface GitChangedFilesOptions {
  /** Git ref to compare against (e.g., 'main', 'HEAD~5', 'abc123') */
  since?: string;
  /** Include only files matching these extensions */
  extensions?: string[];
  /** Working directory (defaults to cwd) */
  cwd?: string;
}

export interface GitChangedFilesResult {
  /** List of changed file absolute paths */
  changedFiles: string[];
  /** The base ref that was used for comparison */
  baseRef: string;
  /** Whether we're in a git repository */
  isGitRepo: boolean;
}

/**
 * Check if a directory is inside a git repository
 */
export function isGitRepository(dir: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: dir,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the root of the git repository
 */
export function getGitRoot(dir: string): string | null {
  try {
    const result = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Get the merge base between current HEAD and a target ref
 * This finds the common ancestor, which is useful for comparing branches
 */
export function getMergeBase(targetRef: string, cwd: string): string | null {
  try {
    const result = execFileSync('git', ['merge-base', 'HEAD', targetRef], {
      cwd,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Validate that a git ref exists
 */
export function isValidGitRef(ref: string, cwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', ref], {
      cwd,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get files changed between a base ref and HEAD
 * Uses git diff --name-only to list all modified, added, or deleted files
 */
export function getChangedFilesSinceRef(options: GitChangedFilesOptions): GitChangedFilesResult {
  const cwd = options.cwd || process.cwd();

  if (!isGitRepository(cwd)) {
    return {
      changedFiles: [],
      baseRef: '',
      isGitRepo: false,
    };
  }

  const baseRef = options.since || 'HEAD';

  // If comparing against a branch, use merge-base to find the common ancestor
  // This handles the case where the target branch has moved forward
  let compareRef = baseRef;
  if (baseRef !== 'HEAD' && !baseRef.startsWith('HEAD')) {
    const mergeBase = getMergeBase(baseRef, cwd);
    if (mergeBase) {
      compareRef = mergeBase;
    } else if (!isValidGitRef(baseRef, cwd)) {
      throw new Error(`Invalid git reference: ${baseRef}`);
    }
  }

  const gitRoot = getGitRoot(cwd) || cwd;
  const extensions = options.extensions || ['.js', '.jsx', '.ts', '.tsx'];

  try {
    // Get diff of committed changes - try three-dot syntax first, fallback to two-dot
    let committedDiff: string;
    try {
      committedDiff = execFileSync('git', ['diff', '--name-only', `${compareRef}...HEAD`], {
        cwd,
        stdio: 'pipe',
        encoding: 'utf-8',
      });
    } catch {
      // If the three-dot syntax fails (e.g., for initial commits), try two-dot
      committedDiff = execFileSync('git', ['diff', '--name-only', compareRef, 'HEAD'], {
        cwd,
        stdio: 'pipe',
        encoding: 'utf-8',
      });
    }

    // Get staged changes (files added to the index)
    const stagedOutput = execFileSync('git', ['diff', '--name-only', '--cached'], {
      cwd,
      stdio: 'pipe',
      encoding: 'utf-8',
    });

    // Get unstaged changes (files modified in the working directory but not staged)
    const unstagedOutput = execFileSync('git', ['diff', '--name-only'], {
      cwd,
      stdio: 'pipe',
      encoding: 'utf-8',
    });

    // Get untracked files
    const untrackedOutput = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd,
      stdio: 'pipe',
      encoding: 'utf-8',
    });

    // Combine all changed files and deduplicate
    const allRelativeFiles = [
      ...committedDiff.trim().split('\n'),
      ...stagedOutput.trim().split('\n'),
      ...unstagedOutput.trim().split('\n'),
      ...untrackedOutput.trim().split('\n'),
    ];

    const changedFiles = Array.from(new Set(allRelativeFiles))
      .filter((file) => file.length > 0)
      .map((file) => path.resolve(gitRoot, file))
      .filter((absolutePath) => {
        const ext = path.extname(absolutePath);
        return extensions.includes(ext) && fs.existsSync(absolutePath);
      });

    return {
      changedFiles,
      baseRef,
      isGitRepo: true,
    };
  } catch (error) {
    throw new Error(`Failed to get git diff: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Get the current branch name
 */
export function getCurrentBranch(cwd: string): string | null {
  try {
    const result = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    return result.trim();
  } catch {
    return null;
  }
}
