import * as t from '@babel/types';
import traverse, { NodePath } from '@babel/traverse';
import { HookInfo, ParsedFile } from './parser';

export interface StateSetter {
  name: string; // e.g., "setIsLoading"
  stateVariable: string; // e.g., "isLoading"
  line: number;
  file: string;
}

export interface FunctionCall {
  caller: string; // Function that makes the call
  callee: string; // Function being called
  line: number;
  file: string;
}

export interface HooksDependencyLoop {
  type: 'useCallback-setState' | 'useEffect-useCallback' | 'indirect-state-mutation';
  description: string;
  functions: string[];
  stateVariables: string[];
  files: string[];
  severity: 'high' | 'medium' | 'low';
}

export interface HooksAnalysisResult {
  dependencyLoops: HooksDependencyLoop[];
  stateSetters: StateSetter[];
  functionCalls: FunctionCall[];
  hooks: HookInfo[];
}

export class HooksDependencyAnalyzer {
  private stateSetters: Map<string, StateSetter[]> = new Map();
  private functionCalls: Map<string, FunctionCall[]> = new Map();
  private hooks: Map<string, HookInfo[]> = new Map();

  analyzeFiles(parsedFiles: ParsedFile[]): HooksAnalysisResult {
    // Clear previous analysis
    this.stateSetters.clear();
    this.functionCalls.clear();
    this.hooks.clear();

    // Analyze each file
    for (const file of parsedFiles) {
      this.analyzeFile(file);
    }

    // Detect dependency loops
    const dependencyLoops = this.detectDependencyLoops();

    return {
      dependencyLoops,
      stateSetters: Array.from(this.stateSetters.values()).flat(),
      functionCalls: Array.from(this.functionCalls.values()).flat(),
      hooks: Array.from(this.hooks.values()).flat(),
    };
  }

  private analyzeFile(file: ParsedFile): void {
    try {
      // Store hooks for this file
      this.hooks.set(file.file, file.hooks);

      // Use the cached AST from ParsedFile instead of re-parsing
      this.extractStateSettersAndCalls(file.ast, file.file);
    } catch (error) {
      console.warn(`Could not analyze hooks in ${file.file}:`, error);
    }
  }

  private extractStateSettersAndCalls(ast: t.Node, filePath: string): void {
    const stateSetters: StateSetter[] = [];
    const functionCalls: FunctionCall[] = [];
    let currentFunction: string | null = null;

    // Bind methods to preserve 'this' context
    const extractStateVariableFromSetter = this.extractStateVariableFromSetter.bind(this);
    const isBuiltinFunction = this.isBuiltinFunction.bind(this);

    traverse(ast, {
      // Track function definitions
      FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
        if (path.node.id) {
          currentFunction = path.node.id.name;
        }
      },

      VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
        // Track useState declarations to find state setters
        if (t.isIdentifier(path.node.id) || t.isArrayPattern(path.node.id)) {
          if (
            t.isCallExpression(path.node.init) &&
            t.isIdentifier(path.node.init.callee) &&
            path.node.init.callee.name === 'useState'
          ) {
            if (t.isArrayPattern(path.node.id) && path.node.id.elements.length >= 2) {
              const setter = path.node.id.elements[1];
              if (t.isIdentifier(setter)) {
                // Extract state variable name from setter (e.g., setIsLoading -> isLoading)
                const setterName = setter.name;
                const stateVar = extractStateVariableFromSetter(setterName);

                stateSetters.push({
                  name: setterName,
                  stateVariable: stateVar,
                  line: path.node.loc?.start.line || 0,
                  file: filePath,
                });
              }
            }
          }
        }

        // Track function assignments (const funcName = useCallback(...))
        if (t.isIdentifier(path.node.id) && t.isCallExpression(path.node.init)) {
          if (
            t.isIdentifier(path.node.init.callee) &&
            (path.node.init.callee.name === 'useCallback' ||
              path.node.init.callee.name === 'useMemo')
          ) {
            currentFunction = path.node.id.name;
          }
        }
      },

      // Track function calls
      CallExpression(path: NodePath<t.CallExpression>) {
        if (currentFunction && t.isIdentifier(path.node.callee)) {
          const calleeName = path.node.callee.name;

          // Track state setter calls
          if (calleeName.startsWith('set') && calleeName.length > 3) {
            const stateVar = extractStateVariableFromSetter(calleeName);
            stateSetters.push({
              name: calleeName,
              stateVariable: stateVar,
              line: path.node.loc?.start.line || 0,
              file: filePath,
            });
          }

          // Track other function calls
          if (!isBuiltinFunction(calleeName)) {
            functionCalls.push({
              caller: currentFunction,
              callee: calleeName,
              line: path.node.loc?.start.line || 0,
              file: filePath,
            });
          }
        }
      },

      // Reset current function when exiting
      'FunctionDeclaration|ArrowFunctionExpression|FunctionExpression': {
        exit() {
          currentFunction = null;
        },
      },
    });

    this.stateSetters.set(filePath, stateSetters);
    this.functionCalls.set(filePath, functionCalls);
  }

  private extractStateVariableFromSetter(setterName: string): string {
    // Convert setIsLoading -> isLoading, setUser -> user, etc.
    if (setterName.startsWith('set') && setterName.length > 3) {
      const withoutSet = setterName.slice(3);
      return withoutSet.charAt(0).toLowerCase() + withoutSet.slice(1);
    }
    return setterName;
  }

  private isBuiltinFunction(name: string): boolean {
    const builtins = [
      'console',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Promise',
      'Date',
      'Math',
      'Object',
      'Array',
      'JSON',
      'parseInt',
      'parseFloat',
      'useState',
      'useEffect',
      'useCallback',
      'useMemo',
      'useRef',
      'useContext',
      'useReducer',
      'useLayoutEffect',
    ];
    return builtins.includes(name);
  }

  private detectDependencyLoops(): HooksDependencyLoop[] {
    const loops: HooksDependencyLoop[] = [];

    // For each hook, check if it creates a dependency loop
    for (const [filePath, hooks] of this.hooks) {
      for (const hook of hooks) {
        const detectedLoops = this.analyzeHookForLoops(hook, filePath);
        loops.push(...detectedLoops);
      }
    }

    return loops;
  }

  private analyzeHookForLoops(hook: HookInfo, filePath: string): HooksDependencyLoop[] {
    const loops: HooksDependencyLoop[] = [];

    if (hook.name === 'useCallback' || hook.name === 'useMemo') {
      // Check if this function depends on state that it modifies
      const loopsFromStateModification = this.checkStateModificationLoops(hook, filePath);
      loops.push(...loopsFromStateModification);
    }

    if (hook.name === 'useEffect') {
      // Check if this effect depends on functions that create loops
      const loopsFromEffectDeps = this.checkEffectDependencyLoops(hook, filePath);
      loops.push(...loopsFromEffectDeps);
    }

    return loops;
  }

  private checkStateModificationLoops(hook: HookInfo, filePath: string): HooksDependencyLoop[] {
    const loops: HooksDependencyLoop[] = [];

    // Get the function name for this hook
    const functionName = this.getFunctionNameForHook();
    if (!functionName) return loops;

    // Check if this function modifies any state it depends on
    for (const dep of hook.dependencies) {
      const modifiesState = this.doesFunctionModifyState(functionName, dep, filePath);
      if (modifiesState) {
        loops.push({
          type: 'useCallback-setState',
          description: `Function '${functionName}' depends on state '${dep}' but modifies it, creating a potential infinite re-creation loop`,
          functions: [functionName],
          stateVariables: [dep],
          files: [filePath],
          severity: 'high',
        });
      }
    }

    return loops;
  }

  private checkEffectDependencyLoops(hook: HookInfo, filePath: string): HooksDependencyLoop[] {
    const loops: HooksDependencyLoop[] = [];

    // Check each function dependency of the useEffect
    for (const dep of hook.dependencies) {
      // If this dependency is a function, check if it creates loops
      const isFunction = this.isFunctionDependency(dep, filePath);
      if (isFunction) {
        const functionLoops = this.checkFunctionForIndirectStateLoops(dep, filePath);
        if (functionLoops.length > 0) {
          loops.push({
            type: 'useEffect-useCallback',
            description: `useEffect depends on function '${dep}' which creates state modification loops, causing infinite effect re-runs`,
            functions: [dep, ...functionLoops.flatMap((l) => l.functions)],
            stateVariables: functionLoops.flatMap((l) => l.stateVariables),
            files: [filePath],
            severity: 'high',
          });
        }
      }
    }

    return loops;
  }

  private getFunctionNameForHook(): string | null {
    // This is a simplified approach - in practice, we'd need more sophisticated AST analysis
    // to map hooks to their function names
    return null; // TODO: Implement proper hook-to-function mapping
  }

  private doesFunctionModifyState(
    functionName: string,
    stateName: string,
    filePath: string
  ): boolean {
    const setterName = 'set' + stateName.charAt(0).toUpperCase() + stateName.slice(1);

    // Check direct calls to state setter
    const calls = this.functionCalls.get(filePath) || [];
    const directCall = calls.some(
      (call) => call.caller === functionName && call.callee === setterName
    );

    if (directCall) return true;

    // Check indirect calls through other functions
    return this.doesFunctionIndirectlyModifyState(functionName, setterName, filePath, new Set());
  }

  private doesFunctionIndirectlyModifyState(
    functionName: string,
    setterName: string,
    filePath: string,
    visited: Set<string>
  ): boolean {
    if (visited.has(functionName)) return false;
    visited.add(functionName);

    const calls = this.functionCalls.get(filePath) || [];
    const functionCalls = calls.filter((call) => call.caller === functionName);

    for (const call of functionCalls) {
      // Direct call to setter
      if (call.callee === setterName) return true;

      // Recursive check
      if (this.doesFunctionIndirectlyModifyState(call.callee, setterName, filePath, visited)) {
        return true;
      }
    }

    return false;
  }

  private isFunctionDependency(depName: string, filePath: string): boolean {
    // Check if this dependency name corresponds to a function (useCallback/useMemo)
    const hooks = this.hooks.get(filePath) || [];
    return hooks.some(
      (hook) =>
        (hook.name === 'useCallback' || hook.name === 'useMemo') &&
        hook.dependencies.includes(depName)
    );
  }

  private checkFunctionForIndirectStateLoops(
    functionName: string,
    filePath: string
  ): HooksDependencyLoop[] {
    // Simplified implementation - check if function modifies state it depends on
    const hooks = this.hooks.get(filePath) || [];
    const functionHook = hooks.find(
      (hook) =>
        (hook.name === 'useCallback' || hook.name === 'useMemo') &&
        // TODO: Map hook to function name properly
        false
    );

    if (functionHook) {
      return this.checkStateModificationLoops(functionHook, filePath);
    }

    return [];
  }
}
