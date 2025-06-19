import { glob } from 'glob';
import * as path from 'path';
import * as fs from 'fs';
import { parseFile, HookInfo, ParsedFile } from './parser';
import { buildModuleGraph, detectAdvancedCrossFileCycles, CrossFileCycle } from './module-graph';
import { HooksDependencyAnalyzer, HooksDependencyLoop } from './hooks-dependency-analyzer';
import { detectSimpleHooksLoops, SimpleHookLoop } from './simple-hooks-analyzer';
import { detectImprovedHooksLoops, HooksLoop } from './improved-hooks-analyzer';

export interface CircularDependency {
  file: string;
  line: number;
  hookName: string;
  cycle: string[];
}

export interface DetectionResults {
  circularDependencies: CircularDependency[];
  crossFileCycles: CrossFileCycle[];
  hooksDependencyLoops: HooksDependencyLoop[];
  simpleHooksLoops: SimpleHookLoop[];
  improvedHooksLoops: HooksLoop[];
  summary: {
    filesAnalyzed: number;
    hooksAnalyzed: number;
    circularDependencies: number;
    crossFileCycles: number;
    hooksDependencyLoops: number;
    simpleHooksLoops: number;
    improvedHooksLoops: number;
  };
}

interface DetectorOptions {
  pattern: string;
  ignore: string[];
}

export async function detectCircularDependencies(
  targetPath: string,
  options: DetectorOptions
): Promise<DetectionResults> {
  const files = await findFiles(targetPath, options);
  const parsedFiles: ParsedFile[] = [];
  
  for (const file of files) {
    // Skip files that are definitely not React components
    if (!isLikelyReactFile(file)) {
      continue;
    }
    
    try {
      const parsed = parseFile(file);
      parsedFiles.push(parsed);
    } catch (error) {
      // Only show warnings if not in quiet mode (we'll add a flag for this later)
      if (process.env.NODE_ENV !== 'test') {
        console.warn(`Warning: Could not parse ${file}:`, error);
      }
    }
  }

  const circularDeps = findCircularDependencies(parsedFiles);
  
  // Build module graph and detect cross-file cycles
  const moduleGraph = buildModuleGraph(parsedFiles);
  const allCrossFileCycles = [
    ...moduleGraph.crossFileCycles,
    ...detectAdvancedCrossFileCycles(parsedFiles, moduleGraph)
  ];
  
  // Analyze React hooks dependency loops
  const hooksAnalyzer = new HooksDependencyAnalyzer();
  const hooksAnalysis = hooksAnalyzer.analyzeFiles(parsedFiles);
  
  // Run simple hooks loop detection
  const simpleHooksLoops = detectSimpleHooksLoops(parsedFiles);
  
  // Run improved hooks loop detection
  const improvedHooksLoops = detectImprovedHooksLoops(parsedFiles);
  
  const totalHooks = parsedFiles.reduce((sum, file) => sum + file.hooks.length, 0);
  
  return {
    circularDependencies: circularDeps,
    crossFileCycles: allCrossFileCycles,
    hooksDependencyLoops: hooksAnalysis.dependencyLoops,
    simpleHooksLoops: simpleHooksLoops,
    improvedHooksLoops: improvedHooksLoops,
    summary: {
      filesAnalyzed: parsedFiles.length,
      hooksAnalyzed: totalHooks,
      circularDependencies: circularDeps.length,
      crossFileCycles: allCrossFileCycles.length,
      hooksDependencyLoops: hooksAnalysis.dependencyLoops.length,
      simpleHooksLoops: simpleHooksLoops.length,
      improvedHooksLoops: improvedHooksLoops.length,
    },
  };
}

function isLikelyReactFile(filePath: string): boolean {
  try {
    // Quick check of file size - skip very large files that are likely bundled/generated
    const stats = fs.statSync(filePath);
    if (stats.size > 1024 * 1024) { // Skip files larger than 1MB
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
    const hasReactImport = /import.*from\s+['"]react['"]/.test(firstKB) || 
                          /import.*React/.test(firstKB) ||
                          /from\s+['"]react-native['"]/.test(firstKB);
    const hasHooks = /use[A-Z]/.test(firstKB);
    const hasJSX = /<[A-Z]/.test(firstKB);
    const hasReactFunction = /function.*Component|const.*=.*\(\).*=>/.test(firstKB);
    
    return hasReactImport || hasHooks || hasJSX || hasReactFunction;
  } catch (error) {
    return true; // If we can't check, include it
  }
}

async function findFiles(targetPath: string, options: DetectorOptions): Promise<string[]> {
  const pattern = path.join(targetPath, options.pattern);
  const files = await glob(pattern, {
    ignore: options.ignore,
    absolute: true,
  });
  
  // Filter out directories and files that are definitely not React files
  return files.filter(file => {
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

function detectCyclesInHook(
  hook: HookInfo,
  variables: Map<string, Set<string>>
): string[][] {
  const cycles: string[][] = [];
  const deps = hook.dependencies;
  
  // Only check for actual cycles where functions depend on each other
  // Skip simple variable name matches that don't represent actual dependencies
  for (const dep of deps) {
    const cycle = findRealCircularDependency(dep, variables, new Set(), [dep]);
    if (cycle.length > 2) { // Real cycle must have at least 3 elements
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
  const commonReactHooks = ['useState', 'useEffect', 'useCallback', 'useMemo', 'useRef', 'useContext', 'useReducer', 'useLayoutEffect'];
  const commonFirebaseFunctions = ['getDocs', 'doc', 'collection', 'query', 'orderBy', 'limit', 'where', 'setDoc', 'updateDoc', 'deleteDoc'];
  const commonUtilFunctions = ['console', 'setTimeout', 'clearTimeout', 'Date', 'Object', 'Array', 'JSON', 'Math', 'Number', 'String', 'Boolean'];
  
  if (commonReactHooks.includes(varName) || 
      commonFirebaseFunctions.includes(varName) || 
      commonUtilFunctions.includes(varName)) {
    return true;
  }
  
  // Skip only obvious primitives and constants, but be more conservative
  if (/^[A-Z_]{2,}$/.test(varName) || // CONSTANTS (at least 2 chars)
      varName.includes('.') || // property access like obj.prop
      /^(true|false|null|undefined)$/.test(varName) || // literal primitives
      /^\d+$/.test(varName)) { // pure numbers
    return true;
  }
  
  // Only skip built-in React hooks, not custom hooks
  if (varName.startsWith('use') && commonReactHooks.includes(varName)) {
    return true;
  }
  
  return false;
}