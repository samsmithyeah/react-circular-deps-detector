/**
 * Tsconfig Manager
 *
 * Handles discovery and caching of tsconfig.json files in monorepo setups.
 * Provides mapping from source files to their governing tsconfig, and
 * detects workspace packages for cross-package import resolution.
 *
 * Key responsibilities:
 * - Find the correct tsconfig.json for any given source file
 * - Parse and cache tsconfig content including project references
 * - Detect yarn/pnpm/npm workspace packages
 * - Handle TypeScript project references
 */

import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';
import { glob } from 'glob';

export interface TsconfigInfo {
  /** Absolute path to the tsconfig.json file */
  path: string;
  /** Parsed TypeScript configuration */
  config: ts.ParsedCommandLine;
  /** Resolved project reference paths (absolute) */
  references: string[];
  /** Directory containing the tsconfig */
  directory: string;
}

export interface WorkspacePackage {
  /** Package name from package.json */
  name: string;
  /** Absolute path to the package directory */
  path: string;
  /** Path to package.json */
  packageJsonPath: string;
}

export interface MonorepoInfo {
  /** Type of monorepo detected */
  type: 'yarn' | 'pnpm' | 'npm' | 'lerna' | 'nx' | 'turborepo' | null;
  /** Root directory of the monorepo */
  root: string;
  /** Workspace packages */
  packages: Map<string, WorkspacePackage>;
}

/**
 * Manages tsconfig discovery and caching for monorepo support.
 */
export class TsconfigManager {
  private workspaceRoot: string;
  private tsconfigCache = new Map<string, TsconfigInfo>();
  private fileToTsconfig = new Map<string, string>();
  private workspacePackages: Map<string, WorkspacePackage> | null = null;
  private monorepoInfo: MonorepoInfo | null = null;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  /**
   * Get the governing tsconfig for a source file.
   * Walks up from the file's directory to find the closest tsconfig.json
   * that includes this file.
   */
  getTsconfigForFile(filePath: string): TsconfigInfo | null {
    const absolutePath = path.resolve(filePath);

    // Check cache first
    if (this.fileToTsconfig.has(absolutePath)) {
      const tsconfigPath = this.fileToTsconfig.get(absolutePath)!;
      return this.tsconfigCache.get(tsconfigPath) ?? null;
    }

    // Walk up directory tree to find nearest tsconfig.json
    let dir = path.dirname(absolutePath);
    const root = path.parse(dir).root;

    while (dir !== root && dir.startsWith(this.workspaceRoot)) {
      const tsconfigPath = path.join(dir, 'tsconfig.json');
      if (fs.existsSync(tsconfigPath)) {
        const info = this.loadTsconfig(tsconfigPath);
        if (info && this.isFileIncluded(absolutePath, info)) {
          this.fileToTsconfig.set(absolutePath, tsconfigPath);
          return info;
        }
      }
      dir = path.dirname(dir);
    }

    // If no tsconfig found in file's ancestry, try the workspace root
    const rootTsconfig = path.join(this.workspaceRoot, 'tsconfig.json');
    if (fs.existsSync(rootTsconfig)) {
      const info = this.loadTsconfig(rootTsconfig);
      if (info) {
        this.fileToTsconfig.set(absolutePath, rootTsconfig);
        return info;
      }
    }

    return null;
  }

  /**
   * Load and parse a tsconfig.json file, caching the result.
   */
  loadTsconfig(tsconfigPath: string): TsconfigInfo | null {
    const absolutePath = path.resolve(tsconfigPath);

    // Check cache
    if (this.tsconfigCache.has(absolutePath)) {
      return this.tsconfigCache.get(absolutePath)!;
    }

    try {
      const configFile = ts.readConfigFile(absolutePath, ts.sys.readFile);
      if (configFile.error) {
        console.warn(`Warning: Error reading ${absolutePath}: ${configFile.error.messageText}`);
        return null;
      }

      const configDir = path.dirname(absolutePath);
      const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, configDir);

      // Resolve project references
      const references: string[] = [];
      if (configFile.config.references) {
        for (const ref of configFile.config.references) {
          const refPath = path.resolve(configDir, ref.path);
          // Reference can point to a directory (with tsconfig.json inside) or a tsconfig file directly
          const resolvedRef = fs.existsSync(path.join(refPath, 'tsconfig.json'))
            ? path.join(refPath, 'tsconfig.json')
            : refPath;
          references.push(resolvedRef);
        }
      }

      const info: TsconfigInfo = {
        path: absolutePath,
        config: parsedConfig,
        references,
        directory: configDir,
      };

      this.tsconfigCache.set(absolutePath, info);
      return info;
    } catch (error) {
      console.warn(`Warning: Could not parse ${absolutePath}:`, error);
      return null;
    }
  }

  /**
   * Check if a file is included by a tsconfig based on its include/exclude patterns.
   */
  private isFileIncluded(filePath: string, tsconfig: TsconfigInfo): boolean {
    const relativePath = path.relative(tsconfig.directory, filePath);

    // If the file is outside the tsconfig's directory, it's not included
    if (relativePath.startsWith('..')) {
      return false;
    }

    // Check if file is in the fileNames list (this handles include/exclude)
    // Note: parsedConfig.fileNames contains resolved absolute paths
    const normalizedFilePath = path.normalize(filePath);
    for (const fileName of tsconfig.config.fileNames) {
      if (path.normalize(fileName) === normalizedFilePath) {
        return true;
      }
    }

    // If fileNames is empty or doesn't include our file, check if it's a TypeScript file
    // in the project directory (TypeScript's default behavior includes all .ts/.tsx files)
    if (tsconfig.config.fileNames.length === 0) {
      const ext = path.extname(filePath);
      return ['.ts', '.tsx', '.js', '.jsx'].includes(ext);
    }

    return false;
  }

  /**
   * Detect monorepo structure and workspace packages.
   */
  detectMonorepo(): MonorepoInfo {
    if (this.monorepoInfo !== null) {
      return this.monorepoInfo;
    }

    const rootDir = this.workspaceRoot;
    let type: MonorepoInfo['type'] = null;
    const packages = new Map<string, WorkspacePackage>();

    // Check for various monorepo indicators
    const lernaPath = path.join(rootDir, 'lerna.json');
    const pnpmPath = path.join(rootDir, 'pnpm-workspace.yaml');
    const nxPath = path.join(rootDir, 'nx.json');
    const turboPath = path.join(rootDir, 'turbo.json');
    const packageJsonPath = path.join(rootDir, 'package.json');

    // Determine monorepo type
    if (fs.existsSync(nxPath)) {
      type = 'nx';
    } else if (fs.existsSync(turboPath)) {
      type = 'turborepo';
    } else if (fs.existsSync(lernaPath)) {
      type = 'lerna';
    } else if (fs.existsSync(pnpmPath)) {
      type = 'pnpm';
    } else if (fs.existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        if (pkg.workspaces) {
          // Could be yarn or npm workspaces
          type = 'yarn'; // Assume yarn, npm works the same way
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Detect workspace packages
    if (type) {
      const workspacePatterns = this.getWorkspacePatterns(rootDir, type);
      for (const pattern of workspacePatterns) {
        const matches = glob.sync(pattern, {
          cwd: rootDir,
          absolute: false,
        });

        for (const match of matches) {
          const pkgDir = path.join(rootDir, match);
          const pkgJsonPath = path.join(pkgDir, 'package.json');

          if (fs.existsSync(pkgJsonPath)) {
            try {
              const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
              if (pkg.name) {
                packages.set(pkg.name, {
                  name: pkg.name,
                  path: pkgDir,
                  packageJsonPath: pkgJsonPath,
                });
              }
            } catch {
              // Ignore parse errors
            }
          }
        }
      }
    }

    this.monorepoInfo = { type, root: rootDir, packages };
    this.workspacePackages = packages;
    return this.monorepoInfo;
  }

  /**
   * Get workspace package patterns based on monorepo type.
   */
  private getWorkspacePatterns(rootDir: string, type: MonorepoInfo['type']): string[] {
    const packageJsonPath = path.join(rootDir, 'package.json');

    // First try to get patterns from package.json workspaces field
    if (fs.existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        if (pkg.workspaces) {
          // workspaces can be an array or an object with packages field
          const patterns = Array.isArray(pkg.workspaces)
            ? pkg.workspaces
            : pkg.workspaces.packages || [];
          if (patterns.length > 0) {
            return patterns;
          }
        }
      } catch {
        // Fall through to defaults
      }
    }

    // Check pnpm-workspace.yaml
    if (type === 'pnpm') {
      const pnpmPath = path.join(rootDir, 'pnpm-workspace.yaml');
      if (fs.existsSync(pnpmPath)) {
        try {
          const content = fs.readFileSync(pnpmPath, 'utf-8');
          // Simple YAML parsing for packages field
          const packagesMatch = content.match(/packages:\s*\n((?:\s+-\s+['"]?[^\n]+['"]?\n?)+)/);
          if (packagesMatch) {
            const patterns = packagesMatch[1]
              .split('\n')
              .map((line) => line.replace(/^\s*-\s*['"]?|['"]?\s*$/g, '').trim())
              .filter((p) => p.length > 0);
            if (patterns.length > 0) {
              return patterns;
            }
          }
        } catch {
          // Fall through to defaults
        }
      }
    }

    // Check lerna.json
    if (type === 'lerna') {
      const lernaPath = path.join(rootDir, 'lerna.json');
      if (fs.existsSync(lernaPath)) {
        try {
          const lerna = JSON.parse(fs.readFileSync(lernaPath, 'utf-8'));
          if (lerna.packages && lerna.packages.length > 0) {
            return lerna.packages;
          }
        } catch {
          // Fall through to defaults
        }
      }
    }

    // Default patterns for common monorepo structures
    return ['packages/*', 'apps/*', 'libs/*'];
  }

  /**
   * Get workspace packages. Lazy-loads monorepo detection if needed.
   */
  getWorkspacePackages(): Map<string, WorkspacePackage> {
    if (this.workspacePackages === null) {
      this.detectMonorepo();
    }
    return this.workspacePackages!;
  }

  /**
   * Resolve a workspace package import to its actual path.
   * E.g., "@myorg/shared" -> "/path/to/packages/shared"
   */
  resolveWorkspacePackage(importPath: string): string | null {
    const packages = this.getWorkspacePackages();

    // Check for exact package match
    if (packages.has(importPath)) {
      return packages.get(importPath)!.path;
    }

    // Check for scoped package with subpath
    // e.g., "@myorg/shared/utils" -> check for "@myorg/shared" package
    for (const [pkgName, pkg] of packages) {
      if (importPath === pkgName || importPath.startsWith(pkgName + '/')) {
        const subPath = importPath.slice(pkgName.length + 1);
        return subPath ? path.join(pkg.path, subPath) : pkg.path;
      }
    }

    return null;
  }

  /**
   * Get all tsconfig paths that reference a given tsconfig (reverse lookup).
   * Useful for understanding project dependencies.
   */
  getTsconfigsReferencingPath(tsconfigPath: string): string[] {
    const absolutePath = path.resolve(tsconfigPath);
    const result: string[] = [];

    for (const [path, info] of this.tsconfigCache) {
      if (info.references.includes(absolutePath)) {
        result.push(path);
      }
    }

    return result;
  }

  /**
   * Load all project references recursively from a root tsconfig.
   */
  loadProjectReferencesRecursively(rootTsconfigPath: string): Map<string, TsconfigInfo> {
    const visited = new Map<string, TsconfigInfo>();
    const queue = [path.resolve(rootTsconfigPath)];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;

      const info = this.loadTsconfig(current);
      if (info) {
        visited.set(current, info);
        // Add unvisited references to queue
        for (const ref of info.references) {
          if (!visited.has(ref)) {
            queue.push(ref);
          }
        }
      }
    }

    return visited;
  }

  /**
   * Clear all caches. Call this if tsconfig files have changed on disk.
   */
  clearCache(): void {
    this.tsconfigCache.clear();
    this.fileToTsconfig.clear();
    this.workspacePackages = null;
    this.monorepoInfo = null;
  }

  /**
   * Invalidate cache for a specific tsconfig file.
   */
  invalidateTsconfig(tsconfigPath: string): void {
    const absolutePath = path.resolve(tsconfigPath);
    this.tsconfigCache.delete(absolutePath);

    // Also clear file mappings that pointed to this tsconfig
    for (const [filePath, tsconfig] of this.fileToTsconfig) {
      if (tsconfig === absolutePath) {
        this.fileToTsconfig.delete(filePath);
      }
    }
  }

  /**
   * Check if a monorepo structure was detected.
   */
  isMonorepo(): boolean {
    return this.detectMonorepo().type !== null;
  }

  /**
   * Get the monorepo type if detected.
   */
  getMonorepoType(): MonorepoInfo['type'] {
    return this.detectMonorepo().type;
  }
}

/**
 * Create a TsconfigManager instance for a workspace.
 */
export function createTsconfigManager(workspaceRoot: string): TsconfigManager {
  return new TsconfigManager(workspaceRoot);
}
