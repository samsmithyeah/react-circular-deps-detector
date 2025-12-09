import { execSync } from 'child_process';
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
    execSync('git rev-parse --git-dir', {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
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
    const result = execSync('git rev-parse --show-toplevel', {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
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
    const result = execSync(`git merge-base HEAD ${targetRef}`, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
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
    execSync(`git rev-parse --verify ${ref}`, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
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

  try {
    // Get diff of committed changes
    const diffOutput = execSync(`git diff --name-only ${compareRef}...HEAD`, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });

    // Also get uncommitted changes (staged and unstaged)
    const statusOutput = execSync('git diff --name-only HEAD', {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });

    // Get untracked files
    const untrackedOutput = execSync('git ls-files --others --exclude-standard', {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });

    const gitRoot = getGitRoot(cwd) || cwd;

    // Combine all changed files
    const allFiles = new Set<string>();

    const parseOutput = (output: string): string[] => {
      return output
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);
    };

    for (const file of parseOutput(diffOutput)) {
      allFiles.add(file);
    }
    for (const file of parseOutput(statusOutput)) {
      allFiles.add(file);
    }
    for (const file of parseOutput(untrackedOutput)) {
      allFiles.add(file);
    }

    // Convert to absolute paths and filter by extension
    const extensions = options.extensions || ['.js', '.jsx', '.ts', '.tsx'];
    const changedFiles: string[] = [];

    for (const file of allFiles) {
      const absolutePath = path.resolve(gitRoot, file);
      const ext = path.extname(file);

      // Filter by extension
      if (!extensions.includes(ext)) {
        continue;
      }

      // Only include files that still exist (filter out deleted files)
      if (fs.existsSync(absolutePath)) {
        changedFiles.push(absolutePath);
      }
    }

    return {
      changedFiles,
      baseRef,
      isGitRepo: true,
    };
  } catch (error) {
    // If the three-dot syntax fails (e.g., for initial commits), try two-dot
    try {
      const diffOutput = execSync(`git diff --name-only ${compareRef}`, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });

      const gitRoot = getGitRoot(cwd) || cwd;
      const extensions = options.extensions || ['.js', '.jsx', '.ts', '.tsx'];
      const changedFiles: string[] = [];

      const files = diffOutput
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);

      for (const file of files) {
        const absolutePath = path.resolve(gitRoot, file);
        const ext = path.extname(file);

        if (extensions.includes(ext) && fs.existsSync(absolutePath)) {
          changedFiles.push(absolutePath);
        }
      }

      return {
        changedFiles,
        baseRef,
        isGitRepo: true,
      };
    } catch {
      throw new Error(`Failed to get git diff: ${error instanceof Error ? error.message : error}`);
    }
  }
}

/**
 * Get the current branch name
 */
export function getCurrentBranch(cwd: string): string | null {
  try {
    const result = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    return result.trim();
  } catch {
    return null;
  }
}
