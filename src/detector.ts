import { glob } from 'glob';
import * as path from 'path';
import { parseFile, HookInfo, ParsedFile } from './parser';

export interface CircularDependency {
  file: string;
  line: number;
  hookName: string;
  cycle: string[];
}

export interface DetectionResults {
  circularDependencies: CircularDependency[];
  summary: {
    filesAnalyzed: number;
    hooksAnalyzed: number;
    circularDependencies: number;
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
    try {
      const parsed = parseFile(file);
      parsedFiles.push(parsed);
    } catch (error) {
      console.warn(`Warning: Could not parse ${file}:`, error);
    }
  }

  const circularDeps = findCircularDependencies(parsedFiles);
  
  const totalHooks = parsedFiles.reduce((sum, file) => sum + file.hooks.length, 0);
  
  return {
    circularDependencies: circularDeps,
    summary: {
      filesAnalyzed: parsedFiles.length,
      hooksAnalyzed: totalHooks,
      circularDependencies: circularDeps.length,
    },
  };
}

async function findFiles(targetPath: string, options: DetectorOptions): Promise<string[]> {
  const pattern = path.join(targetPath, options.pattern);
  const files = await glob(pattern, {
    ignore: options.ignore,
    absolute: true,
  });
  
  return files;
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
  
  for (let i = 0; i < deps.length; i++) {
    for (let j = i + 1; j < deps.length; j++) {
      const dep1 = deps[i];
      const dep2 = deps[j];
      
      if (hasCyclicDependency(dep1, dep2, variables)) {
        cycles.push([dep1, dep2, dep1]);
      }
    }
  }
  
  for (const dep of deps) {
    const selfCycle = checkSelfReferentialDependency(dep, variables);
    if (selfCycle.length > 1) {
      cycles.push(selfCycle);
    }
  }
  
  return cycles;
}

function hasCyclicDependency(
  var1: string,
  var2: string,
  variables: Map<string, Set<string>>
): boolean {
  const deps1 = variables.get(var1);
  const deps2 = variables.get(var2);
  
  if (!deps1 || !deps2) return false;
  
  return deps1.has(var2) && deps2.has(var1);
}

function checkSelfReferentialDependency(
  varName: string,
  variables: Map<string, Set<string>>,
  visited = new Set<string>()
): string[] {
  if (visited.has(varName)) {
    return [varName];
  }
  
  visited.add(varName);
  const deps = variables.get(varName);
  
  if (!deps) return [];
  
  for (const dep of deps) {
    if (dep === varName) {
      return [varName, varName];
    }
    
    const cycle = checkSelfReferentialDependency(dep, variables, visited);
    if (cycle.length > 0) {
      return [varName, ...cycle];
    }
  }
  
  return [];
}