import { glob, Path } from 'glob';
import * as path from 'path';
import * as fs from 'fs';
import { cpus } from 'os';
import micromatch from 'micromatch';
import Piscina from 'piscina';
import { parseFile, parseFileWithCache, HookInfo, ParsedFile } from './parser';
import { buildModuleGraph, detectAdvancedCrossFileCycles, CrossFileCycle } from './module-graph';
import { analyzeHooks, HookAnalysis } from './orchestrator';
import {
  loadConfigWithInfo,
  mergeConfig,
  RcdConfig,
  severityLevel,
  confidenceLevel,
} from './config';
import { AstCache } from './cache';
import type { ParseResult, ParseTask } from './parse-worker';
import { getChangedFilesSinceRef } from './git-utils';
import { createPathResolver } from './path-resolver';

export interface CircularDependency {
  file: string;
  line: number;
  hookName: string;
  cycle: string[];
}

export interface DetectionResults {
  circularDependencies: CircularDependency[];
  crossFileCycles: CrossFileCycle[];
  intelligentHooksAnalysis: HookAnalysis[];
  summary: {
    filesAnalyzed: number;
    hooksAnalyzed: number;
    circularDependencies: number;
    crossFileCycles: number;
    intelligentAnalysisCount: number;
  };
}

export interface DetectorOptions {
  pattern: string;
  ignore: string[];
  /** Optional configuration override (if not provided, will load from config file) */
  config?: RcdConfig;
  /** Enable caching for improved performance on repeated runs */
  cache?: boolean;
  /** Enable debug mode to collect detailed decision information */
  debug?: boolean;
  /** Enable parallel parsing using worker threads (improves performance for large codebases) */
  parallel?: boolean;
  /** Number of worker threads (default: number of CPU cores) */
  workers?: number;
  /** Enable TypeScript strict mode for type-based stability detection */
  strict?: boolean;
  /** Custom path to tsconfig.json (for strict mode) */
  tsconfigPath?: string;
  /** Only analyze files changed since this git ref (e.g., 'main', 'HEAD~5') */
  since?: string;
  /** When using --since, also include files that import the changed files */
  includeDependents?: boolean;
}

// Minimum file count to benefit from parallel processing
const PARALLEL_THRESHOLD = 20;

export async function detectCircularDependencies(
  targetPath: string,
  options: DetectorOptions
): Promise<DetectionResults> {
  // Load configuration with preset detection
  // Merge order: defaults < presets < config file < options.config
  const configResult = loadConfigWithInfo(targetPath, {
    noPresets: options.config?.noPresets,
  });
  const config = options.config
    ? mergeConfig(configResult.config, options.config)
    : configResult.config;

  // Merge config ignore patterns with CLI ignore patterns
  const mergedIgnore = [...options.ignore, ...(config.ignore || [])];
  const mergedOptions = { ...options, ignore: mergedIgnore };

  // Get all files matching the pattern
  const allFiles = await findFiles(targetPath, mergedOptions);

  // Filter to React files first
  const allReactFiles = allFiles.filter((file) => isLikelyReactFile(file));

  // Apply git-based filtering if --since is specified
  let reactFiles: string[];
  if (options.since) {
    const gitResult = getChangedFilesSinceRef({
      since: options.since,
      cwd: targetPath,
      extensions: ['.js', '.jsx', '.ts', '.tsx'],
    });

    if (!gitResult.isGitRepo) {
      throw new Error(`Cannot use --since: "${targetPath}" is not inside a git repository`);
    }

    // Create a set of changed files for fast lookup
    const changedFilesSet = new Set(gitResult.changedFiles);

    // Filter to only files that are both React files AND changed
    reactFiles = allReactFiles.filter((file) => changedFilesSet.has(file));

    // If --include-dependents is specified, find files that import changed files
    if (options.includeDependents && reactFiles.length > 0) {
      // Scan all React files to find which ones import the changed files
      const dependentFiles = findFilesImportingChangedFiles(
        allReactFiles,
        changedFilesSet,
        targetPath
      );

      // Add dependent files to the analysis set
      const allFilesToAnalyze = new Set(reactFiles);
      for (const file of dependentFiles) {
        allFilesToAnalyze.add(file);
      }
      reactFiles = Array.from(allFilesToAnalyze);
    }
  } else {
    reactFiles = allReactFiles;
  }

  // Decide whether to use parallel processing
  // Use parallel if explicitly enabled OR if we have many files and it wasn't explicitly disabled
  const useParallel =
    options.parallel === true ||
    (options.parallel !== false && reactFiles.length >= PARALLEL_THRESHOLD && !options.cache);

  let parsedFiles: ParsedFile[];

  if (useParallel) {
    parsedFiles = await parseFilesParallel(reactFiles, options.workers);
  } else {
    parsedFiles = parseFilesSequential(
      reactFiles,
      options.cache ? new AstCache(targetPath) : undefined
    );
  }

  const circularDeps = findCircularDependencies(parsedFiles);

  // Build module graph and detect cross-file cycles
  const moduleGraph = buildModuleGraph(parsedFiles);
  const allCrossFileCycles = [
    ...moduleGraph.crossFileCycles,
    ...detectAdvancedCrossFileCycles(parsedFiles),
  ];

  // Run intelligent hooks analysis (consolidated single analyzer)
  const rawAnalysis = analyzeHooks(parsedFiles, {
    stableHooks: config.stableHooks,
    unstableHooks: config.unstableHooks,
    customFunctions: config.customFunctions,
    debug: options.debug,
    strictMode: options.strict || config.strictMode,
    tsconfigPath: options.tsconfigPath || config.tsconfigPath,
    projectRoot: targetPath,
  });

  // Filter results based on config
  const intelligentHooksAnalysis = rawAnalysis.filter((issue) => {
    // Filter by type
    if (!config.includePotentialIssues && issue.type === 'potential-issue') {
      return false;
    }

    // Filter by severity
    if (severityLevel(issue.severity) < severityLevel(config.minSeverity)) {
      return false;
    }

    // Filter by confidence
    if (confidenceLevel(issue.confidence) < confidenceLevel(config.minConfidence)) {
      return false;
    }

    return true;
  });

  const totalHooks = parsedFiles.reduce((sum, file) => sum + file.hooks.length, 0);

  return {
    circularDependencies: circularDeps,
    crossFileCycles: allCrossFileCycles,
    intelligentHooksAnalysis: intelligentHooksAnalysis,
    summary: {
      filesAnalyzed: parsedFiles.length,
      hooksAnalyzed: totalHooks,
      circularDependencies: circularDeps.length,
      crossFileCycles: allCrossFileCycles.length,
      intelligentAnalysisCount: intelligentHooksAnalysis.length,
    },
  };
}

/**
 * Parse files sequentially (used when caching is enabled or for small file counts)
 */
function parseFilesSequential(files: string[], astCache?: AstCache): ParsedFile[] {
  const parsedFiles: ParsedFile[] = [];

  for (const file of files) {
    try {
      const parsed = astCache ? parseFileWithCache(file, astCache) : parseFile(file);
      parsedFiles.push(parsed);
    } catch (error) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn(`Warning: Could not parse ${file}:`, error);
      }
    }
  }

  // Save cache at the end if caching is enabled
  if (astCache) {
    astCache.save();
  }

  return parsedFiles;
}

/**
 * Parse files in parallel using worker threads (faster for large codebases)
 */
async function parseFilesParallel(files: string[], numWorkers?: number): Promise<ParsedFile[]> {
  const workerCount = numWorkers ?? Math.max(1, cpus().length - 1);

  // Create worker pool
  const piscina = new Piscina({
    filename: path.join(__dirname, 'parse-worker.js'),
    maxThreads: workerCount,
    idleTimeout: 5000,
  });

  if (
    process.env.NODE_ENV !== 'test' &&
    !process.argv.includes('--json') &&
    !process.argv.includes('--sarif')
  ) {
    console.log(`Parsing ${files.length} files using ${workerCount} worker threads...`);
  }

  // Submit all parsing tasks
  const tasks: Promise<ParseResult>[] = files.map((filePath) =>
    piscina.run({ filePath } as ParseTask)
  );

  // Wait for all tasks to complete
  const results = await Promise.all(tasks);

  // Collect successful results
  const parsedFiles: ParsedFile[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.success && result.data) {
      parsedFiles.push(result.data);
    } else if (process.env.NODE_ENV !== 'test') {
      console.warn(`Warning: Could not parse ${files[i]}: ${result.error}`);
    }
  }

  // Destroy the worker pool
  await piscina.destroy();

  return parsedFiles;
}

function isLikelyReactFile(filePath: string): boolean {
  try {
    // Quick check of file size - skip very large files that are likely bundled/generated
    const stats = fs.statSync(filePath);
    if (stats.size > 1024 * 1024) {
      // Skip files larger than 1MB
      return false;
    }

    // Always include .tsx/.jsx files
    if (/\.(tsx|jsx)$/.test(filePath)) {
      return true;
    }

    // For .ts/.js files, check content
    const content = fs.readFileSync(filePath, 'utf-8');
    const firstKB = content.substring(0, 2048); // Check more content

    // Look for React-specific patterns
    const hasReactImport =
      /import.*from\s+['"]react['"]/.test(firstKB) ||
      /import.*React/.test(firstKB) ||
      /from\s+['"]react-native['"]/.test(firstKB);
    const hasHooks = /use[A-Z]/.test(firstKB);
    const hasJSX = /<[A-Z]/.test(firstKB);
    const hasReactFunction = /function.*Component|const.*=.*\(\).*=>/.test(firstKB);

    return hasReactImport || hasHooks || hasJSX || hasReactFunction;
  } catch {
    return true; // If we can't check, include it
  }
}

async function findFiles(targetPath: string, options: DetectorOptions): Promise<string[]> {
  const pattern = path.join(targetPath, options.pattern);

  // Build ignore function for glob v11+
  // Glob v11 uses a different ignore syntax - we need to use a function-based approach
  const ignorePatterns = options.ignore || [];

  const files = await glob(pattern, {
    ignore: {
      ignored: (p: Path) => {
        const fullPath = p.fullpath();
        // Use micromatch for robust glob pattern matching
        return micromatch.isMatch(fullPath, ignorePatterns);
      },
    },
    absolute: true,
  });

  // Filter out directories and files that are definitely not React files
  return files.filter((file) => {
    try {
      const stats = fs.statSync(file);
      return stats.isFile();
    } catch {
      return false;
    }
  });
}

function findCircularDependencies(parsedFiles: ParsedFile[]): CircularDependency[] {
  const circularDeps: CircularDependency[] = [];

  for (const file of parsedFiles) {
    for (const hook of file.hooks) {
      const cycles = detectCyclesInHook(hook, file.variables);

      for (const cycle of cycles) {
        circularDeps.push({
          file: file.file,
          line: hook.line,
          hookName: hook.name,
          cycle,
        });
      }
    }
  }

  return circularDeps;
}

function detectCyclesInHook(hook: HookInfo, variables: Map<string, Set<string>>): string[][] {
  const cycles: string[][] = [];
  const deps = hook.dependencies;

  // Only check for actual cycles where functions depend on each other
  // Skip simple variable name matches that don't represent actual dependencies
  for (const dep of deps) {
    const cycle = findRealCircularDependency(dep, variables, new Set(), [dep]);
    if (cycle.length > 2) {
      // Real cycle must have at least 3 elements
      cycles.push(cycle);
    }
  }

  return cycles;
}

function findRealCircularDependency(
  currentVar: string,
  variables: Map<string, Set<string>>,
  visited: Set<string>,
  path: string[]
): string[] {
  if (visited.has(currentVar)) {
    // Found a cycle - return the path from where the cycle starts
    const cycleStart = path.indexOf(currentVar);
    if (cycleStart !== -1) {
      return path.slice(cycleStart).concat([currentVar]);
    }
    return [];
  }

  const deps = variables.get(currentVar);
  if (!deps || deps.size === 0) {
    return [];
  }

  visited.add(currentVar);

  for (const dep of deps) {
    // Skip if this dependency looks like a primitive value or imported function
    if (isPrimitiveOrImported(dep)) {
      continue;
    }

    const cycle = findRealCircularDependency(dep, variables, visited, [...path, dep]);
    if (cycle.length > 0) {
      return cycle;
    }
  }

  visited.delete(currentVar);
  return [];
}

function isPrimitiveOrImported(varName: string): boolean {
  // Skip common React hooks, imported functions, and primitives
  const commonReactHooks = [
    'useState',
    'useEffect',
    'useCallback',
    'useMemo',
    'useRef',
    'useContext',
    'useReducer',
    'useLayoutEffect',
  ];
  const commonFirebaseFunctions = [
    'getDocs',
    'doc',
    'collection',
    'query',
    'orderBy',
    'limit',
    'where',
    'setDoc',
    'updateDoc',
    'deleteDoc',
  ];
  const commonUtilFunctions = [
    'console',
    'setTimeout',
    'clearTimeout',
    'Date',
    'Object',
    'Array',
    'JSON',
    'Math',
    'Number',
    'String',
    'Boolean',
  ];

  if (
    commonReactHooks.includes(varName) ||
    commonFirebaseFunctions.includes(varName) ||
    commonUtilFunctions.includes(varName)
  ) {
    return true;
  }

  // Skip only obvious primitives and constants, but be more conservative
  if (
    /^[A-Z_]{2,}$/.test(varName) || // CONSTANTS (at least 2 chars)
    varName.includes('.') || // property access like obj.prop
    /^(true|false|null|undefined)$/.test(varName) || // literal primitives
    /^\d+$/.test(varName)
  ) {
    // pure numbers
    return true;
  }

  // Only skip built-in React hooks, not custom hooks
  if (varName.startsWith('use') && commonReactHooks.includes(varName)) {
    return true;
  }

  return false;
}

/**
 * Find files that import any of the changed files.
 * Uses a lightweight regex-based approach to avoid full parsing overhead.
 */
function findFilesImportingChangedFiles(
  allFiles: string[],
  changedFiles: Set<string>,
  projectRoot: string
): string[] {
  const pathResolver = createPathResolver({ projectRoot });
  const dependentFiles: string[] = [];

  // Combined regex to match import, require, and dynamic import() statements in a single pass
  // Group 1: static import path, Group 2: require path, Group 3: dynamic import path
  const importRequireRegex =
    /(?:import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"])|(?:require\s*\(\s*['"]([^'"]+)['"]\s*\))|(?:import\s*\(\s*['"]([^'"]+)['"]\s*\))/g;

  for (const file of allFiles) {
    // Skip files that are already in the changed set
    if (changedFiles.has(file)) {
      continue;
    }

    try {
      const content = fs.readFileSync(file, 'utf-8');

      // Find all import paths in a single pass
      const importPaths: string[] = [];

      let match;
      while ((match = importRequireRegex.exec(content)) !== null) {
        // match[1] is for static imports, match[2] is for requires, match[3] is for dynamic imports
        const importPath = match[1] || match[2] || match[3];
        if (importPath) {
          importPaths.push(importPath);
        }
      }

      // Check if any import path resolves to a changed file
      for (const importPath of importPaths) {
        // Skip external packages
        if (
          !importPath.startsWith('.') &&
          !importPath.startsWith('@/') &&
          !importPath.startsWith('~/')
        ) {
          continue;
        }

        // Try to resolve the import
        const resolved = pathResolver.resolve(file, importPath);
        if (resolved && changedFiles.has(resolved)) {
          dependentFiles.push(file);
          break;
        }
      }
    } catch {
      // Skip files that can't be read, but warn the user
      console.warn(`Warning: Could not read file to check for dependents: ${file}`);
    }
  }

  return dependentFiles;
}
