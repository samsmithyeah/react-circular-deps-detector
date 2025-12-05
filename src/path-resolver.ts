/**
 * Path Alias Resolver
 *
 * Handles resolving import paths including:
 * - Relative imports (./foo, ../bar)
 * - Path aliases from tsconfig.json (@/components, @utils/helpers)
 * - Node module resolution (index files, package.json main/exports)
 */

import * as fs from 'fs';
import * as path from 'path';
import { getTsconfig, createPathsMatcher, TsConfigResult } from 'get-tsconfig';

export interface PathResolverOptions {
  /** Root directory for the project (where tsconfig.json is located) */
  projectRoot: string;
  /** Cached tsconfig result */
  tsconfigResult?: TsConfigResult | null;
}

export interface PathResolver {
  /** Resolve an import path to an absolute file path */
  resolve(fromFile: string, importPath: string): string | null;
  /** Check if this resolver supports the given import path */
  canResolve(importPath: string): boolean;
}

// Cache for tsconfig lookups per project root
const tsconfigCache = new Map<string, TsConfigResult | null>();
const pathsMatcherCache = new Map<string, ReturnType<typeof createPathsMatcher> | null>();

/**
 * Get the tsconfig for a project, with caching
 */
export function getTsconfigForProject(projectRoot: string): TsConfigResult | null {
  if (tsconfigCache.has(projectRoot)) {
    return tsconfigCache.get(projectRoot) || null;
  }

  try {
    // Try to find tsconfig.json in the project root
    const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
    let result: TsConfigResult | null = null;

    if (fs.existsSync(tsconfigPath)) {
      result = getTsconfig(tsconfigPath);
    } else {
      // Try to find jsconfig.json as fallback
      const jsconfigPath = path.join(projectRoot, 'jsconfig.json');
      if (fs.existsSync(jsconfigPath)) {
        result = getTsconfig(jsconfigPath);
      }
    }

    tsconfigCache.set(projectRoot, result);
    return result;
  } catch {
    tsconfigCache.set(projectRoot, null);
    return null;
  }
}

/**
 * Get path matcher for tsconfig paths aliases
 */
export function getPathsMatcher(projectRoot: string): ReturnType<typeof createPathsMatcher> | null {
  if (pathsMatcherCache.has(projectRoot)) {
    return pathsMatcherCache.get(projectRoot) || null;
  }

  const tsconfig = getTsconfigForProject(projectRoot);
  if (!tsconfig) {
    pathsMatcherCache.set(projectRoot, null);
    return null;
  }

  try {
    const matcher = createPathsMatcher(tsconfig);
    pathsMatcherCache.set(projectRoot, matcher);
    return matcher;
  } catch {
    pathsMatcherCache.set(projectRoot, null);
    return null;
  }
}

/**
 * Create a path resolver for a project
 */
export function createPathResolver(options: PathResolverOptions): PathResolver {
  const { projectRoot } = options;
  const pathsMatcher = getPathsMatcher(projectRoot);

  return {
    canResolve(importPath: string): boolean {
      // Can resolve relative imports
      if (importPath.startsWith('./') || importPath.startsWith('../')) {
        return true;
      }

      // Can resolve path aliases if tsconfig has paths configured
      if (pathsMatcher) {
        const matched = pathsMatcher(importPath);
        return matched !== null && matched.length > 0;
      }

      return false;
    },

    resolve(fromFile: string, importPath: string): string | null {
      // Handle relative imports
      if (importPath.startsWith('./') || importPath.startsWith('../')) {
        return resolveRelativeImport(fromFile, importPath);
      }

      // Handle path aliases
      if (pathsMatcher) {
        const matched = pathsMatcher(importPath);
        if (matched && matched.length > 0) {
          // Try each matched path
          for (const resolvedPath of matched) {
            const result = resolveWithExtensions(resolvedPath);
            if (result) {
              return result;
            }
          }
        }
      }

      return null;
    },
  };
}

/**
 * Resolve a relative import path to an absolute file path
 */
function resolveRelativeImport(fromFile: string, importPath: string): string | null {
  const fromDir = path.dirname(fromFile);
  const resolvedPath = path.resolve(fromDir, importPath);
  return resolveWithExtensions(resolvedPath);
}

/**
 * Try to resolve a path with various extensions and index files
 */
function resolveWithExtensions(basePath: string): string | null {
  // If path already has an extension and exists, return it
  if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
    return basePath;
  }

  // Standard extensions to try
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

  // Try with extensions
  for (const ext of extensions) {
    const pathWithExt = basePath + ext;
    if (fs.existsSync(pathWithExt) && fs.statSync(pathWithExt).isFile()) {
      return pathWithExt;
    }
  }

  // Try as directory with index files
  if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
    // First check package.json for main/exports
    const pkgJsonPath = path.join(basePath, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));

        // Check exports field first (modern)
        if (pkgJson.exports) {
          const mainExport =
            typeof pkgJson.exports === 'string'
              ? pkgJson.exports
              : pkgJson.exports['.']?.default ||
                pkgJson.exports['.']?.import ||
                pkgJson.exports['.'];

          if (mainExport && typeof mainExport === 'string') {
            const exportPath = path.resolve(basePath, mainExport);
            if (fs.existsSync(exportPath)) {
              return exportPath;
            }
          }
        }

        // Check main field
        if (pkgJson.main) {
          const mainPath = path.resolve(basePath, pkgJson.main);
          if (fs.existsSync(mainPath)) {
            return mainPath;
          }
        }
      } catch {
        // Ignore JSON parse errors
      }
    }

    // Try index files
    for (const ext of extensions) {
      const indexPath = path.join(basePath, 'index' + ext);
      if (fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()) {
        return indexPath;
      }
    }
  }

  return null;
}
