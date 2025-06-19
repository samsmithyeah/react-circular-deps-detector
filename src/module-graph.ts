import * as path from 'path';
import { ParsedFile, ImportInfo, ExportInfo } from './parser';

export interface ModuleDependency {
  from: string;
  to: string;
  importedItems: string[];
  line: number;
}

export interface CrossFileCycle {
  files: string[];
  dependencies: ModuleDependency[];
  type: 'import' | 'context' | 'function-call';
}

export interface ModuleGraph {
  dependencies: Map<string, ModuleDependency[]>;
  exports: Map<string, ExportInfo[]>;
  crossFileCycles: CrossFileCycle[];
}

export function buildModuleGraph(parsedFiles: ParsedFile[]): ModuleGraph {
  const dependencies = new Map<string, ModuleDependency[]>();
  const exports = new Map<string, ExportInfo[]>();
  
  // Build maps for quick lookup
  const filesByPath = new Map<string, ParsedFile>();
  parsedFiles.forEach(file => {
    filesByPath.set(file.file, file);
    exports.set(file.file, file.exports);
    dependencies.set(file.file, []);
  });

  // Build dependency graph
  parsedFiles.forEach(file => {
    file.imports.forEach(importInfo => {
      const resolvedPath = resolveImportPath(file.file, importInfo.source);
      const targetFile = findFileByPath(parsedFiles, resolvedPath);
      
      if (targetFile) {
        const dependency: ModuleDependency = {
          from: file.file,
          to: targetFile.file,
          importedItems: importInfo.imports,
          line: importInfo.line,
        };
        
        const fileDeps = dependencies.get(file.file) || [];
        fileDeps.push(dependency);
        dependencies.set(file.file, fileDeps);
      }
    });
  });

  // Detect cross-file cycles
  const crossFileCycles = detectCrossFileCycles(dependencies);

  return {
    dependencies,
    exports,
    crossFileCycles,
  };
}

function resolveImportPath(fromFile: string, importPath: string): string {
  const fromDir = path.dirname(fromFile);
  let resolvedPath = path.resolve(fromDir, importPath);
  
  // Handle imports without extensions
  const possibleExtensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
  
  for (const ext of possibleExtensions) {
    const testPath = resolvedPath + ext;
    if (resolvedPath.endsWith(ext)) {
      return resolvedPath;
    }
  }
  
  return resolvedPath;
}

function findFileByPath(parsedFiles: ParsedFile[], targetPath: string): ParsedFile | null {
  // Try exact match first
  for (const file of parsedFiles) {
    if (file.file === targetPath) {
      return file;
    }
  }
  
  // Try with different extensions
  const possibleExtensions = ['.ts', '.tsx', '.js', '.jsx'];
  const basePath = targetPath.replace(/\.(ts|tsx|js|jsx)$/, '');
  
  for (const ext of possibleExtensions) {
    const testPath = basePath + ext;
    for (const file of parsedFiles) {
      if (file.file === testPath) {
        return file;
      }
    }
  }
  
  // Try index files
  const indexPaths = [
    path.join(targetPath, 'index.ts'),
    path.join(targetPath, 'index.tsx'),
    path.join(targetPath, 'index.js'),
    path.join(targetPath, 'index.jsx'),
  ];
  
  for (const indexPath of indexPaths) {
    for (const file of parsedFiles) {
      if (file.file === indexPath) {
        return file;
      }
    }
  }
  
  return null;
}

function detectCrossFileCycles(dependencies: Map<string, ModuleDependency[]>): CrossFileCycle[] {
  const cycles: CrossFileCycle[] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  
  for (const [startFile] of dependencies) {
    if (!visited.has(startFile)) {
      const pathStack: string[] = [];
      const depStack: ModuleDependency[] = [];
      findCyclesFromFile(startFile, dependencies, visited, recursionStack, pathStack, depStack, cycles);
    }
  }
  
  return cycles;
}

function findCyclesFromFile(
  currentFile: string,
  dependencies: Map<string, ModuleDependency[]>,
  visited: Set<string>,
  recursionStack: Set<string>,
  pathStack: string[],
  depStack: ModuleDependency[],
  cycles: CrossFileCycle[]
): void {
  visited.add(currentFile);
  recursionStack.add(currentFile);
  pathStack.push(currentFile);
  
  const fileDeps = dependencies.get(currentFile) || [];
  
  for (const dep of fileDeps) {
    const targetFile = dep.to;
    
    if (!visited.has(targetFile)) {
      depStack.push(dep);
      findCyclesFromFile(targetFile, dependencies, visited, recursionStack, pathStack, [...depStack], cycles);
      depStack.pop();
    } else if (recursionStack.has(targetFile)) {
      // Found a cycle
      const cycleStartIndex = pathStack.indexOf(targetFile);
      if (cycleStartIndex !== -1) {
        const cycleFiles = pathStack.slice(cycleStartIndex);
        cycleFiles.push(targetFile); // Complete the cycle
        
        const cycleDeps = [...depStack];
        cycleDeps.push(dep);
        
        cycles.push({
          files: cycleFiles,
          dependencies: cycleDeps,
          type: 'import',
        });
      }
    }
  }
  
  recursionStack.delete(currentFile);
  pathStack.pop();
}

export function detectAdvancedCrossFileCycles(
  parsedFiles: ParsedFile[],
  moduleGraph: ModuleGraph
): CrossFileCycle[] {
  const advancedCycles: CrossFileCycle[] = [];
  
  // Detect context dependency cycles
  const contextCycles = detectContextCycles(parsedFiles, moduleGraph);
  advancedCycles.push(...contextCycles);
  
  // Detect function call cycles (more complex analysis)
  const functionCycles = detectFunctionCallCycles(parsedFiles, moduleGraph);
  advancedCycles.push(...functionCycles);
  
  return advancedCycles;
}

function detectContextCycles(parsedFiles: ParsedFile[], moduleGraph: ModuleGraph): CrossFileCycle[] {
  const cycles: CrossFileCycle[] = [];
  
  // Find files that create contexts
  const contextProviders = new Map<string, string[]>();
  parsedFiles.forEach(file => {
    if (file.contexts.size > 0) {
      contextProviders.set(file.file, Array.from(file.contexts));
    }
  });
  
  // Find files that use contexts (import context from another file)
  parsedFiles.forEach(file => {
    file.imports.forEach(imp => {
      const resolvedPath = resolveImportPath(file.file, imp.source);
      const targetFile = findFileByPath(parsedFiles, resolvedPath);
      
      if (targetFile && targetFile.contexts.size > 0) {
        // Check if the context provider file also imports from the consumer file
        const providerImports = targetFile.imports;
        const hasCircularRef = providerImports.some(providerImp => {
          const providerResolvedPath = resolveImportPath(targetFile.file, providerImp.source);
          return providerResolvedPath === file.file;
        });
        
        if (hasCircularRef) {
          cycles.push({
            files: [file.file, targetFile.file, file.file],
            dependencies: [
              {
                from: file.file,
                to: targetFile.file,
                importedItems: imp.imports,
                line: imp.line,
              }
            ],
            type: 'context',
          });
        }
      }
    });
  });
  
  return cycles;
}

function detectFunctionCallCycles(parsedFiles: ParsedFile[], moduleGraph: ModuleGraph): CrossFileCycle[] {
  // This is a simplified version - a full implementation would require
  // call graph analysis to track function invocations across files
  const cycles: CrossFileCycle[] = [];
  
  // For now, we detect potential cycles based on mutual imports of functions
  parsedFiles.forEach(file => {
    const importedFunctions = new Set<string>();
    
    file.imports.forEach(imp => {
      const resolvedPath = resolveImportPath(file.file, imp.source);
      const targetFile = findFileByPath(parsedFiles, resolvedPath);
      
      if (targetFile) {
        // Check if imported items are functions
        imp.imports.forEach(importedItem => {
          if (targetFile.functions.has(importedItem)) {
            importedFunctions.add(importedItem);
          }
        });
        
        // Check if target file imports functions from current file
        const reverseImports = targetFile.imports.filter(targetImp => {
          const targetResolvedPath = resolveImportPath(targetFile.file, targetImp.source);
          return targetResolvedPath === file.file;
        });
        
        if (reverseImports.length > 0 && importedFunctions.size > 0) {
          cycles.push({
            files: [file.file, targetFile.file, file.file],
            dependencies: [
              {
                from: file.file,
                to: targetFile.file,
                importedItems: Array.from(importedFunctions),
                line: imp.line,
              }
            ],
            type: 'function-call',
          });
        }
      }
    });
  });
  
  return cycles;
}