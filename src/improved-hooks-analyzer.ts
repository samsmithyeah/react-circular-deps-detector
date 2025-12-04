import * as t from '@babel/types';
import traverse from '@babel/traverse';
import { HookInfo, ParsedFile } from './parser';

export interface HooksLoop {
  type: 'state-setter-dependency' | 'useEffect-function-loop' | 'indirect-state-mutation';
  description: string;
  file: string;
  line: number;
  hookType: string;
  functionName?: string;
  problematicDependency: string;
  stateVariable?: string;
  setterFunction?: string;
  severity: 'high' | 'medium';
}

interface HookDefinition {
  name: string;
  type: 'useCallback' | 'useMemo' | 'useEffect';
  dependencies: string[];
  line: number;
  bodyContainsSetters: string[]; // List of setState functions called in the hook body
}

interface StateSetterInfo {
  setterName: string;
  stateVariable: string;
  line: number;
}

export function detectImprovedHooksLoops(parsedFiles: ParsedFile[]): HooksLoop[] {
  const loops: HooksLoop[] = [];

  for (const file of parsedFiles) {
    try {
      const fileLoops = analyzeFileForImprovedHooksLoops(file);
      loops.push(...fileLoops);
    } catch (error) {
      console.warn(`Could not analyze hooks loops in ${file.file}:`, error);
    }
  }

  return loops;
}

function analyzeFileForImprovedHooksLoops(file: ParsedFile): HooksLoop[] {
  const loops: HooksLoop[] = [];

  try {
    // Use the cached AST from ParsedFile instead of re-parsing
    const ast = file.ast;

    // Extract comprehensive hook information
    const { hookDefinitions, stateSetters } = extractDetailedHookInfo(ast);
    
    // Check each hook for problematic patterns
    for (const hookDef of hookDefinitions) {
      const hookLoops = analyzeHookDefinitionForLoops(hookDef, stateSetters, file.file);
      loops.push(...hookLoops);
    }

    // Also check parsed hooks from our existing parser
    for (const hook of file.hooks) {
      const additionalLoops = analyzeExistingHookForLoops(hook, hookDefinitions, stateSetters, file.file);
      loops.push(...additionalLoops);
    }

  } catch (error) {
    console.warn(`Could not parse ${file.file} for improved hooks analysis:`, error);
  }

  return loops;
}

function extractDetailedHookInfo(ast: t.Node): { 
  hookDefinitions: HookDefinition[], 
  stateSetters: StateSetterInfo[] 
} {
  const hookDefinitions: HookDefinition[] = [];
  const stateSetters: StateSetterInfo[] = [];
  
  // First pass: Extract useState declarations
  traverse(ast, {
    VariableDeclarator(path: any) {
      // Extract useState patterns: const [state, setState] = useState(...)
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
          
          stateSetters.push({
            setterName: setter,
            stateVariable: stateVar,
            line: path.node.loc?.start.line || 0
          });
        }
      }

      // Extract hook definitions: const funcName = useCallback/useMemo/useEffect(...)
      if (t.isIdentifier(path.node.id) && 
          t.isCallExpression(path.node.init) &&
          t.isIdentifier(path.node.init.callee)) {
        
        const hookType = path.node.init.callee.name;
        if (['useCallback', 'useMemo', 'useEffect'].includes(hookType)) {
          const functionName = path.node.id.name;
          const args = path.node.init.arguments;
          
          let dependencies: string[] = [];
          let bodyContainsSetters: string[] = [];
          
          // Extract dependencies array (last argument)
          if (args.length >= 2 && t.isArrayExpression(args[args.length - 1])) {
            const depsArray = args[args.length - 1] as t.ArrayExpression;
            dependencies = depsArray.elements
              .filter((el): el is t.Identifier => t.isIdentifier(el))
              .map(el => el.name);
          }
          
          // Extract function calls from hook body (first argument)
          if (args.length >= 1) {
            bodyContainsSetters = extractSetterCallsFromFunction(args[0], stateSetters);
          }
          
          hookDefinitions.push({
            name: functionName,
            type: hookType as 'useCallback' | 'useMemo' | 'useEffect',
            dependencies,
            line: path.node.loc?.start.line || 0,
            bodyContainsSetters
          });
        }
      }
    }
  });

  return { hookDefinitions, stateSetters };
}

function extractSetterCallsFromFunction(functionNode: t.Node, stateSetters: StateSetterInfo[]): string[] {
  const setterCalls: string[] = [];
  const setterNames = stateSetters.map(s => s.setterName);

  // Use a visitor pattern to walk through the function node
  function visitNode(node: any): void {
    if (!node || typeof node !== 'object') return;

    // Check if this is a CallExpression
    if (node.type === 'CallExpression' && node.callee && node.callee.type === 'Identifier') {
      const calleeName = node.callee.name;
      if (setterNames.includes(calleeName)) {
        setterCalls.push(calleeName);
      }
    }

    // Recursively visit all properties
    Object.keys(node).forEach(key => {
      const value = node[key];
      if (Array.isArray(value)) {
        value.forEach(visitNode);
      } else if (value && typeof value === 'object') {
        visitNode(value);
      }
    });
  }

  visitNode(functionNode);
  return [...new Set(setterCalls)]; // Remove duplicates
}

function analyzeHookDefinitionForLoops(
  hookDef: HookDefinition, 
  stateSetters: StateSetterInfo[], 
  filePath: string
): HooksLoop[] {
  const loops: HooksLoop[] = [];

  if (hookDef.type === 'useCallback' || hookDef.type === 'useMemo') {
    // Pattern 1: Hook depends on state that it modifies
    for (const dep of hookDef.dependencies) {
      // Check if this dependency is a state variable
      const stateInfo = stateSetters.find(s => s.stateVariable === dep);
      
      if (stateInfo) {
        // Check if this hook calls the setter for this state
        if (hookDef.bodyContainsSetters.includes(stateInfo.setterName)) {
          loops.push({
            type: 'state-setter-dependency',
            description: `Function '${hookDef.name}' depends on state '${dep}' but calls '${stateInfo.setterName}' to modify it, creating infinite re-creation`,
            file: filePath,
            line: hookDef.line,
            hookType: hookDef.type,
            functionName: hookDef.name,
            problematicDependency: dep,
            stateVariable: dep,
            setterFunction: stateInfo.setterName,
            severity: 'high'
          });
        }
      }
    }
  }

  if (hookDef.type === 'useEffect') {
    // Pattern 2: useEffect depends on functions that could create loops
    for (const dep of hookDef.dependencies) {
      // Check if this dependency is a function that could create loops
      const functionInfo = findFunctionThatMayLoop(dep, stateSetters);
      if (functionInfo) {
        loops.push({
          type: 'useEffect-function-loop',
          description: `useEffect depends on function '${dep}' which may create infinite re-renders through state modifications`,
          file: filePath,
          line: hookDef.line,
          hookType: hookDef.type,
          functionName: hookDef.name,
          problematicDependency: dep,
          severity: 'high'
        });
      }
    }
  }

  return loops;
}

function analyzeExistingHookForLoops(
  hook: HookInfo, 
  hookDefinitions: HookDefinition[], 
  stateSetters: StateSetterInfo[], 
  filePath: string
): HooksLoop[] {
  const loops: HooksLoop[] = [];

  // Find matching hook definition
  const matchingDef = hookDefinitions.find(def => 
    def.line === hook.line && def.type === hook.name
  );

  if (!matchingDef) {
    // Fallback: Analyze using basic pattern matching
    for (const dep of hook.dependencies) {
      const stateInfo = stateSetters.find(s => s.stateVariable === dep);
      if (stateInfo) {
        // Check if there's a pattern that suggests this could be problematic
        const potentialSetter = 'set' + dep.charAt(0).toUpperCase() + dep.slice(1);
        if (stateSetters.some(s => s.setterName === potentialSetter)) {
          loops.push({
            type: 'state-setter-dependency',
            description: `Hook at line ${hook.line} depends on state '${dep}' and may modify it via '${potentialSetter}', potentially creating infinite re-creation`,
            file: filePath,
            line: hook.line,
            hookType: hook.name,
            problematicDependency: dep,
            stateVariable: dep,
            setterFunction: potentialSetter,
            severity: 'medium'
          });
        }
      }
    }
  }

  return loops;
}

function findFunctionThatMayLoop(functionName: string, stateSetters: StateSetterInfo[]): boolean {
  // This is a simplified heuristic - in a full implementation, we'd track
  // function call graphs to see if the function eventually calls state setters
  
  // For now, we'll flag functions that have names suggesting they might modify state
  const suspiciousPatterns = [
    /^(update|set|modify|change|toggle|switch)/i,
    /^handle/i,
    /tracking/i,
    /mode/i
  ];

  return suspiciousPatterns.some(pattern => pattern.test(functionName));
}