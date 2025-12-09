import { createHash } from 'crypto';
import type { ParsedFile, HookAnalysis, PathResolver } from 'react-loop-detector';

/**
 * Incremental caching layer for the LSP server.
 *
 * Tracks file dependencies and invalidates affected files when changes occur.
 * This enables fast re-analysis by only re-processing changed files and their dependents.
 */
export class IncrementalCache {
  // Path resolver for resolving import paths to absolute file paths
  private pathResolver: PathResolver | null = null;

  // File hash cache for change detection
  private fileHashes: Map<string, string> = new Map();

  // Parsed file cache
  private parsedFiles: Map<string, ParsedFile> = new Map();

  // Analysis results per file
  private analysisResults: Map<string, HookAnalysis[]> = new Map();

  // Dependency graph: file -> files it imports
  private dependencies: Map<string, Set<string>> = new Map();

  // Reverse dependency graph: file -> files that import it
  private dependents: Map<string, Set<string>> = new Map();

  /**
   * Set the path resolver for resolving import paths
   */
  setPathResolver(resolver: PathResolver): void {
    this.pathResolver = resolver;
  }

  /**
   * Check if a file has changed since last analysis
   */
  hasFileChanged(filePath: string, content: string): boolean {
    const normalizedPath = this.normalizePath(filePath);
    const newHash = this.computeHash(content);
    const oldHash = this.fileHashes.get(normalizedPath);

    return oldHash !== newHash;
  }

  /**
   * Update the cache with new file content
   */
  updateFile(filePath: string, content: string, parsed: ParsedFile): void {
    const normalizedPath = this.normalizePath(filePath);
    const hash = this.computeHash(content);

    this.fileHashes.set(normalizedPath, hash);
    this.parsedFiles.set(normalizedPath, parsed);

    // Update dependency graph
    this.updateDependencies(normalizedPath, parsed);
  }

  /**
   * Update analysis results for a file
   */
  updateAnalysis(filePath: string, results: HookAnalysis[]): void {
    const normalizedPath = this.normalizePath(filePath);
    this.analysisResults.set(normalizedPath, results);
  }

  /**
   * Get cached parsed file
   */
  getParsedFile(filePath: string): ParsedFile | undefined {
    return this.parsedFiles.get(this.normalizePath(filePath));
  }

  /**
   * Get cached analysis results for a file
   */
  getAnalysis(filePath: string): HookAnalysis[] | undefined {
    return this.analysisResults.get(this.normalizePath(filePath));
  }

  /**
   * Get all cached parsed files
   */
  getAllParsedFiles(): ParsedFile[] {
    return Array.from(this.parsedFiles.values());
  }

  /**
   * Get all cached analysis results
   */
  getAllAnalysis(): HookAnalysis[] {
    const allResults: HookAnalysis[] = [];
    for (const results of this.analysisResults.values()) {
      allResults.push(...results);
    }
    return allResults;
  }

  /**
   * Invalidate a file and return all affected files (including dependents)
   */
  invalidateFile(filePath: string): Set<string> {
    const normalizedPath = this.normalizePath(filePath);
    const affected = new Set<string>();

    this.collectAffectedFiles(normalizedPath, affected);

    // Clear caches for affected files
    for (const file of affected) {
      this.fileHashes.delete(file);
      this.parsedFiles.delete(file);
      this.analysisResults.delete(file);
    }

    return affected;
  }

  /**
   * Invalidate all files that import the given file (recursively)
   */
  private collectAffectedFiles(filePath: string, affected: Set<string>): void {
    if (affected.has(filePath)) return;

    affected.add(filePath);

    // Get all files that depend on this file
    const deps = this.dependents.get(filePath);
    if (deps) {
      for (const dep of deps) {
        this.collectAffectedFiles(dep, affected);
      }
    }
  }

  /**
   * Update the dependency graph based on parsed file imports.
   * Uses the path resolver to convert import strings to absolute file paths.
   */
  private updateDependencies(filePath: string, parsed: ParsedFile): void {
    // Clear old dependencies for this file
    const oldDeps = this.dependencies.get(filePath);
    if (oldDeps) {
      for (const dep of oldDeps) {
        const depDependents = this.dependents.get(dep);
        if (depDependents) {
          depDependents.delete(filePath);
        }
      }
    }

    const newDeps = new Set<string>();

    for (const imp of parsed.imports) {
      // Use the path resolver to get absolute paths for accurate dependency tracking
      if (this.pathResolver && this.pathResolver.canResolve(imp.source)) {
        const resolvedPath = this.pathResolver.resolve(filePath, imp.source);

        if (resolvedPath && !resolvedPath.includes('node_modules')) {
          const normalizedResolvedPath = this.normalizePath(resolvedPath);
          newDeps.add(normalizedResolvedPath);

          // Update reverse dependency using the resolved path
          let dependents = this.dependents.get(normalizedResolvedPath);
          if (!dependents) {
            dependents = new Set();
            this.dependents.set(normalizedResolvedPath, dependents);
          }
          dependents.add(filePath);
        }
      }
    }

    this.dependencies.set(filePath, newDeps);
  }

  /**
   * Get files that need to be re-analyzed when the given file changes
   */
  getFilesToReanalyze(changedFile: string): Set<string> {
    const normalizedPath = this.normalizePath(changedFile);
    const toReanalyze = new Set<string>();

    // Always include the changed file
    toReanalyze.add(normalizedPath);

    // Include all files that directly or indirectly depend on the changed file
    this.collectAffectedFiles(normalizedPath, toReanalyze);

    return toReanalyze;
  }

  /**
   * Check if a file is in the cache
   */
  has(filePath: string): boolean {
    return this.parsedFiles.has(this.normalizePath(filePath));
  }

  /**
   * Clear the entire cache
   */
  clear(): void {
    this.fileHashes.clear();
    this.parsedFiles.clear();
    this.analysisResults.clear();
    this.dependencies.clear();
    this.dependents.clear();
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    filesCount: number;
    dependencyEdges: number;
  } {
    let dependencyEdges = 0;
    for (const deps of this.dependencies.values()) {
      dependencyEdges += deps.size;
    }

    return {
      filesCount: this.parsedFiles.size,
      dependencyEdges,
    };
  }

  /**
   * Remove a file from the cache entirely (e.g., when deleted)
   */
  removeFile(filePath: string): void {
    const normalizedPath = this.normalizePath(filePath);

    // Clear this file's entries
    this.fileHashes.delete(normalizedPath);
    this.parsedFiles.delete(normalizedPath);
    this.analysisResults.delete(normalizedPath);

    // Remove from dependency graph
    const deps = this.dependencies.get(normalizedPath);
    if (deps) {
      for (const dep of deps) {
        const depDependents = this.dependents.get(dep);
        if (depDependents) {
          depDependents.delete(normalizedPath);
        }
      }
    }
    this.dependencies.delete(normalizedPath);

    // Remove as a dependent of other files
    this.dependents.delete(normalizedPath);
    for (const [, dependents] of this.dependents) {
      dependents.delete(normalizedPath);
    }
  }

  private normalizePath(filePath: string): string {
    // Normalize path separators (keep case-sensitive for Linux compatibility)
    return filePath.replace(/\\/g, '/');
  }

  private computeHash(content: string): string {
    return createHash('md5').update(content).digest('hex');
  }
}
