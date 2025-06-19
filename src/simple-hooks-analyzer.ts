import * as t from '@babel/types';
import traverse from '@babel/traverse';
import { HookInfo, ParsedFile } from './parser';

export interface SimpleHookLoop {
  type: 'state-setter-dependency' | 'useEffect-function-dependency';
  description: string;
  file: string;
  line: number;
  hookName: string;
  problematicDependency: string;
  severity: 'high' | 'medium';
}

export function detectSimpleHooksLoops(parsedFiles: ParsedFile[]): SimpleHookLoop[] {
  const loops: SimpleHookLoop[] = [];

  for (const file of parsedFiles) {
    try {
      const fileLoops = analyzeFileForHooksLoops(file);
      loops.push(...fileLoops);
    } catch (error) {
      console.warn(`Could not analyze hooks loops in ${file.file}:`, error);
    }
  }

  return loops;
}

function analyzeFileForHooksLoops(file: ParsedFile): SimpleHookLoop[] {
  const loops: SimpleHookLoop[] = [];
  
  // Get file content to analyze useState declarations and function calls
  const fs = require('fs');
  const babel = require('@babel/parser');
  
  try {
    const content = fs.readFileSync(file.file, 'utf-8');
    const ast = babel.parse(content, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
    });

    // Extract useState declarations to map state variables to their setters
    const stateSetters = extractStateSetters(ast);
    
    // Extract function calls within useCallback/useMemo
    const functionCalls = extractFunctionCalls(ast);

    // Check each hook for problematic patterns
    for (const hook of file.hooks) {
      const hookLoops = analyzeHookForLoops(hook, file.file, stateSetters, functionCalls);
      loops.push(...hookLoops);
    }
  } catch (error) {
    console.warn(`Could not parse ${file.file} for hooks analysis:`, error);
  }

  return loops;
}

function extractStateSetters(ast: t.Node): Map<string, string> {
  const stateSetters = new Map<string, string>(); // setterName -> stateVariableName

  traverse(ast, {
    VariableDeclarator(path: any) {
      // Look for useState patterns: const [state, setState] = useState(...)
      if (t.isArrayPattern(path.node.id) && 
          t.isCallExpression(path.node.init) &&
          t.isIdentifier(path.node.init.callee) &&
          path.node.init.callee.name === 'useState') {
        
        const elements = path.node.id.elements;
        if (elements.length >= 2 && 
            t.isIdentifier(elements[0]) && 
            t.isIdentifier(elements[1])) {
          
          const stateVar = elements[0].name;
          const setter = elements[1].name;
          stateSetters.set(setter, stateVar);
        }
      }
    }
  });

  return stateSetters;
}

function extractFunctionCalls(ast: t.Node): Map<string, string[]> {
  const functionCalls = new Map<string, string[]>(); // functionName -> [calledFunctions]
  let currentFunction: string | null = null;

  traverse(ast, {
    VariableDeclarator(path: any) {
      // Track useCallback/useMemo function definitions
      if (t.isIdentifier(path.node.id) && 
          t.isCallExpression(path.node.init) &&
          t.isIdentifier(path.node.init.callee) &&
          (path.node.init.callee.name === 'useCallback' || path.node.init.callee.name === 'useMemo')) {
        
        currentFunction = path.node.id.name;
        if (currentFunction) {
          functionCalls.set(currentFunction, []);
        }
      }
    },

    CallExpression(path: any) {
      if (currentFunction && t.isIdentifier(path.node.callee)) {
        const calleeName = path.node.callee.name;
        
        // Track setter calls and other function calls
        if (!isBuiltinFunction(calleeName)) {
          const calls = functionCalls.get(currentFunction) || [];
          calls.push(calleeName);
          functionCalls.set(currentFunction, calls);
        }
      }
    }
  });

  return functionCalls;
}

function isBuiltinFunction(name: string): boolean {
  const builtins = [
    'console', 'setTimeout', 'clearTimeout', 'Promise', 'fetch',
    'useState', 'useEffect', 'useCallback', 'useMemo', 'useRef'
  ];
  return builtins.includes(name) || name.startsWith('use') && name[3] === name[3].toUpperCase();
}

function analyzeHookForLoops(
  hook: HookInfo, 
  filePath: string, 
  stateSetters: Map<string, string>,
  functionCalls: Map<string, string[]>
): SimpleHookLoop[] {
  const loops: SimpleHookLoop[] = [];

  if (hook.name === 'useCallback' || hook.name === 'useMemo') {
    // Check if this hook depends on state that it modifies
    for (const dep of hook.dependencies) {
      // Check if this dependency is a state variable
      const hasSetterForState = Array.from(stateSetters.values()).includes(dep);
      
      if (hasSetterForState) {
        // Find the setter name for this state
        const setterName = Array.from(stateSetters.entries())
          .find(([setter, state]) => state === dep)?.[0];
        
        if (setterName) {
          // Check if this function calls the setter (directly or indirectly)
          const functionName = findFunctionNameForHook(hook, functionCalls);
          
          if (functionName && doesFunctionCallSetter(functionName, setterName, functionCalls)) {
            loops.push({
              type: 'state-setter-dependency',
              description: `Hook depends on state '${dep}' but modifies it via '${setterName}', creating infinite re-creation`,
              file: filePath,
              line: hook.line,
              hookName: hook.name,
              problematicDependency: dep,
              severity: 'high'
            });
          }
        }
      }
    }
  }

  return loops;
}

function findFunctionNameForHook(hook: HookInfo, functionCalls: Map<string, string[]>): string | null {
  // This is a simplified approach - we'd need more sophisticated mapping
  // For now, return null if we can't determine the function name
  return null;
}

function doesFunctionCallSetter(
  functionName: string, 
  setterName: string, 
  functionCalls: Map<string, string[]>
): boolean {
  const calls = functionCalls.get(functionName) || [];
  
  // Direct call
  if (calls.includes(setterName)) {
    return true;
  }
  
  // Indirect call through other functions
  for (const calledFunction of calls) {
    if (doesFunctionCallSetter(calledFunction, setterName, functionCalls)) {
      return true;
    }
  }
  
  return false;
}