import * as t from '@babel/types';
import { ParsedFile } from './parser';

export interface FunctionDefinition {
  name: string;
  file: string;
  line: number;
  parameters: string[];
  callsStateSetters: string[]; // Which state setters this function calls
  callsFunctions: string[]; // Which other functions this function calls
  isExported: boolean;
  isAsync: boolean;
}

export interface FunctionCall {
  functionName: string;
  file: string;
  line: number;
  arguments: string[]; // Argument names/expressions
  inHookBody: boolean; // Whether this call is inside a hook
  hookType?: string;
  passesStateSetters: string[]; // State setters passed as arguments
  hookStartLine?: number; // Line where the hook starts (for consistent hookId)
}

export interface CrossFileAnalysis {
  functions: Map<string, FunctionDefinition>; // functionName -> definition
  calls: FunctionCall[];
  stateSetterFlows: Map<string, string[]>; // hookId -> functions that eventually modify state
}

export function analyzeCrossFileRelations(parsedFiles: ParsedFile[]): CrossFileAnalysis {
  const functions = new Map<string, FunctionDefinition>();
  const calls: FunctionCall[] = [];

  // Phase 1: Extract all function definitions and calls
  for (const file of parsedFiles) {
    try {
      const { fileFunctions, fileCalls } = extractFileAnalysis(file);

      // Store function definitions
      fileFunctions.forEach((func) => {
        const key = `${func.name}@${func.file}`;
        functions.set(key, func);

        // Also store by name only for exported functions
        if (func.isExported) {
          functions.set(func.name, func);
        }
      });

      calls.push(...fileCalls);
    } catch (error) {
      console.warn(`Could not analyze ${file.file} for cross-file relations:`, error);
    }
  }

  // Phase 2: Build function call graph and trace state modifications
  const stateSetterFlows = traceFunctionCallFlows(functions, calls);

  return {
    functions,
    calls,
    stateSetterFlows,
  };
}

/**
 * Build a mapping from local names (aliases) to original imported names.
 * For example: `import { updateData as refreshData }` creates a mapping
 * "refreshData" -> "updateData"
 */
function buildImportAliasMap(file: ParsedFile): Map<string, string> {
  const aliasMap = new Map<string, string>();

  for (const importInfo of file.imports) {
    for (const [localName, originalName] of importInfo.importedNames) {
      // Only add to the map if there's an actual alias (local name differs from original)
      if (localName !== originalName) {
        aliasMap.set(localName, originalName);
      }
    }
  }

  return aliasMap;
}

/**
 * Resolve a function name to its original name using the alias map.
 * If the name is an alias, return the original name; otherwise return as-is.
 */
function resolveAlias(name: string, aliasMap: Map<string, string>): string {
  return aliasMap.get(name) || name;
}

function extractFileAnalysis(file: ParsedFile): {
  fileFunctions: FunctionDefinition[];
  fileCalls: FunctionCall[];
} {
  const fileFunctions: FunctionDefinition[] = [];
  const fileCalls: FunctionCall[] = [];

  try {
    // Use the cached AST from ParsedFile instead of re-parsing
    const ast = file.ast;

    // Build alias map for resolving renamed imports
    const aliasMap = buildImportAliasMap(file);

    // Extract state setters for this file
    const stateSetters = extractStateSetters(ast);

    // Find all function definitions
    const functionDefs = findFunctionDefinitions(ast, file.file, stateSetters, aliasMap);
    fileFunctions.push(...functionDefs);

    // Find all function calls, especially those in hooks
    const functionCalls = findFunctionCalls(ast, file.file, stateSetters, aliasMap);
    fileCalls.push(...functionCalls);
  } catch (error) {
    console.warn(`Could not parse ${file.file} for cross-file analysis:`, error);
  }

  return { fileFunctions, fileCalls };
}

// Type for indexable AST nodes for traversal
type IndexableNode = Record<string, unknown>;

function extractStateSetters(ast: t.Node): Map<string, string> {
  const stateSetters = new Map<string, string>(); // setter -> state variable

  function visitNode(node: t.Node | null | undefined): void {
    if (!node || typeof node !== 'object') return;

    // Extract useState patterns: const [state, setState] = useState(...)
    if (
      node.type === 'VariableDeclarator' &&
      node.id &&
      node.id.type === 'ArrayPattern' &&
      node.init &&
      node.init.type === 'CallExpression' &&
      node.init.callee &&
      node.init.callee.type === 'Identifier' &&
      node.init.callee.name === 'useState'
    ) {
      const elements = node.id.elements;
      if (
        elements &&
        elements.length >= 2 &&
        elements[0] &&
        elements[0].type === 'Identifier' &&
        elements[1] &&
        elements[1].type === 'Identifier'
      ) {
        const stateVar = elements[0].name;
        const setter = elements[1].name;
        stateSetters.set(setter, stateVar);
      }
    }

    // Recursively visit all properties
    const indexableNode = node as unknown as IndexableNode;
    Object.keys(node).forEach((key) => {
      const value = indexableNode[key];
      if (Array.isArray(value)) {
        value.forEach((child) => visitNode(child as t.Node | null | undefined));
      } else if (value && typeof value === 'object' && (value as { type?: string }).type) {
        visitNode(value as t.Node);
      }
    });
  }

  visitNode(ast);
  return stateSetters;
}

function findFunctionDefinitions(
  ast: t.Node,
  fileName: string,
  stateSetters: Map<string, string>,
  aliasMap: Map<string, string>
): FunctionDefinition[] {
  const functions: FunctionDefinition[] = [];

  function visitNode(node: t.Node | null | undefined, parent?: t.Node | null): void {
    if (!node || typeof node !== 'object') return;

    // Function declarations: function myFunc() {}
    if (node.type === 'FunctionDeclaration' && node.id && node.id.name) {
      const func = analyzeFunctionNode(node, fileName, stateSetters, aliasMap, parent);
      if (func) functions.push(func);
    }

    // Arrow functions in variable declarations: const myFunc = () => {}
    if (
      node.type === 'VariableDeclarator' &&
      node.id &&
      node.id.type === 'Identifier' &&
      node.init &&
      (node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression')
    ) {
      const func = analyzeFunctionNode(
        node.init,
        fileName,
        stateSetters,
        aliasMap,
        parent,
        node.id.name
      );
      if (func) functions.push(func);
    }

    // Method definitions in objects/classes
    if (t.isObjectProperty(node) && t.isIdentifier(node.key) && t.isExpression(node.value)) {
      const value = node.value;
      if (t.isArrowFunctionExpression(value) || t.isFunctionExpression(value)) {
        const func = analyzeFunctionNode(
          value,
          fileName,
          stateSetters,
          aliasMap,
          parent,
          node.key.name
        );
        if (func) functions.push(func);
      }
    }

    // Recursively visit all properties
    const indexableNode = node as unknown as IndexableNode;
    Object.keys(node).forEach((key) => {
      const value = indexableNode[key];
      if (Array.isArray(value)) {
        value.forEach((child) => visitNode(child as t.Node | null | undefined, node));
      } else if (value && typeof value === 'object' && (value as { type?: string }).type) {
        visitNode(value as t.Node, node);
      }
    });
  }

  visitNode(ast);
  return functions;
}

function analyzeFunctionNode(
  node: t.FunctionDeclaration | t.ArrowFunctionExpression | t.FunctionExpression,
  fileName: string,
  stateSetters: Map<string, string>,
  aliasMap: Map<string, string>,
  parent?: t.Node | null,
  nameOverride?: string
): FunctionDefinition | null {
  // FunctionDeclaration has id, ArrowFunctionExpression and FunctionExpression may not
  const nodeId = 'id' in node && node.id ? node.id.name : undefined;
  const name = nameOverride || nodeId || 'anonymous';
  const line = node.loc?.start.line || 0;

  // Extract parameters
  const parameters: string[] = [];
  const setterLikeParams: string[] = [];
  if (node.params) {
    node.params.forEach((param) => {
      if (t.isIdentifier(param)) {
        parameters.push(param.name);
        // Detect setter-like parameters (functions that start with 'set' and have camelCase)
        if (
          param.name.startsWith('set') &&
          param.name.length > 3 &&
          param.name[3] === param.name[3].toUpperCase()
        ) {
          setterLikeParams.push(param.name);
        }
      }
    });
  }

  // Check if function is exported
  const isExported = isNodeExported(parent);

  // Check if function is async
  const isAsync = node.async || false;

  // Analyze what this function calls
  const analysis = analyzeFunctionBody(node.body || node, stateSetters, aliasMap, setterLikeParams);

  return {
    name,
    file: fileName,
    line,
    parameters,
    callsStateSetters: analysis.callsStateSetters,
    callsFunctions: analysis.callsFunctions,
    isExported,
    isAsync,
  };
}

function analyzeFunctionBody(
  body: t.BlockStatement | t.Expression | null | undefined,
  stateSetters: Map<string, string>,
  aliasMap: Map<string, string>,
  parameters: string[] = []
): {
  callsStateSetters: string[];
  callsFunctions: string[];
} {
  const callsStateSetters: string[] = [];
  const callsFunctions: string[] = [];
  const setterNames = Array.from(stateSetters.keys());

  function visitNode(node: t.Node | null | undefined): void {
    if (!node || typeof node !== 'object') return;

    // Look for function calls
    if (node.type === 'CallExpression' && node.callee) {
      if (node.callee.type === 'Identifier') {
        const funcName = node.callee.name;

        // Check if it's a state setter (either from useState or passed as parameter)
        if (setterNames.includes(funcName) || parameters.includes(funcName)) {
          callsStateSetters.push(funcName);
        } else {
          // Resolve alias to original function name for cross-file lookup
          const resolvedFuncName = resolveAlias(funcName, aliasMap);
          callsFunctions.push(resolvedFuncName);
        }
      }
    }

    // Recursively visit all properties
    const indexableNode = node as unknown as IndexableNode;
    Object.keys(node).forEach((key) => {
      const value = indexableNode[key];
      if (Array.isArray(value)) {
        value.forEach((child) => visitNode(child as t.Node | null | undefined));
      } else if (value && typeof value === 'object' && (value as { type?: string }).type) {
        visitNode(value as t.Node);
      }
    });
  }

  visitNode(body);

  return {
    callsStateSetters: [...new Set(callsStateSetters)],
    callsFunctions: [...new Set(callsFunctions)],
  };
}

function findFunctionCalls(
  ast: t.Node,
  fileName: string,
  stateSetters: Map<string, string>,
  aliasMap: Map<string, string>
): FunctionCall[] {
  const calls: FunctionCall[] = [];
  const setterNames = Array.from(stateSetters.keys());

  function visitNode(
    node: t.Node | null | undefined,
    context?: { inHook?: boolean; hookType?: string; hookStartLine?: number }
  ): void {
    if (!node || typeof node !== 'object') return;

    // Track when we're inside a hook
    let currentContext = context || {};

    if (node.type === 'CallExpression' && node.callee && node.callee.type === 'Identifier') {
      const calleeName = node.callee.name;

      // Check if this is a hook call
      if (['useEffect', 'useCallback', 'useMemo', 'useLayoutEffect'].includes(calleeName)) {
        currentContext = {
          inHook: true,
          hookType: calleeName,
          hookStartLine: node.loc?.start.line || 0,
        };
      }

      // Record function calls, especially those in hooks
      if (
        currentContext.inHook &&
        !['useEffect', 'useCallback', 'useMemo', 'useLayoutEffect'].includes(calleeName)
      ) {
        const args = extractArgumentNames(node.arguments);
        const passesStateSetters = args.filter((arg) => setterNames.includes(arg));

        // Resolve alias to original function name for cross-file lookup
        const resolvedFunctionName = resolveAlias(calleeName, aliasMap);

        calls.push({
          functionName: resolvedFunctionName,
          file: fileName,
          line: node.loc?.start.line || 0,
          arguments: args,
          inHookBody: true,
          hookType: currentContext.hookType,
          passesStateSetters,
          hookStartLine: currentContext.hookStartLine, // Add hook start line for consistency
        });
      }
    }

    // Recursively visit all properties with context
    const indexableNode = node as unknown as IndexableNode;
    Object.keys(node).forEach((key) => {
      const value = indexableNode[key];
      if (Array.isArray(value)) {
        value.forEach((child) => visitNode(child as t.Node | null | undefined, currentContext));
      } else if (value && typeof value === 'object' && (value as { type?: string }).type) {
        visitNode(value as t.Node, currentContext);
      }
    });
  }

  visitNode(ast);
  return calls;
}

function extractArgumentNames(
  args: Array<t.Expression | t.SpreadElement | t.ArgumentPlaceholder>
): string[] {
  return args
    .map((arg) => {
      if (t.isIdentifier(arg)) {
        return arg.name;
      } else if (
        t.isMemberExpression(arg) &&
        t.isIdentifier(arg.object) &&
        t.isIdentifier(arg.property)
      ) {
        return `${arg.object.name}.${arg.property.name}`;
      } else {
        return 'unknown';
      }
    })
    .filter((name) => name !== 'unknown');
}

interface NodeWithParent {
  type: string;
  parent?: NodeWithParent;
}

function isNodeExported(parent?: t.Node | null): boolean {
  if (!parent) return false;

  // Check various export patterns
  if (parent.type === 'ExportNamedDeclaration' || parent.type === 'ExportDefaultDeclaration') {
    return true;
  }

  if (parent.type === 'VariableDeclaration') {
    const parentWithParent = parent as unknown as NodeWithParent;
    if (
      parentWithParent.parent?.type === 'ExportNamedDeclaration' ||
      parentWithParent.parent?.type === 'ExportDefaultDeclaration'
    ) {
      return true;
    }
  }

  return false;
}

function traceFunctionCallFlows(
  functions: Map<string, FunctionDefinition>,
  calls: FunctionCall[]
): Map<string, string[]> {
  const flows = new Map<string, string[]>();

  // For each hook call that passes state setters to functions
  calls.forEach((call) => {
    if (call.inHookBody && call.passesStateSetters.length > 0) {
      // Use hook start line for consistent hookId matching with intelligent analyzer
      const hookLine = call.hookStartLine || call.line;
      const hookId = `${call.file}:${hookLine}:${call.hookType}`;

      // Trace what this function call eventually does
      const modifiedSetters = traceFunctionModifications(call.functionName, functions, new Set());

      if (modifiedSetters.length > 0) {
        flows.set(hookId, modifiedSetters);
      }
    }
  });
  return flows;
}

function traceFunctionModifications(
  functionName: string,
  functions: Map<string, FunctionDefinition>,
  visited: Set<string>
): string[] {
  // Prevent infinite recursion
  if (visited.has(functionName)) {
    return [];
  }
  visited.add(functionName);

  // Try to find function by name only (for exported functions)
  let func = functions.get(functionName);

  // If not found by name only, try finding by file@name pattern
  if (!func) {
    for (const [key, definition] of functions.entries()) {
      if (key.includes('@') && key.split('@')[0] === functionName) {
        func = definition;
        break;
      }
    }
  }

  if (!func) {
    return []; // Function not found in our analysis
  }

  const modifications: string[] = [];

  // Direct state modifications
  modifications.push(...func.callsStateSetters);

  // Indirect modifications through other function calls
  func.callsFunctions.forEach((calledFunc) => {
    const indirectMods = traceFunctionModifications(calledFunc, functions, new Set(visited));
    modifications.push(...indirectMods);
  });

  return [...new Set(modifications)]; // Remove duplicates
}
