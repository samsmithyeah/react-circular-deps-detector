import * as t from '@babel/types';
import traverse, { NodePath } from '@babel/traverse';
import * as fs from 'fs';
import * as path from 'path';
import { ParsedFile, parseFile } from './parser';
import { analyzeCrossFileRelations, CrossFileAnalysis } from './cross-file-analyzer';
import { createPathResolver, PathResolver } from './path-resolver';

interface HookNodeInfo {
  node: t.CallExpression;
  hookName: string;
  line: number;
}

/**
 * Error codes for categorizing issues.
 * - RLD-1XX: Critical issues that will crash the browser (synchronous/render-phase loops)
 * - RLD-2XX: Critical issues from effect loops (useEffect/useLayoutEffect)
 * - RLD-3XX: Warning-level cross-file risks
 * - RLD-4XX: Performance issues (unstable references)
 * - RLD-5XX: Performance issues (missing dependencies)
 * - RLD-6XX: Ref mutation issues
 */
export type ErrorCode =
  | 'RLD-100' // Render phase setState (synchronous loop)
  | 'RLD-101' // Render phase setState via function call
  | 'RLD-200' // useEffect unconditional setState loop
  | 'RLD-201' // useEffect missing deps with setState
  | 'RLD-202' // useLayoutEffect unconditional setState loop
  | 'RLD-300' // Cross-file loop risk
  | 'RLD-301' // Cross-file conditional modification
  | 'RLD-400' // Unstable object reference in deps
  | 'RLD-401' // Unstable array reference in deps
  | 'RLD-402' // Unstable function reference in deps
  | 'RLD-403' // Unstable function call result in deps
  | 'RLD-410' // Object spread guard risk
  | 'RLD-420' // useCallback/useMemo modifies dependency (no direct loop but review)
  | 'RLD-500' // useEffect missing dependency array
  | 'RLD-501' // Conditional modification needs review
  | 'RLD-600'; // Ref mutation with state value (stale closure risk)

/**
 * Issue categories for filtering and display.
 * - critical: Will crash the browser (infinite loops)
 * - warning: May cause logic bugs or race conditions
 * - performance: Causes unnecessary re-renders (lag)
 * - safe: Safe pattern (informational only)
 */
export type IssueCategory = 'critical' | 'warning' | 'performance' | 'safe';

/** Debug information about why a decision was made */
export interface DebugInfo {
  /** Why this issue was flagged */
  reason: string;
  /** State tracking information */
  stateTracking?: {
    declaredStateVars: string[];
    setterFunctions: string[];
    stableVariables: string[];
    unstableVariables: string[];
  };
  /** Dependency analysis */
  dependencyAnalysis?: {
    rawDependencies: string[];
    problematicDeps: string[];
    safeDeps: string[];
  };
  /** Guard detection */
  guardInfo?: {
    hasGuard: boolean;
    guardType?: string;
    guardVariable?: string;
  };
  /** Deferred modification detection */
  deferredInfo?: {
    isDeferred: boolean;
    deferredContext?: string;
  };
  /** Cross-file analysis */
  crossFileInfo?: {
    analyzedImports: string[];
    foundStateModifications: string[];
  };
}

export interface IntelligentHookAnalysis {
  type: 'confirmed-infinite-loop' | 'potential-issue' | 'safe-pattern';
  /** Stable error code for filtering and ignoring specific issue types */
  errorCode: ErrorCode;
  /** Issue category for grouping and filtering */
  category: IssueCategory;
  description: string;
  file: string;
  line: number;
  column?: number;
  hookType: string;
  functionName?: string;
  problematicDependency: string;
  stateVariable?: string;
  setterFunction?: string;
  severity: 'high' | 'medium' | 'low';
  confidence: 'high' | 'medium' | 'low';
  explanation: string;
  actualStateModifications: string[];
  stateReads: string[];
  /** Debug information (only populated when debug mode is enabled) */
  debugInfo?: DebugInfo;
}

/** Information about a local variable that may be recreated on each render */
interface UnstableVariable {
  name: string;
  type: 'object' | 'array' | 'function' | 'function-call';
  line: number;
  /** True if wrapped in useMemo/useCallback/useRef */
  isMemoized: boolean;
  /** True if defined at module level (outside component) */
  isModuleLevel: boolean;
}

interface StateInteraction {
  reads: string[];
  modifications: string[];
  conditionalModifications: string[];
  functionalUpdates: string[];
  /** Modifications inside async callbacks (setInterval, onSnapshot, setTimeout, etc.) - these are deferred and don't cause immediate loops */
  deferredModifications: string[];
  // Enhanced: track guarded modifications with their guard info
  guardedModifications: GuardedModification[];
  // Track functions passed as references (not invoked) - e.g., addEventListener('click', handleClick)
  functionReferences: FunctionReference[];
  /** Track ref.current mutations - e.g., ref.current = value */
  refMutations: RefMutation[];
}

interface RefMutation {
  refName: string;
  /** The value being assigned (if it's an identifier) */
  assignedValue?: string;
  /** Whether the mutation uses a state variable */
  usesStateValue: boolean;
  /** Line number of the mutation */
  line: number;
}

interface FunctionReference {
  functionName: string;
  context: 'event-listener' | 'callback-arg' | 'unknown';
  // The function that receives this reference (e.g., 'addEventListener', 'setTimeout')
  receivingFunction: string;
}

interface GuardedModification {
  setter: string;
  stateVariable: string;
  guardType: 'toggle-guard' | 'equality-guard' | 'early-return' | 'object-spread-risk' | 'unknown';
  isSafe: boolean;
  /** Warning message for risky but not definitely unsafe patterns */
  warning?: string;
}

function expandToIncludeImportedFiles(parsedFiles: ParsedFile[]): ParsedFile[] {
  const allFiles = [...parsedFiles];
  const processedPaths = new Set(parsedFiles.map((f) => f.file));

  // Find project root for path resolution
  const projectRoot = findProjectRoot(parsedFiles);
  const pathResolver = projectRoot ? createPathResolver({ projectRoot }) : null;

  // Extract imports from React files and try to include utility files
  for (const file of parsedFiles) {
    const imports = extractImportPaths(file.file, pathResolver);

    for (const importPath of imports) {
      if (!processedPaths.has(importPath)) {
        try {
          const parsed = parseFile(importPath);
          allFiles.push(parsed);
          processedPaths.add(importPath);
        } catch {
          // Silently skip files that can't be parsed
        }
      }
    }
  }

  return allFiles;
}

/**
 * Find project root by looking for tsconfig.json or package.json
 */
function findProjectRoot(parsedFiles: ParsedFile[]): string | null {
  if (parsedFiles.length === 0) return null;

  // Start from the first file's directory
  let dir = path.dirname(parsedFiles[0].file);
  const root = path.parse(dir).root;

  while (dir !== root) {
    const tsconfigPath = path.join(dir, 'tsconfig.json');
    const jsconfigPath = path.join(dir, 'jsconfig.json');
    const packagePath = path.join(dir, 'package.json');

    if (fs.existsSync(tsconfigPath) || fs.existsSync(jsconfigPath) || fs.existsSync(packagePath)) {
      return dir;
    }

    dir = path.dirname(dir);
  }

  return null;
}

function extractImportPaths(filePath: string, pathResolver: PathResolver | null): string[] {
  const imports: string[] = [];

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const babel = require('@babel/parser');

    const ast = babel.parse(content, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
    });

    traverse(ast, {
      ImportDeclaration(nodePath: NodePath<t.ImportDeclaration>) {
        const importPath = nodePath.node.source.value;

        // Skip node_modules imports (but not path aliases)
        if (
          !importPath.startsWith('.') &&
          !importPath.startsWith('@/') &&
          !importPath.startsWith('~/')
        ) {
          // Check if it's a scoped package like @types/react
          if (importPath.startsWith('@') && importPath.includes('/')) {
            const parts = importPath.split('/');
            // Scoped packages have format @org/pkg
            if (!parts[0].endsWith('/')) {
              return; // Skip node module
            }
          } else if (!pathResolver?.canResolve(importPath)) {
            return; // Skip - likely a node module
          }
        }

        // Try to resolve the import
        let resolvedPath: string | null = null;

        // First try the path resolver (handles aliases)
        if (pathResolver && pathResolver.canResolve(importPath)) {
          resolvedPath = pathResolver.resolve(filePath, importPath);
        }

        // Fallback to relative import resolution
        if (!resolvedPath && (importPath.startsWith('./') || importPath.startsWith('../'))) {
          resolvedPath = resolveImportPath(filePath, importPath);
        }

        if (resolvedPath) {
          imports.push(resolvedPath);
        }
      },
    });
  } catch {
    // Ignore parsing errors
  }

  return imports;
}

function resolveImportPath(fromFile: string, importPath: string): string | null {
  const basePath = path.dirname(fromFile);
  const extensions = ['.ts', '.tsx', '.js', '.jsx'];

  for (const ext of extensions) {
    const fullPath = path.resolve(basePath, importPath + ext);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }

  // Try with index files
  for (const ext of extensions) {
    const indexPath = path.resolve(basePath, importPath, 'index' + ext);
    if (fs.existsSync(indexPath)) {
      return indexPath;
    }
  }

  return null;
}

/**
 * Detect setState calls during render phase (outside hooks, event handlers, callbacks).
 * This is a guaranteed infinite loop pattern.
 *
 * Pattern detected:
 * ```
 * function Component() {
 *   const [count, setCount] = useState(0);
 *   setCount(count + 1); // BUG: runs during render!
 *   return <div>{count}</div>;
 * }
 * ```
 */
function detectSetStateDuringRender(
  ast: t.Node,
  stateInfo: Map<string, string>,
  filePath: string,
  fileContent?: string
): IntelligentHookAnalysis[] {
  const results: IntelligentHookAnalysis[] = [];
  const setterNames = new Set(stateInfo.values());

  // Build reverse map: setter -> state variable
  const setterToState = new Map<string, string>();
  stateInfo.forEach((setter, state) => setterToState.set(setter, state));

  traverse(ast, {
    // Look for function declarations that look like React components (PascalCase)
    FunctionDeclaration(funcPath: NodePath<t.FunctionDeclaration>) {
      const funcName = funcPath.node.id?.name;
      if (!funcName || !/^[A-Z]/.test(funcName)) return; // Not a component

      checkComponentBodyForSetState(
        funcPath,
        setterNames,
        setterToState,
        filePath,
        fileContent,
        results
      );
    },

    // Arrow function components: const MyComponent = () => { ... }
    VariableDeclarator(varPath: NodePath<t.VariableDeclarator>) {
      if (!t.isIdentifier(varPath.node.id)) return;
      const varName = varPath.node.id.name;
      if (!/^[A-Z]/.test(varName)) return; // Not a component

      const init = varPath.node.init;
      if (!t.isArrowFunctionExpression(init) && !t.isFunctionExpression(init)) return;

      // Get the path to the arrow/function expression
      const funcPath = varPath.get('init') as NodePath<
        t.ArrowFunctionExpression | t.FunctionExpression
      >;
      checkComponentBodyForSetState(
        funcPath,
        setterNames,
        setterToState,
        filePath,
        fileContent,
        results
      );
    },
  });

  return results;
}

/**
 * Check a component's function body for setState calls that happen during render.
 */
function checkComponentBodyForSetState(
  funcPath: NodePath<t.FunctionDeclaration | t.ArrowFunctionExpression | t.FunctionExpression>,
  setterNames: Set<string>,
  setterToState: Map<string, string>,
  filePath: string,
  fileContent: string | undefined,
  results: IntelligentHookAnalysis[]
): void {
  const body = funcPath.node.body;
  if (!t.isBlockStatement(body)) return; // Arrow function with expression body

  // Find all setState calls in the component body that are NOT inside:
  // - useEffect, useCallback, useMemo, useLayoutEffect callbacks
  // - event handlers (arrow functions or function expressions assigned to variables)
  // - nested functions

  funcPath.traverse({
    CallExpression(callPath: NodePath<t.CallExpression>) {
      if (!t.isIdentifier(callPath.node.callee)) return;
      const calleeName = callPath.node.callee.name;

      if (!setterNames.has(calleeName)) return;

      // Check if this call is inside a safe context (hook callback, event handler, nested function)
      if (isInsideSafeContext(callPath)) return;

      const line = callPath.node.loc?.start.line || 0;

      // Check for ignore comments
      if (fileContent && isHookIgnored(fileContent, line)) return;

      const stateVar = setterToState.get(calleeName) || calleeName;

      results.push(
        createAnalysis({
          type: 'confirmed-infinite-loop',
          errorCode: 'RLD-100',
          category: 'critical',
          severity: 'high',
          confidence: 'high',
          hookType: 'render',
          line,
          column: callPath.node.loc?.start.column,
          file: filePath,
          problematicDependency: stateVar,
          stateVariable: stateVar,
          setterFunction: calleeName,
          actualStateModifications: [calleeName],
          stateReads: [],
          explanation:
            `'${calleeName}()' is called directly during render (in the component body). ` +
            `This causes an infinite loop because each setState triggers a re-render, which calls setState again. ` +
            `Fix: move the setState call into a useEffect, event handler, or callback.`,
        })
      );
    },
  });
}

/**
 * Check if a CallExpression is inside a safe context where setState won't cause render loops.
 * Safe contexts include:
 * - Inside useEffect, useCallback, useMemo, useLayoutEffect callbacks
 * - Inside arrow functions or function expressions (event handlers, callbacks)
 * - Inside nested function declarations (but NOT the component function itself)
 */
function isInsideSafeContext(callPath: NodePath<t.CallExpression>): boolean {
  let current: NodePath | null = callPath.parentPath;

  while (current) {
    const node = current.node;

    // Check if we're inside a function (arrow or regular)
    if (t.isArrowFunctionExpression(node) || t.isFunctionExpression(node)) {
      // If we're inside an arrow/function expression, it's a safe context
      // (event handler, callback, hook callback, etc.)
      // BUT we need to check if this is the component itself (arrow function component)
      const parent = current.parentPath;
      if (
        parent &&
        t.isVariableDeclarator(parent.node) &&
        t.isIdentifier(parent.node.id) &&
        /^[A-Z]/.test(parent.node.id.name)
      ) {
        // This is the component function itself (arrow function component)
        // e.g., const MyComponent = () => { ... }
        return false;
      }

      // Otherwise it's a nested function - safe context
      return true;
    }

    // Check if we're inside a regular function declaration
    if (t.isFunctionDeclaration(node)) {
      // Check if this is the component function itself
      const funcName = node.id?.name;
      if (funcName && /^[A-Z]/.test(funcName)) {
        // This is the component function itself - NOT safe
        // We've reached the boundary
        return false;
      }

      // It's a nested function - safe context
      return true;
    }

    current = current.parentPath;
  }

  return false;
}

/**
 * Detect useEffect calls without a dependency array that contain setState.
 * This is a guaranteed infinite loop pattern.
 *
 * Pattern detected:
 * ```
 * useEffect(() => {
 *   setCount(c => c + 1);
 * }); // Missing dependency array!
 * ```
 *
 * Also detects indirect patterns:
 * ```
 * const fetchData = () => { setData(x); };
 * useEffect(() => {
 *   fetchData(); // calls function that eventually calls setState
 * });
 * ```
 */
function detectUseEffectWithoutDeps(
  ast: t.Node,
  stateInfo: Map<string, string>,
  filePath: string,
  fileContent?: string
): IntelligentHookAnalysis[] {
  const results: IntelligentHookAnalysis[] = [];
  const setterNames = new Set(stateInfo.values());

  // Build reverse map: setter -> state variable
  const setterToState = new Map<string, string>();
  stateInfo.forEach((setter, state) => setterToState.set(setter, state));

  // First pass: find local functions that call state setters (directly or indirectly)
  const functionsCallingSetters = new Map<string, string[]>(); // function name -> setters it calls

  traverse(ast, {
    // Track arrow function assignments: const fetchData = () => { setData(...) }
    VariableDeclarator(varPath: NodePath<t.VariableDeclarator>) {
      if (!t.isIdentifier(varPath.node.id)) return;
      const funcName = varPath.node.id.name;
      const init = varPath.node.init;

      if (!t.isArrowFunctionExpression(init) && !t.isFunctionExpression(init)) return;

      // Check if this function calls any setters (directly or passes them as callbacks)
      const settersCalled: string[] = [];
      const funcPath = varPath.get('init') as NodePath<
        t.ArrowFunctionExpression | t.FunctionExpression
      >;
      funcPath.traverse({
        CallExpression(innerCallPath: NodePath<t.CallExpression>) {
          // Check for direct calls: setData(x)
          if (t.isIdentifier(innerCallPath.node.callee)) {
            const calleeName = innerCallPath.node.callee.name;
            if (setterNames.has(calleeName)) {
              settersCalled.push(calleeName);
            }
          }

          // Check for setters passed as arguments: .then(setData)
          for (const arg of innerCallPath.node.arguments || []) {
            if (t.isIdentifier(arg) && setterNames.has(arg.name)) {
              settersCalled.push(arg.name);
            }
          }
        },
      });

      if (settersCalled.length > 0) {
        functionsCallingSetters.set(funcName, settersCalled);
      }
    },

    // Track function declarations: function fetchData() { setData(...) }
    FunctionDeclaration(funcPath: NodePath<t.FunctionDeclaration>) {
      const funcName = funcPath.node.id?.name;
      if (!funcName) return;

      // Skip component functions (PascalCase)
      if (/^[A-Z]/.test(funcName)) return;

      const settersCalled: string[] = [];
      funcPath.traverse({
        CallExpression(innerCallPath: NodePath<t.CallExpression>) {
          // Check for direct calls: setData(x)
          if (t.isIdentifier(innerCallPath.node.callee)) {
            const calleeName = innerCallPath.node.callee.name;
            if (setterNames.has(calleeName)) {
              settersCalled.push(calleeName);
            }
          }

          // Check for setters passed as arguments: .then(setData)
          for (const arg of innerCallPath.node.arguments || []) {
            if (t.isIdentifier(arg) && setterNames.has(arg.name)) {
              settersCalled.push(arg.name);
            }
          }
        },
      });

      if (settersCalled.length > 0) {
        functionsCallingSetters.set(funcName, settersCalled);
      }
    },
  });

  // Second pass: find useEffect without deps
  traverse(ast, {
    CallExpression(callPath: NodePath<t.CallExpression>) {
      if (!t.isIdentifier(callPath.node.callee)) return;
      const hookName = callPath.node.callee.name;

      // Only check useEffect and useLayoutEffect
      if (hookName !== 'useEffect' && hookName !== 'useLayoutEffect') return;

      const args = callPath.node.arguments;

      // Check if there's no dependency array (only 1 argument - the callback)
      if (args.length !== 1) return;

      const callback = args[0];
      if (!t.isArrowFunctionExpression(callback) && !t.isFunctionExpression(callback)) return;

      const line = callPath.node.loc?.start.line || 0;

      // Check for ignore comments
      if (fileContent && isHookIgnored(fileContent, line)) return;

      // Check if the callback contains any setState calls (direct or indirect)
      const setterCallsInCallback: string[] = [];
      const functionCallsInCallback: string[] = [];

      const callbackPath = callPath.get('arguments.0') as NodePath<
        t.ArrowFunctionExpression | t.FunctionExpression
      >;
      callbackPath.traverse({
        CallExpression(innerCallPath: NodePath<t.CallExpression>) {
          if (!t.isIdentifier(innerCallPath.node.callee)) return;
          const calleeName = innerCallPath.node.callee.name;

          // Direct setter call
          if (setterNames.has(calleeName)) {
            setterCallsInCallback.push(calleeName);
          }

          // Function call that might lead to setter
          if (functionsCallingSetters.has(calleeName)) {
            functionCallsInCallback.push(calleeName);
            const indirectSetters = functionsCallingSetters.get(calleeName) || [];
            setterCallsInCallback.push(...indirectSetters);
          }
        },
      });

      if (setterCallsInCallback.length > 0) {
        const firstSetter = setterCallsInCallback[0];
        const stateVar = setterToState.get(firstSetter) || firstSetter;
        const isIndirect = functionCallsInCallback.length > 0;

        results.push(
          createAnalysis({
            type: 'confirmed-infinite-loop',
            errorCode: 'RLD-201',
            category: 'critical',
            severity: 'high',
            confidence: isIndirect ? 'medium' : 'high',
            hookType: hookName,
            line,
            file: filePath,
            problematicDependency: 'missing-deps',
            stateVariable: stateVar,
            setterFunction: firstSetter,
            actualStateModifications: setterCallsInCallback,
            stateReads: [],
            explanation: isIndirect
              ? `${hookName} has no dependency array, so it runs after every render. ` +
                `It calls '${functionCallsInCallback[0]}()' which calls '${firstSetter}()', triggering re-renders. ` +
                `Fix: add a dependency array (e.g., [] for run-once, or [dep1, dep2] for specific dependencies).`
              : `${hookName} has no dependency array, so it runs after every render. ` +
                `It calls '${firstSetter}()' which triggers a re-render, causing an infinite loop. ` +
                `Fix: add a dependency array (e.g., [] for run-once, or [dep1, dep2] for specific dependencies).`,
          })
        );
      }
    },
  });

  return results;
}

/** Options for intelligent hooks analysis */
export interface AnalyzerOptions {
  /** Hooks known to return stable references */
  stableHooks?: string[];
  /** Hooks known to return unstable references */
  unstableHooks?: string[];
  /** Custom function stability settings */
  customFunctions?: Record<
    string,
    {
      stable?: boolean;
      deferred?: boolean;
    }
  >;
  /** Enable debug mode to collect detailed decision information */
  debug?: boolean;
}

/**
 * Module-level options storage for helper functions.
 *
 * Note: This is intentional - the analyzer runs synchronously in a single thread,
 * and options are reset at the start of each analyzeHooksIntelligently() call.
 * While passing options through the call chain would be more pure, the current
 * approach avoids threading options through 10+ function calls for a simple
 * config lookup. The tradeoff is acceptable since the analyzer is not concurrent.
 */
let currentOptions: AnalyzerOptions = {};

export function analyzeHooksIntelligently(
  parsedFiles: ParsedFile[],
  options: AnalyzerOptions = {}
): IntelligentHookAnalysis[] {
  const results: IntelligentHookAnalysis[] = [];

  // Store options for helper functions
  currentOptions = options;

  // First, build cross-file analysis including imported utilities
  // Only show progress if not in test mode and not generating JSON output
  if (process.env.NODE_ENV !== 'test' && !process.argv.includes('--json')) {
    console.log('Building cross-file function call graph...');
  }
  const allFiles = expandToIncludeImportedFiles(parsedFiles);
  const crossFileAnalysis = analyzeCrossFileRelations(allFiles);

  for (const file of parsedFiles) {
    try {
      const fileResults = analyzeFileIntelligently(file, crossFileAnalysis);
      results.push(...fileResults);
    } catch (error) {
      console.warn(`Could not analyze hooks intelligently in ${file.file}:`, error);
    }
  }

  return results;
}

/**
 * Check if a hook is configured as stable via options
 */
export function isConfiguredStableHook(hookName: string): boolean {
  return currentOptions.stableHooks?.includes(hookName) ?? false;
}

/**
 * Check if a hook is configured as unstable via options
 */
export function isConfiguredUnstableHook(hookName: string): boolean {
  return currentOptions.unstableHooks?.includes(hookName) ?? false;
}

/**
 * Check if a function is configured as stable via options
 * Reserved for future use when customFunctions config is fully integrated
 */
export function isConfiguredStableFunction(functionName: string): boolean {
  return currentOptions.customFunctions?.[functionName]?.stable ?? false;
}

/**
 * Check if a function is configured as deferred (async) via options
 * Reserved for future use when customFunctions config is fully integrated
 */
export function isConfiguredDeferredFunction(functionName: string): boolean {
  return currentOptions.customFunctions?.[functionName]?.deferred ?? false;
}

function analyzeFileIntelligently(
  file: ParsedFile,
  crossFileAnalysis: CrossFileAnalysis
): IntelligentHookAnalysis[] {
  const results: IntelligentHookAnalysis[] = [];

  try {
    // Use the cached AST from ParsedFile instead of re-parsing
    const ast = file.ast;

    // Extract state variables, their setters, and ref variables
    const { stateVariables: stateInfo, refVariables: refVars } = extractStateInfo(ast);

    // Extract unstable local variables (objects, arrays, functions created in component body)
    const unstableVars = extractUnstableVariables(ast);

    // Check for setState during render (outside hooks/event handlers)
    const renderStateIssues = detectSetStateDuringRender(ast, stateInfo, file.file, file.content);
    results.push(...renderStateIssues);

    // Check for useEffect without dependency array
    const noDepsIssues = detectUseEffectWithoutDeps(ast, stateInfo, file.file, file.content);
    results.push(...noDepsIssues);

    // Analyze each hook
    const hookNodes = findHookNodes(ast);

    for (const hookNode of hookNodes) {
      // First check for unstable reference issues
      const unstableRefIssue = checkUnstableReferences(
        hookNode,
        unstableVars,
        stateInfo,
        file.file,
        file.content
      );
      if (unstableRefIssue) {
        results.push(unstableRefIssue);
        continue; // Don't double-report the same hook
      }

      const analysis = analyzeHookNode(
        hookNode,
        stateInfo,
        file.file,
        crossFileAnalysis,
        file.content,
        refVars
      );
      if (analysis) {
        results.push(analysis);
      }
    }
  } catch (error) {
    console.warn(`Could not parse ${file.file} for intelligent analysis:`, error);
  }

  return results;
}

interface StateAndRefInfo {
  stateVariables: Map<string, string>; // state var -> setter name
  refVariables: Set<string>; // ref variable names
}

function extractStateInfo(ast: t.Node): StateAndRefInfo {
  const stateVariables = new Map<string, string>(); // state var -> setter name
  const refVariables = new Set<string>(); // ref variable names

  traverse(ast, {
    VariableDeclarator(nodePath: NodePath<t.VariableDeclarator>) {
      // Extract useRef patterns: const myRef = useRef(...)
      if (
        t.isIdentifier(nodePath.node.id) &&
        t.isCallExpression(nodePath.node.init) &&
        t.isIdentifier(nodePath.node.init.callee) &&
        nodePath.node.init.callee.name === 'useRef'
      ) {
        refVariables.add(nodePath.node.id.name);
      }
      // Extract useState/useReducer patterns: const [state, setState] = useState(...)
      // or const [state, dispatch] = useReducer(...)
      if (
        t.isArrayPattern(nodePath.node.id) &&
        t.isCallExpression(nodePath.node.init) &&
        t.isIdentifier(nodePath.node.init.callee) &&
        (nodePath.node.init.callee.name === 'useState' ||
          nodePath.node.init.callee.name === 'useReducer')
      ) {
        const elements = nodePath.node.id.elements;
        if (elements.length >= 2 && t.isIdentifier(elements[0]) && t.isIdentifier(elements[1])) {
          const stateVar = elements[0].name;
          const setter = elements[1].name;
          stateVariables.set(stateVar, setter);
        }
      }

      // Extract custom hook patterns: const [state, setState] = useCustomHook(...)
      // Custom hooks start with 'use' and return array destructuring
      if (
        t.isArrayPattern(nodePath.node.id) &&
        t.isCallExpression(nodePath.node.init) &&
        t.isIdentifier(nodePath.node.init.callee) &&
        nodePath.node.init.callee.name.startsWith('use') &&
        nodePath.node.init.callee.name !== 'useState'
      ) {
        const elements = nodePath.node.id.elements;
        if (elements.length >= 2 && t.isIdentifier(elements[0]) && t.isIdentifier(elements[1])) {
          const firstElement = elements[0].name;
          const secondElement = elements[1].name;

          // Check if second element looks like a setter (starts with 'set' + uppercase)
          if (
            secondElement.startsWith('set') &&
            secondElement.length > 3 &&
            secondElement[3] === secondElement[3].toUpperCase()
          ) {
            stateVariables.set(firstElement, secondElement);
          }
        }
      }

      // Extract useContext patterns: const { data, setData } = useContext(MyContext)
      if (
        t.isObjectPattern(nodePath.node.id) &&
        t.isCallExpression(nodePath.node.init) &&
        t.isIdentifier(nodePath.node.init.callee) &&
        nodePath.node.init.callee.name === 'useContext'
      ) {
        const properties = nodePath.node.id.properties;
        const extractedNames: string[] = [];

        // First pass: collect all destructured names
        for (const prop of properties) {
          if (t.isObjectProperty(prop) && t.isIdentifier(prop.value)) {
            extractedNames.push(prop.value.name);
          } else if (t.isObjectProperty(prop) && t.isIdentifier(prop.key)) {
            extractedNames.push(prop.key.name);
          }
        }

        // Second pass: match setters with state variables
        for (const name of extractedNames) {
          // Check if this is a setter (starts with 'set' + uppercase)
          if (name.startsWith('set') && name.length > 3 && name[3] === name[3].toUpperCase()) {
            // Try to find corresponding state variable
            const stateVar = name.charAt(3).toLowerCase() + name.slice(4);
            if (extractedNames.includes(stateVar)) {
              stateVariables.set(stateVar, name);
            }
          }
        }
      }
    },
  });

  return { stateVariables, refVariables };
}

/** Function calls that return stable/primitive values */
const STABLE_FUNCTION_CALLS = new Set([
  'require',
  'String',
  'Number',
  'Boolean',
  'parseInt',
  'parseFloat',
]);

/**
 * Method calls that return primitive values (string, number, boolean).
 * Primitives are compared by value, not reference, so they're stable.
 */
const PRIMITIVE_RETURNING_METHODS = new Set([
  // String methods
  'join',
  'toString',
  'toLocaleString',
  'valueOf',
  'charAt',
  'charCodeAt',
  'codePointAt',
  'substring',
  'substr',
  'slice',
  'trim',
  'trimStart',
  'trimEnd',
  'toLowerCase',
  'toUpperCase',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'normalize',
  'padStart',
  'padEnd',
  'repeat',
  'replace',
  'replaceAll',
  // Number methods
  'toFixed',
  'toExponential',
  'toPrecision',
  // Array methods that return primitives
  'indexOf',
  'lastIndexOf',
  'length', // Not a method but included for member expressions
  // Boolean checks
  'includes',
  'startsWith',
  'endsWith',
  'every',
  'some',
  // Reduce can return primitives (commonly does)
  // Note: We'll be conservative here - reduce CAN return objects
]);

/**
 * Static methods on built-in objects that return primitives.
 */
const PRIMITIVE_RETURNING_STATIC_METHODS: Record<string, Set<string>> = {
  Math: new Set([
    'abs',
    'acos',
    'acosh',
    'asin',
    'asinh',
    'atan',
    'atan2',
    'atanh',
    'cbrt',
    'ceil',
    'clz32',
    'cos',
    'cosh',
    'exp',
    'expm1',
    'floor',
    'fround',
    'hypot',
    'imul',
    'log',
    'log10',
    'log1p',
    'log2',
    'max',
    'min',
    'pow',
    'random',
    'round',
    'sign',
    'sin',
    'sinh',
    'sqrt',
    'tan',
    'tanh',
    'trunc',
  ]),
  Number: new Set(['isFinite', 'isInteger', 'isNaN', 'isSafeInteger', 'parseFloat', 'parseInt']),
  String: new Set(['fromCharCode', 'fromCodePoint']),
  Object: new Set(['is', 'hasOwn']),
  Array: new Set(['isArray']),
  Date: new Set(['now', 'parse', 'UTC']),
  JSON: new Set(['stringify']), // Returns string
};

/**
 * React hooks that are guaranteed to return stable values/references.
 * Note: useState and useReducer return tuples where the setter/dispatch is stable,
 * but we handle those via destructuring patterns separately.
 * Custom hooks (any other `use*` function) are NOT assumed stable since they
 * can return new objects or arrays on every render.
 */
const STABLE_REACT_HOOKS = new Set([
  'useRef', // Returns stable ref object
  'useId', // Returns stable string ID
]);

/**
 * Check if a CallExpression is a stable function call (returns primitive or stable value)
 */
function isStableFunctionCall(init: t.CallExpression): boolean {
  const callee = init.callee;

  // Only specific React hooks are guaranteed to return stable references
  if (t.isIdentifier(callee) && STABLE_REACT_HOOKS.has(callee.name)) {
    return true;
  }

  // Known stable function calls
  if (t.isIdentifier(callee) && STABLE_FUNCTION_CALLS.has(callee.name)) {
    return true;
  }

  // Check for user-configured stable/unstable hooks first
  if (t.isIdentifier(callee)) {
    // If explicitly marked as unstable in config, return false
    if (isConfiguredUnstableHook(callee.name)) {
      return false;
    }
    // If explicitly marked as stable in config, return true
    if (isConfiguredStableHook(callee.name)) {
      return true;
    }
  }

  // Custom hooks (use* prefix) are treated as stable by default
  // Rationale: Most custom hooks in real apps either:
  // 1. Return values from state management (Zustand, Redux, etc.) - stable references
  // 2. Return primitives - stable by value
  // 3. Memoize their return values internally
  // Treating them as unstable causes too many false positives in practice.
  // If a custom hook genuinely returns new objects, users can still catch it
  // through other patterns (e.g., the hook's internal implementation).
  if (t.isIdentifier(callee) && callee.name.startsWith('use')) {
    return true;
  }

  // Check for method calls that return primitives (e.g., array.join(), string.slice())
  if (t.isMemberExpression(callee) && t.isIdentifier(callee.property)) {
    const methodName = callee.property.name;

    // Methods that return primitives (strings, numbers, booleans)
    if (PRIMITIVE_RETURNING_METHODS.has(methodName)) {
      return true;
    }

    // Check for static methods on built-in objects (e.g., Math.round(), Date.now())
    if (t.isIdentifier(callee.object)) {
      const objectName = callee.object.name;
      const staticMethods = PRIMITIVE_RETURNING_STATIC_METHODS[objectName];
      if (staticMethods?.has(methodName)) {
        return true;
      }
    }

    // Zustand/store pattern: store.getState() returns stable references
    // Pattern: useXxxStore.getState() or xxxStore.getState()
    if (methodName === 'getState') {
      return true;
    }
  }

  return false;
}

/**
 * Determine the appropriate type for an unstable variable based on its initializer
 */
function getUnstableVarType(init: t.Expression | null | undefined): UnstableVariable['type'] {
  if (t.isArrayExpression(init)) return 'array';
  if (t.isObjectExpression(init)) return 'object';
  if (t.isArrowFunctionExpression(init) || t.isFunctionExpression(init)) return 'function';
  return 'function-call';
}

/**
 * Recursively extract all identifier names from a destructuring pattern.
 * Handles nested patterns like: const { data: { user } } = obj
 * or: const [a, [b, c]] = arr
 */
function extractIdentifiersFromPattern(pattern: t.LVal): string[] {
  const identifiers: string[] = [];

  if (t.isIdentifier(pattern)) {
    identifiers.push(pattern.name);
  } else if (t.isArrayPattern(pattern)) {
    for (const element of pattern.elements) {
      if (element && t.isLVal(element)) {
        identifiers.push(...extractIdentifiersFromPattern(element));
      }
    }
  } else if (t.isObjectPattern(pattern)) {
    for (const prop of pattern.properties) {
      if (t.isObjectProperty(prop)) {
        // The value could be an identifier or another pattern
        identifiers.push(...extractIdentifiersFromPattern(prop.value as t.LVal));
      } else if (t.isRestElement(prop)) {
        identifiers.push(...extractIdentifiersFromPattern(prop.argument));
      }
    }
  } else if (t.isRestElement(pattern)) {
    identifiers.push(...extractIdentifiersFromPattern(pattern.argument));
  } else if (t.isAssignmentPattern(pattern)) {
    // Handle default values: const { a = 1 } = obj or const [a = 1] = arr
    identifiers.push(...extractIdentifiersFromPattern(pattern.left));
  }

  return identifiers;
}

/**
 * Check if an initializer is an unstable source and add all destructured identifiers
 * to the unstable variables map if so.
 */
function addUnstableDestructuredVariables(
  id: t.LVal,
  init: t.Expression | null | undefined,
  line: number,
  unstableVars: Map<string, UnstableVariable>
): void {
  if (!init) return;

  const isUnstableSource =
    (t.isCallExpression(init) && !isStableFunctionCall(init)) ||
    t.isArrayExpression(init) ||
    t.isObjectExpression(init);

  if (isUnstableSource) {
    const varType = getUnstableVarType(init);
    for (const name of extractIdentifiersFromPattern(id)) {
      unstableVars.set(name, {
        name,
        type: varType,
        line,
        isMemoized: false,
        isModuleLevel: false,
      });
    }
  }
}

/**
 * Extract local variables that are potentially unstable (recreated on each render).
 * This includes object literals, array literals, functions, and function call results
 * that are defined inside a component but not wrapped in useMemo/useCallback/useRef.
 */
function extractUnstableVariables(ast: t.Node): Map<string, UnstableVariable> {
  const unstableVars = new Map<string, UnstableVariable>();
  const memoizedVars = new Set<string>();
  const stateVars = new Set<string>();
  const refVars = new Set<string>();

  // Track which function scopes we're in
  let componentDepth = 0;
  const moduleLevelVars = new Set<string>();

  traverse(ast, {
    // Track function component boundaries
    FunctionDeclaration: {
      enter(nodePath: NodePath<t.FunctionDeclaration>) {
        // Check if this looks like a React component (PascalCase name)
        const name = nodePath.node.id?.name;
        if (name && /^[A-Z]/.test(name)) {
          componentDepth++;
        }
      },
      exit(nodePath: NodePath<t.FunctionDeclaration>) {
        const name = nodePath.node.id?.name;
        if (name && /^[A-Z]/.test(name)) {
          componentDepth--;
        }
      },
    },

    // Track arrow function components assigned to variables
    VariableDeclarator(nodePath: NodePath<t.VariableDeclarator>) {
      const id = nodePath.node.id;
      const init = nodePath.node.init;
      const line = nodePath.node.loc?.start.line || 0;

      // Handle array destructuring: const [a, b] = ... or const [a, [b, c]] = ...
      if (t.isArrayPattern(id)) {
        // Track array destructuring from useState/useReducer - these are stable
        if (
          t.isCallExpression(init) &&
          t.isIdentifier(init.callee) &&
          (init.callee.name === 'useState' || init.callee.name === 'useReducer')
        ) {
          // Use recursive extraction to handle all identifiers
          for (const name of extractIdentifiersFromPattern(id)) {
            stateVars.add(name);
          }
          return;
        }

        // Track custom hooks that follow the [state, setState] pattern
        // These are treated as state-like even though the hook itself isn't guaranteed stable
        if (
          t.isCallExpression(init) &&
          t.isIdentifier(init.callee) &&
          init.callee.name.startsWith('use') &&
          init.callee.name !== 'useState'
        ) {
          const elements = id.elements;
          if (elements.length >= 2 && t.isIdentifier(elements[0]) && t.isIdentifier(elements[1])) {
            const secondElement = elements[1].name;
            // If second element looks like a setter (starts with 'set' + uppercase),
            // treat this as a state pattern - the first element is managed state
            if (
              secondElement.startsWith('set') &&
              secondElement.length > 3 &&
              secondElement[3] === secondElement[3].toUpperCase()
            ) {
              for (const name of extractIdentifiersFromPattern(id)) {
                stateVars.add(name);
              }
              return;
            }
          }
        }

        // Skip stable function calls (React hooks, parseInt, etc.)
        if (t.isCallExpression(init) && isStableFunctionCall(init)) {
          return;
        }

        // Inside component: destructuring from unstable source
        if (componentDepth > 0) {
          addUnstableDestructuredVariables(id, init, line, unstableVars);
        }
        return;
      }

      // Handle object destructuring: const { a, b } = ... or const { data: { user } } = ...
      if (t.isObjectPattern(id)) {
        // Track useContext patterns with state/setter pairs: const { data, setData } = useContext(...)
        if (
          t.isCallExpression(init) &&
          t.isIdentifier(init.callee) &&
          init.callee.name === 'useContext'
        ) {
          // Use extractIdentifiersFromPattern to handle all destructuring cases including nested
          const extractedNames = extractIdentifiersFromPattern(id);

          // Mark state variables (those with matching setters) as stable
          for (const name of extractedNames) {
            if (name.startsWith('set') && name.length > 3 && name[3] === name[3].toUpperCase()) {
              const stateVar = name.charAt(3).toLowerCase() + name.slice(4);
              if (extractedNames.includes(stateVar)) {
                stateVars.add(stateVar);
                stateVars.add(name); // setter is also stable
              }
            }
          }
          return;
        }

        // Track object destructuring from any custom hook (use* prefix)
        // Custom hooks typically return stable values from state management (Zustand, Redux, etc.)
        // or memoized values. Treating them as unstable causes many false positives.
        if (
          t.isCallExpression(init) &&
          t.isIdentifier(init.callee) &&
          init.callee.name.startsWith('use')
        ) {
          // Mark all destructured values from custom hooks as stable
          for (const name of extractIdentifiersFromPattern(id)) {
            stateVars.add(name);
          }
          return;
        }

        // Skip stable function calls (React hooks, parseInt, etc.)
        if (t.isCallExpression(init) && isStableFunctionCall(init)) {
          return;
        }

        // Inside component: destructuring from unstable source
        if (componentDepth > 0) {
          addUnstableDestructuredVariables(id, init, line, unstableVars);
        }
        return;
      }

      // Simple identifier assignment: const x = ...
      if (!t.isIdentifier(id)) return;
      const varName = id.name;

      // Check if this is a useState/useReducer call - track state variables
      if (
        t.isCallExpression(init) &&
        t.isIdentifier(init.callee) &&
        (init.callee.name === 'useState' || init.callee.name === 'useReducer')
      ) {
        stateVars.add(varName);
        return;
      }

      // Check if this is a useRef call - refs are stable
      if (
        t.isCallExpression(init) &&
        t.isIdentifier(init.callee) &&
        init.callee.name === 'useRef'
      ) {
        refVars.add(varName);
        return;
      }

      // Check if this is a useMemo/useCallback call - memoized values are stable
      // Handles both `useCallback(...)` and `React.useCallback(...)`
      if (t.isCallExpression(init)) {
        const callee = init.callee;
        const isMemoHook =
          // Direct call: useCallback(...) or useMemo(...)
          (t.isIdentifier(callee) &&
            (callee.name === 'useMemo' || callee.name === 'useCallback')) ||
          // Namespaced call: React.useCallback(...) or React.useMemo(...)
          (t.isMemberExpression(callee) &&
            t.isIdentifier(callee.property) &&
            (callee.property.name === 'useMemo' || callee.property.name === 'useCallback'));

        if (isMemoHook) {
          memoizedVars.add(varName);
          return;
        }
      }

      // Track module-level variables (before any component function)
      if (componentDepth === 0) {
        moduleLevelVars.add(varName);
        return;
      }

      // Now check for unstable patterns inside components
      if (componentDepth > 0) {
        // Object literal: const obj = { ... }
        if (t.isObjectExpression(init)) {
          unstableVars.set(varName, {
            name: varName,
            type: 'object',
            line,
            isMemoized: false,
            isModuleLevel: false,
          });
        }
        // Array literal: const arr = [...]
        else if (t.isArrayExpression(init)) {
          unstableVars.set(varName, {
            name: varName,
            type: 'array',
            line,
            isMemoized: false,
            isModuleLevel: false,
          });
        }
        // Arrow function: const fn = () => ...
        else if (t.isArrowFunctionExpression(init)) {
          unstableVars.set(varName, {
            name: varName,
            type: 'function',
            line,
            isMemoized: false,
            isModuleLevel: false,
          });
        }
        // Function expression: const fn = function() ...
        else if (t.isFunctionExpression(init)) {
          unstableVars.set(varName, {
            name: varName,
            type: 'function',
            line,
            isMemoized: false,
            isModuleLevel: false,
          });
        }
        // Function call that likely returns new object/array: const config = createConfig()
        else if (t.isCallExpression(init)) {
          // Skip stable function calls (React hooks, parseInt, etc.)
          if (isStableFunctionCall(init)) {
            return;
          }
          // Other function calls may return new objects
          unstableVars.set(varName, {
            name: varName,
            type: 'function-call',
            line,
            isMemoized: false,
            isModuleLevel: false,
          });
        }
      }
    },

    // Track arrow function components
    ArrowFunctionExpression: {
      enter(nodePath: NodePath<t.ArrowFunctionExpression>) {
        // Check if parent is a variable declarator with PascalCase name
        const parent = nodePath.parent;
        if (
          t.isVariableDeclarator(parent) &&
          t.isIdentifier(parent.id) &&
          /^[A-Z]/.test(parent.id.name)
        ) {
          componentDepth++;
        }
      },
      exit(nodePath: NodePath<t.ArrowFunctionExpression>) {
        const parent = nodePath.parent;
        if (
          t.isVariableDeclarator(parent) &&
          t.isIdentifier(parent.id) &&
          /^[A-Z]/.test(parent.id.name)
        ) {
          componentDepth--;
        }
      },
    },

    // Track function expression components: const MyComponent = function() { ... }
    FunctionExpression: {
      enter(nodePath: NodePath<t.FunctionExpression>) {
        // Check if parent is a variable declarator with PascalCase name
        const parent = nodePath.parent;
        if (
          t.isVariableDeclarator(parent) &&
          t.isIdentifier(parent.id) &&
          /^[A-Z]/.test(parent.id.name)
        ) {
          componentDepth++;
        }
      },
      exit(nodePath: NodePath<t.FunctionExpression>) {
        const parent = nodePath.parent;
        if (
          t.isVariableDeclarator(parent) &&
          t.isIdentifier(parent.id) &&
          /^[A-Z]/.test(parent.id.name)
        ) {
          componentDepth--;
        }
      },
    },
  });

  // Remove any variables that are actually memoized, state, refs, or module-level
  for (const memoized of memoizedVars) {
    unstableVars.delete(memoized);
  }
  for (const stateVar of stateVars) {
    unstableVars.delete(stateVar);
  }
  for (const refVar of refVars) {
    unstableVars.delete(refVar);
  }
  for (const moduleVar of moduleLevelVars) {
    unstableVars.delete(moduleVar);
  }

  return unstableVars;
}

/**
 * Check if a hook has unstable references in its dependency array.
 * Returns an analysis if an issue is found, null otherwise.
 */
/**
 * Check if a useEffect/useLayoutEffect body contains unconditional setState calls.
 * Returns true if there's a setState that will ALWAYS run (not guarded by if/early return).
 *
 * Uses a simple recursive walk instead of traverse() to avoid scope issues
 * when analyzing extracted function nodes.
 */
function hasUnconditionalSetState(effectBody: t.Node, stateInfo: Map<string, string>): boolean {
  const setterNames = new Set(stateInfo.values());
  let hasUnconditional = false;

  // Get the actual function body (handle arrow functions and regular functions)
  let bodyToAnalyze: t.Node | null = null;
  if (t.isArrowFunctionExpression(effectBody)) {
    bodyToAnalyze = effectBody.body;
  } else if (t.isFunctionExpression(effectBody)) {
    bodyToAnalyze = effectBody.body;
  } else {
    bodyToAnalyze = effectBody;
  }

  if (!bodyToAnalyze) return false;

  /**
   * Recursively walk the AST looking for unconditional setState calls.
   * @param node - Current AST node
   * @param conditionalDepth - How many levels of conditional context we're in
   */
  function walk(node: t.Node | null | undefined, conditionalDepth: number): void {
    if (!node || hasUnconditional) return;

    // Check for setState calls at this level
    if (t.isCallExpression(node)) {
      const callee = node.callee;
      if (t.isIdentifier(callee) && setterNames.has(callee.name)) {
        // This is a setState call - check if it's unconditional
        if (conditionalDepth === 0) {
          hasUnconditional = true;
          return;
        }
      }

      // Check for async patterns - increment depth for their callbacks
      const isAsyncCallback =
        (t.isIdentifier(callee) &&
          ['setInterval', 'setTimeout', 'requestAnimationFrame'].includes(callee.name)) ||
        (t.isMemberExpression(callee) &&
          t.isIdentifier(callee.property) &&
          ['then', 'catch', 'finally'].includes(callee.property.name));

      if (isAsyncCallback) {
        // Walk arguments with increased depth (callbacks inside are deferred)
        for (const arg of node.arguments) {
          if (t.isExpression(arg) || t.isSpreadElement(arg)) {
            walk(arg, conditionalDepth + 1);
          }
        }
        // Walk the callee too (for chained .then().catch())
        walk(callee, conditionalDepth);
        return;
      }

      // Regular call - walk callee and arguments
      walk(callee, conditionalDepth);
      for (const arg of node.arguments) {
        if (t.isExpression(arg) || t.isSpreadElement(arg)) {
          walk(arg, conditionalDepth);
        }
      }
      return;
    }

    // Don't traverse into nested function definitions (they're not executed immediately)
    if (
      t.isArrowFunctionExpression(node) ||
      t.isFunctionExpression(node) ||
      t.isFunctionDeclaration(node)
    ) {
      return;
    }

    // Conditional contexts - increase depth
    if (t.isIfStatement(node)) {
      walk(node.test, conditionalDepth);
      walk(node.consequent, conditionalDepth + 1);
      walk(node.alternate, conditionalDepth + 1);
      return;
    }

    if (t.isConditionalExpression(node)) {
      walk(node.test, conditionalDepth);
      walk(node.consequent, conditionalDepth + 1);
      walk(node.alternate, conditionalDepth + 1);
      return;
    }

    if (t.isLogicalExpression(node)) {
      walk(node.left, conditionalDepth);
      // Right side of && or || is conditional
      walk(node.right, conditionalDepth + 1);
      return;
    }

    // Block statement - walk all statements
    if (t.isBlockStatement(node)) {
      for (const stmt of node.body) {
        walk(stmt, conditionalDepth);
      }
      return;
    }

    // Expression statement - walk the expression
    if (t.isExpressionStatement(node)) {
      walk(node.expression, conditionalDepth);
      return;
    }

    // Return statement - walk the argument
    if (t.isReturnStatement(node)) {
      walk(node.argument, conditionalDepth);
      return;
    }

    // Variable declaration - walk initializers
    if (t.isVariableDeclaration(node)) {
      for (const decl of node.declarations) {
        walk(decl.init, conditionalDepth);
      }
      return;
    }

    // Try-catch - walk all parts
    if (t.isTryStatement(node)) {
      walk(node.block, conditionalDepth);
      walk(node.handler?.body, conditionalDepth + 1);
      walk(node.finalizer, conditionalDepth);
      return;
    }

    // For/while loops - walk body with conditional depth (may not execute)
    if (t.isForStatement(node) || t.isWhileStatement(node) || t.isDoWhileStatement(node)) {
      if (t.isForStatement(node)) {
        walk(node.init, conditionalDepth);
        walk(node.test, conditionalDepth);
        walk(node.update, conditionalDepth);
      }
      if (t.isWhileStatement(node) || t.isDoWhileStatement(node)) {
        walk(node.test, conditionalDepth);
      }
      walk(node.body, conditionalDepth + 1);
      return;
    }

    // For-in/for-of loops
    if (t.isForInStatement(node) || t.isForOfStatement(node)) {
      walk(node.right, conditionalDepth);
      walk(node.body, conditionalDepth + 1);
      return;
    }

    // Switch statement
    if (t.isSwitchStatement(node)) {
      walk(node.discriminant, conditionalDepth);
      for (const caseClause of node.cases) {
        walk(caseClause.test, conditionalDepth);
        for (const stmt of caseClause.consequent) {
          walk(stmt, conditionalDepth + 1);
        }
      }
      return;
    }

    // Member expression - walk object and property
    if (t.isMemberExpression(node)) {
      walk(node.object, conditionalDepth);
      if (node.computed) {
        walk(node.property, conditionalDepth);
      }
      return;
    }

    // Array/object expressions - walk elements
    if (t.isArrayExpression(node)) {
      for (const el of node.elements) {
        walk(el, conditionalDepth);
      }
      return;
    }

    if (t.isObjectExpression(node)) {
      for (const prop of node.properties) {
        if (t.isObjectProperty(prop)) {
          walk(prop.value, conditionalDepth);
        }
      }
      return;
    }

    // Binary/unary expressions
    if (t.isBinaryExpression(node) || t.isAssignmentExpression(node)) {
      walk(node.left, conditionalDepth);
      walk(node.right, conditionalDepth);
      return;
    }

    if (t.isUnaryExpression(node) || t.isUpdateExpression(node)) {
      walk(node.argument, conditionalDepth);
      return;
    }

    // Sequence expression
    if (t.isSequenceExpression(node)) {
      for (const expr of node.expressions) {
        walk(expr, conditionalDepth);
      }
      return;
    }

    // Await expression
    if (t.isAwaitExpression(node)) {
      walk(node.argument, conditionalDepth);
      return;
    }

    // Template literal
    if (t.isTemplateLiteral(node)) {
      for (const expr of node.expressions) {
        walk(expr, conditionalDepth);
      }
      return;
    }
  }

  walk(bodyToAnalyze, 0);
  return hasUnconditional;
}

function checkUnstableReferences(
  hookNode: HookNodeInfo,
  unstableVars: Map<string, UnstableVariable>,
  stateInfo: Map<string, string>,
  filePath: string,
  fileContent?: string
): IntelligentHookAnalysis | null {
  const { node, hookName, line } = hookNode;

  // Check for ignore comments
  if (fileContent && isHookIgnored(fileContent, line)) {
    return null;
  }

  if (!node.arguments || node.arguments.length < 2) {
    return null; // No dependencies array
  }

  // Get the effect/callback body (first argument)
  const effectBody = node.arguments[0];

  // Get dependencies array
  const depsArray = node.arguments[node.arguments.length - 1];
  if (!t.isArrayExpression(depsArray)) {
    return null;
  }

  // For useEffect/useLayoutEffect, check if there are unconditional setState calls
  const isUseEffect = hookName === 'useEffect' || hookName === 'useLayoutEffect';
  const hasUnconditionalStateUpdate =
    isUseEffect && effectBody && hasUnconditionalSetState(effectBody, stateInfo);

  // Check each dependency
  for (const dep of depsArray.elements) {
    if (!t.isIdentifier(dep)) continue;

    const depName = dep.name;

    // Skip if it's a state variable (managed by React, stable reference within render)
    if (stateInfo.has(depName)) continue;

    // Check if this dependency is an unstable variable
    const unstableVar = unstableVars.get(depName);
    if (unstableVar) {
      const typeDescriptions: Record<string, string> = {
        object: 'object literal',
        array: 'array literal',
        function: 'function',
        'function-call': 'function call result',
      };

      // Determine severity based on whether there's an unconditional setState
      // - If useEffect with unconditional setState: confirmed infinite loop (high severity)
      // - If useEffect with only conditional setState: potential issue (medium severity) - effect runs often but won't loop
      // - If useCallback/useMemo: potential issue (medium severity) - unnecessary re-creation
      const isConfirmedLoop = isUseEffect && hasUnconditionalStateUpdate;

      // Determine error code based on unstable variable type
      const unstableTypeToErrorCode: Record<UnstableVariable['type'], ErrorCode> = {
        object: 'RLD-400',
        array: 'RLD-401',
        function: 'RLD-402',
        'function-call': 'RLD-403',
      };

      return createAnalysis({
        type: isConfirmedLoop ? 'confirmed-infinite-loop' : 'potential-issue',
        errorCode: isConfirmedLoop ? 'RLD-200' : unstableTypeToErrorCode[unstableVar.type],
        category: isConfirmedLoop ? 'critical' : 'performance',
        severity: isConfirmedLoop ? 'high' : 'low',
        confidence: 'high',
        hookType: hookName,
        line,
        file: filePath,
        problematicDependency: depName,
        stateVariable: undefined,
        setterFunction: undefined,
        actualStateModifications: [],
        stateReads: [],
        explanation: isConfirmedLoop
          ? `'${depName}' is a ${typeDescriptions[unstableVar.type]} created inside the component. ` +
            `It gets a new reference on every render, and this ${hookName} has an unconditional setState, ` +
            `causing an infinite re-render loop. ` +
            `Fix: wrap with useMemo/useCallback, move outside the component, or remove from dependencies.`
          : isUseEffect
            ? `'${depName}' is a ${typeDescriptions[unstableVar.type]} created inside the component. ` +
              `It gets a new reference on every render, causing this ${hookName} to run on every render. ` +
              `This is a performance issue but won't cause an infinite loop since setState calls are conditional. ` +
              `Fix: wrap with useMemo/useCallback, move outside the component, or remove from dependencies.`
            : `'${depName}' is a ${typeDescriptions[unstableVar.type]} created inside the component. ` +
              `It gets a new reference on every render, causing unnecessary ${hookName} re-creation. ` +
              `Fix: wrap with useMemo/useCallback or move outside the component.`,
        debugInfo: {
          reason: `Detected unstable ${unstableVar.type} '${depName}' in dependency array`,
          stateTracking: {
            declaredStateVars: Array.from(stateInfo.keys()),
            setterFunctions: Array.from(stateInfo.values()),
            stableVariables: [],
            unstableVariables: Array.from(unstableVars.keys()),
          },
          dependencyAnalysis: {
            rawDependencies: depsArray.elements
              .filter((el): el is t.Identifier => t.isIdentifier(el))
              .map((el) => el.name),
            problematicDeps: [depName],
            safeDeps: depsArray.elements
              .filter((el): el is t.Identifier => t.isIdentifier(el) && el.name !== depName)
              .map((el) => el.name),
          },
        },
      });
    }
  }

  return null;
}

function findHookNodes(ast: t.Node): HookNodeInfo[] {
  const hookNodes: HookNodeInfo[] = [];

  traverse(ast, {
    CallExpression(nodePath: NodePath<t.CallExpression>) {
      if (t.isIdentifier(nodePath.node.callee)) {
        const hookName = nodePath.node.callee.name;
        if (['useEffect', 'useCallback', 'useMemo'].includes(hookName)) {
          hookNodes.push({
            node: nodePath.node,
            hookName,
            line: nodePath.node.loc?.start.line || 0,
          });
        }
      }
    },
  });

  return hookNodes;
}

function analyzeHookNode(
  hookNode: HookNodeInfo,
  stateInfo: Map<string, string>,
  filePath: string,
  crossFileAnalysis: CrossFileAnalysis,
  fileContent?: string,
  refVars: Set<string> = new Set()
): IntelligentHookAnalysis | null {
  const { node, hookName, line } = hookNode;

  // Check for ignore comments: // rcd-ignore or // rcd-ignore-next-line
  if (fileContent && isHookIgnored(fileContent, line)) {
    return null; // Skip this hook - user has explicitly ignored it
  }

  if (!node.arguments || node.arguments.length < 2) {
    return null; // No dependencies array
  }

  // Get dependencies
  const depsArray = node.arguments[node.arguments.length - 1];
  if (!t.isArrayExpression(depsArray)) {
    return null;
  }

  const dependencies = depsArray.elements
    .filter((el): el is t.Identifier => t.isIdentifier(el))
    .map((el) => el.name);

  // Analyze hook body for state interactions
  const hookBody = node.arguments[0];
  const stateInteractions = analyzeStateInteractions(hookBody, stateInfo, refVars);

  // Check cross-file modifications for this hook
  const hookId = `${filePath}:${line}:${hookName}`;
  const crossFileModifications = crossFileAnalysis.stateSetterFlows.get(hookId) || [];

  // IMPORTANT: useCallback and useMemo CANNOT cause infinite loops by themselves!
  // They only memoize functions/values - they don't auto-execute on dependency changes.
  // Only useEffect/useLayoutEffect can directly cause infinite re-render loops.
  const canCauseDirectLoop = hookName === 'useEffect' || hookName === 'useLayoutEffect';

  // Check if dependencies are only passed as references (not invoked)
  // e.g., addEventListener('resize', handleResize) - handleResize is passed, not called
  const depsPassedAsRefs = new Set(
    stateInteractions.functionReferences.map((ref) => ref.functionName)
  );

  // Check for problematic patterns
  for (const dep of dependencies) {
    const setter = stateInfo.get(dep);
    if (!setter) continue;

    // Check if this setter has a safe guard
    const guardedMod = stateInteractions.guardedModifications.find(
      (g) => g.setter === setter && g.stateVariable === dep
    );

    if (guardedMod) {
      if (guardedMod.isSafe) {
        // This modification is safely guarded - not a problem
        return createAnalysis({
          type: 'safe-pattern',
          errorCode: 'RLD-200', // Safe pattern, but we use the base code for categorization
          category: 'safe',
          severity: 'low',
          confidence: 'high',
          hookType: hookName,
          line,
          file: filePath,
          problematicDependency: dep,
          stateVariable: dep,
          setterFunction: setter,
          actualStateModifications: [setter],
          stateReads: stateInteractions.reads,
          explanation: `Hook modifies '${dep}' but has a ${guardedMod.guardType} that prevents infinite loops.`,
        });
      }

      // Handle risky guard patterns like object-spread-risk
      if (guardedMod.guardType === 'object-spread-risk') {
        return createAnalysis({
          type: 'potential-issue',
          errorCode: 'RLD-410',
          category: 'warning',
          severity: 'medium',
          confidence: 'medium',
          hookType: hookName,
          line,
          file: filePath,
          problematicDependency: dep,
          stateVariable: dep,
          setterFunction: setter,
          actualStateModifications: [setter],
          stateReads: stateInteractions.reads,
          explanation:
            guardedMod.warning ||
            `Guard checks property of '${dep}' but setter creates new object reference. ` +
              `The object identity changes even when the guarded property doesn't, which may cause unexpected re-renders.`,
        });
      }
    }

    // Check if this dependency is only passed as a reference (not invoked)
    // e.g., useEffect(() => { addEventListener('resize', handleResize) }, [handleResize])
    // The handleResize function modifies state, but it's not called during effect execution
    if (depsPassedAsRefs.has(dep)) {
      const refInfo = stateInteractions.functionReferences.find((r) => r.functionName === dep);
      // If it's only used as a reference and the state modification happens through that function,
      // it's safe because the function won't be invoked synchronously during effect execution
      return createAnalysis({
        type: 'safe-pattern',
        errorCode: 'RLD-200',
        category: 'safe',
        severity: 'low',
        confidence: 'high',
        hookType: hookName,
        line,
        file: filePath,
        problematicDependency: dep,
        stateVariable: dep,
        setterFunction: setter,
        actualStateModifications: [],
        stateReads: stateInteractions.reads,
        explanation: `'${dep}' is passed as a ${refInfo?.context || 'callback'} reference to '${refInfo?.receivingFunction || 'a function'}', not invoked directly. This is a safe pattern.`,
      });
    }

    // Check if this is a deferred modification (inside setInterval, onSnapshot, etc.)
    // These don't cause immediate re-render loops because they execute asynchronously
    if (stateInteractions.deferredModifications.includes(setter)) {
      return createAnalysis({
        type: 'safe-pattern',
        errorCode: 'RLD-200',
        category: 'safe',
        severity: 'low',
        confidence: 'high',
        hookType: hookName,
        line,
        file: filePath,
        problematicDependency: dep,
        stateVariable: dep,
        setterFunction: setter,
        actualStateModifications: stateInteractions.deferredModifications,
        stateReads: stateInteractions.reads,
        explanation: `'${setter}()' is called inside an async callback (setInterval, onSnapshot, etc.), not during effect execution. This is a safe pattern - the state update is deferred and won't cause an immediate re-render loop.`,
      });
    }

    // Check direct modifications
    if (stateInteractions.modifications.includes(setter)) {
      if (canCauseDirectLoop) {
        // Determine if it's useEffect or useLayoutEffect for the error code
        const effectErrorCode: ErrorCode = hookName === 'useLayoutEffect' ? 'RLD-202' : 'RLD-200';
        return createAnalysis({
          type: 'confirmed-infinite-loop',
          errorCode: effectErrorCode,
          category: 'critical',
          severity: 'high',
          confidence: 'high',
          hookType: hookName,
          line,
          file: filePath,
          problematicDependency: dep,
          stateVariable: dep,
          setterFunction: setter,
          actualStateModifications: stateInteractions.modifications,
          stateReads: stateInteractions.reads,
          explanation: `${hookName} modifies '${dep}' via '${setter}()' while depending on it, creating guaranteed infinite loop.`,
          debugInfo: {
            reason: `Direct state modification: ${hookName} depends on '${dep}' and calls '${setter}()' unconditionally`,
            stateTracking: {
              declaredStateVars: Array.from(stateInfo.keys()),
              setterFunctions: Array.from(stateInfo.values()),
              stableVariables: [],
              unstableVariables: [],
            },
            dependencyAnalysis: {
              rawDependencies: dependencies,
              problematicDeps: [dep],
              safeDeps: dependencies.filter((d) => d !== dep),
            },
            guardInfo: {
              hasGuard: false,
            },
            deferredInfo: {
              isDeferred: false,
            },
          },
        });
      } else {
        // useCallback/useMemo - can't cause loops directly
        // If it uses a functional updater, it's completely safe - don't report
        if (stateInteractions.functionalUpdates.includes(setter)) {
          return null; // Functional updater in useCallback/useMemo is safe
        }
        // Only warn if it's NOT using functional updater (reads dep value directly)
        return createAnalysis({
          type: 'potential-issue',
          errorCode: 'RLD-420',
          category: 'warning',
          severity: 'low',
          confidence: 'medium',
          hookType: hookName,
          line,
          file: filePath,
          problematicDependency: dep,
          stateVariable: dep,
          setterFunction: setter,
          actualStateModifications: stateInteractions.modifications,
          stateReads: stateInteractions.reads,
          explanation: `${hookName} modifies '${dep}' while depending on it. This won't cause a direct infinite loop (${hookName} doesn't auto-execute), but review if a useEffect depends on this callback.`,
        });
      }
    }

    // Check indirect modifications through cross-file calls
    if (crossFileModifications.includes(setter)) {
      if (canCauseDirectLoop) {
        return createAnalysis({
          type: 'confirmed-infinite-loop',
          errorCode: 'RLD-300',
          category: 'critical',
          severity: 'high',
          confidence: 'high',
          hookType: hookName,
          line,
          file: filePath,
          problematicDependency: dep,
          stateVariable: dep,
          setterFunction: setter,
          actualStateModifications: crossFileModifications,
          stateReads: stateInteractions.reads,
          explanation: `${hookName} indirectly modifies '${dep}' via function calls while depending on it, creating guaranteed infinite loop.`,
        });
      } else {
        return createAnalysis({
          type: 'potential-issue',
          errorCode: 'RLD-301',
          category: 'warning',
          severity: 'low',
          confidence: 'medium',
          hookType: hookName,
          line,
          file: filePath,
          problematicDependency: dep,
          stateVariable: dep,
          setterFunction: setter,
          actualStateModifications: crossFileModifications,
          stateReads: stateInteractions.reads,
          explanation: `${hookName} indirectly modifies '${dep}' while depending on it. This won't cause a direct infinite loop (${hookName} doesn't auto-execute).`,
        });
      }
    }

    // Check conditional modifications (that weren't identified as safely guarded)
    if (stateInteractions.conditionalModifications.includes(setter)) {
      if (canCauseDirectLoop) {
        return createAnalysis({
          type: 'potential-issue',
          errorCode: 'RLD-501',
          category: 'warning',
          severity: 'medium',
          confidence: 'medium',
          hookType: hookName,
          line,
          file: filePath,
          problematicDependency: dep,
          stateVariable: dep,
          setterFunction: setter,
          actualStateModifications: stateInteractions.conditionalModifications,
          stateReads: stateInteractions.reads,
          explanation: `${hookName} conditionally modifies '${dep}' - review if conditions prevent infinite loops.`,
        });
      } else {
        // useCallback/useMemo with conditional modification - very unlikely to be a problem
        return null; // Don't report - too low risk
      }
    }

    // Only reads state, doesn't modify - don't return early, continue checking other deps
  }

  // Check for ref mutations that store state values - potential stale closure issues
  // This is a lower-priority warning as refs don't cause re-renders, but storing
  // state in refs can lead to stale data if not used carefully
  if (stateInteractions.refMutations.length > 0 && canCauseDirectLoop) {
    for (const refMutation of stateInteractions.refMutations) {
      if (refMutation.usesStateValue) {
        // Check if this ref is also read in the dependencies
        const refInDeps = dependencies.some(
          (dep) => dep === refMutation.refName || dep.includes(refMutation.refName)
        );

        if (refInDeps) {
          // Ref is both mutated with state value AND in dependencies - potential loop
          return createAnalysis({
            type: 'potential-issue',
            errorCode: 'RLD-600',
            category: 'warning',
            severity: 'low',
            confidence: 'low',
            hookType: hookName,
            line: refMutation.line,
            file: filePath,
            problematicDependency: refMutation.refName,
            stateVariable: refMutation.assignedValue || 'state',
            setterFunction: 'ref.current =',
            actualStateModifications: [],
            stateReads: stateInteractions.reads,
            explanation: `${hookName} mutates '${refMutation.refName}.current' with state value while depending on the ref. This can cause stale closure issues.`,
            debugInfo: {
              reason: `Ref '${refMutation.refName}' is mutated with state value '${refMutation.assignedValue}' and appears in dependencies`,
              stateTracking: {
                declaredStateVars: Array.from(stateInfo.keys()),
                setterFunctions: Array.from(stateInfo.values()),
                stableVariables: [],
                unstableVariables: [],
              },
              dependencyAnalysis: {
                rawDependencies: dependencies,
                problematicDeps: [refMutation.refName],
                safeDeps: dependencies.filter((d) => d !== refMutation.refName),
              },
            },
          });
        }
      }
    }
  }

  return null;
}

function analyzeStateInteractions(
  hookBody: t.Node,
  stateInfo: Map<string, string>,
  refVars: Set<string> = new Set()
): StateInteraction {
  const interactions: StateInteraction = {
    reads: [],
    modifications: [],
    conditionalModifications: [],
    functionalUpdates: [],
    deferredModifications: [],
    guardedModifications: [],
    functionReferences: [],
    refMutations: [],
  };

  const setterNames = Array.from(stateInfo.values());
  const stateNames = Array.from(stateInfo.keys());

  // Build reverse map: setter -> state variable
  const setterToState = new Map<string, string>();
  stateInfo.forEach((setter, state) => setterToState.set(setter, state));

  // Track ancestor chain for proper conditional analysis
  const ancestorStack: t.Node[] = [];

  // Common event listener methods that receive callback references (not invoked immediately)
  const eventListenerMethods = new Set([
    'addEventListener',
    'removeEventListener',
    'on',
    'off',
    'once',
    'addListener',
    'removeListener',
    'subscribe',
    'unsubscribe',
    'setTimeout',
    'setInterval',
    'requestAnimationFrame',
    'then',
    'catch',
    'finally', // Promise methods
    'map',
    'filter',
    'forEach',
    'reduce',
    'find',
    'some',
    'every', // Array methods
  ]);

  // Functions that execute their callbacks asynchronously (deferred execution)
  // State modifications inside these callbacks won't cause immediate re-render loops
  const asyncCallbackFunctions = new Set([
    'setTimeout',
    'setInterval',
    'requestAnimationFrame',
    'requestIdleCallback',
    'then',
    'catch',
    'finally', // Promise methods
    'onSnapshot',
    'onAuthStateChanged',
    'onValue',
    'onChildAdded',
    'onChildChanged',
    'onChildRemoved', // Firebase
    'subscribe',
    'observe', // Common subscription patterns
    'addEventListener', // Event listeners are async (user-triggered)
  ]);

  // Track functions that are passed as arguments (not invoked)
  const functionsPassedAsArgs = new Set<string>();

  // Track CallExpression nodes that are async callback receivers
  const asyncCallbackNodes = new Set<t.Node>();

  // First pass: find all functions passed as arguments to known safe receivers
  // AND track async callback nodes (calls to setInterval, onSnapshot, etc. with inline callbacks)
  function findFunctionReferences(node: t.Node | null | undefined): void {
    if (!node || typeof node !== 'object') return;

    // Check for calls like: addEventListener('click', handleClick) or obj.addEventListener(...)
    if (node.type === 'CallExpression') {
      let receivingFuncName: string | null = null;

      // Handle: addEventListener('click', handler)
      if (node.callee?.type === 'Identifier') {
        receivingFuncName = node.callee.name;
      }
      // Handle: element.addEventListener('click', handler) or window.addEventListener(...)
      else if (
        node.callee?.type === 'MemberExpression' &&
        node.callee.property?.type === 'Identifier'
      ) {
        receivingFuncName = node.callee.property.name;
      }

      if (receivingFuncName && eventListenerMethods.has(receivingFuncName)) {
        // Check each argument - if it's an identifier, it's passed as reference
        for (const arg of node.arguments || []) {
          if (arg.type === 'Identifier') {
            functionsPassedAsArgs.add(arg.name);
            interactions.functionReferences.push({
              functionName: arg.name,
              context: [
                'addEventListener',
                'removeEventListener',
                'on',
                'off',
                'addListener',
                'removeListener',
              ].includes(receivingFuncName)
                ? 'event-listener'
                : 'callback-arg',
              receivingFunction: receivingFuncName,
            });
          }
        }
      }

      // Track async callback function calls - these contain callbacks that execute asynchronously
      // e.g., setInterval(() => setCount(...), 1000) or onSnapshot(q, (snapshot) => { ... })
      if (receivingFuncName && asyncCallbackFunctions.has(receivingFuncName)) {
        // Mark all function arguments (arrow functions, function expressions) as async callbacks
        for (const arg of node.arguments || []) {
          if (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression') {
            asyncCallbackNodes.add(arg);
          }
        }
      }
    }

    // Recursively search
    const indexableNode = node as unknown as Record<string, unknown>;
    Object.keys(node).forEach((key) => {
      const value = indexableNode[key];
      if (Array.isArray(value)) {
        value.forEach((child) => findFunctionReferences(child as t.Node | null | undefined));
      } else if (value && typeof value === 'object' && (value as { type?: string }).type) {
        findFunctionReferences(value as t.Node);
      }
    });
  }

  findFunctionReferences(hookBody);

  // Helper: check if current node is inside an async callback
  function isInsideAsyncCallback(): boolean {
    for (const ancestor of ancestorStack) {
      if (asyncCallbackNodes.has(ancestor)) {
        return true;
      }
    }
    return false;
  }

  // Create a simple traversal without @babel/traverse to avoid scope issues
  function visitNode(node: t.Node | null | undefined, parent?: t.Node | null): void {
    if (!node || typeof node !== 'object') return;

    ancestorStack.push(node);

    // Check for function calls (state setters)
    if (node.type === 'CallExpression' && node.callee && node.callee.type === 'Identifier') {
      const calleeName = node.callee.name;

      if (setterNames.includes(calleeName)) {
        const stateVar = setterToState.get(calleeName);

        // Check if this modification is inside an async callback (setInterval, onSnapshot, etc.)
        // If so, it's deferred and won't cause immediate re-render loops
        if (isInsideAsyncCallback()) {
          interactions.deferredModifications.push(calleeName);
          // Also check for functional updates even in deferred context
          if (
            node.arguments &&
            node.arguments.length > 0 &&
            (node.arguments[0].type === 'ArrowFunctionExpression' ||
              node.arguments[0].type === 'FunctionExpression')
          ) {
            interactions.functionalUpdates.push(calleeName);
          }
          // Skip further analysis - deferred modifications are safe
          ancestorStack.pop();
          // Still need to visit children
          const indexableCallNode = node as unknown as Record<string, unknown>;
          Object.keys(node).forEach((key) => {
            const value = indexableCallNode[key];
            if (Array.isArray(value)) {
              value.forEach((child) => visitNode(child as t.Node | null | undefined, node));
            } else if (value && typeof value === 'object' && (value as { type?: string }).type) {
              visitNode(value as t.Node, node);
            }
          });
          return;
        }

        // Enhanced: analyze the conditional guard if present
        const guardAnalysis = analyzeConditionalGuard(
          node,
          ancestorStack,
          calleeName,
          stateVar,
          stateNames
        );

        if (guardAnalysis) {
          interactions.guardedModifications.push(guardAnalysis);
          if (guardAnalysis.isSafe) {
            // Don't add to conditionalModifications if we know it's safe
          } else {
            interactions.conditionalModifications.push(calleeName);
          }
        } else if (isInsideConditionalSimple(parent)) {
          // Fallback to old logic if we couldn't analyze the guard
          interactions.conditionalModifications.push(calleeName);
        } else {
          interactions.modifications.push(calleeName);
        }

        // Check if it's a functional update
        if (
          node.arguments &&
          node.arguments.length > 0 &&
          (node.arguments[0].type === 'ArrowFunctionExpression' ||
            node.arguments[0].type === 'FunctionExpression')
        ) {
          interactions.functionalUpdates.push(calleeName);
        }
      }
    }

    // Check for member expressions (state reads)
    if (node.type === 'MemberExpression' && node.object && node.object.type === 'Identifier') {
      const objectName = node.object.name;
      if (stateNames.includes(objectName)) {
        interactions.reads.push(objectName);
      }
    }

    // Check for identifier references (state reads)
    if (node.type === 'Identifier' && stateNames.includes(node.name)) {
      // Only count as read if it's not being assigned to (simplified check)
      if (!parent || parent.type !== 'AssignmentExpression' || parent.left !== node) {
        interactions.reads.push(node.name);
      }
    }

    // Check for ref.current mutations (e.g., ref.current = value)
    if (
      node.type === 'AssignmentExpression' &&
      node.left &&
      node.left.type === 'MemberExpression' &&
      node.left.object &&
      node.left.object.type === 'Identifier' &&
      node.left.property &&
      node.left.property.type === 'Identifier' &&
      node.left.property.name === 'current' &&
      refVars.has(node.left.object.name)
    ) {
      const refName = node.left.object.name;
      const rightSide = node.right;

      // Check if the assigned value is a state variable
      let assignedValue: string | undefined;
      let usesStateValue = false;

      if (rightSide.type === 'Identifier') {
        assignedValue = rightSide.name;
        usesStateValue = stateNames.includes(rightSide.name);
      } else {
        // Check if any identifier in the right side is a state variable
        const checkForStateVars = (n: t.Node): boolean => {
          if (n.type === 'Identifier' && stateNames.includes(n.name)) {
            return true;
          }
          const indexable = n as unknown as Record<string, unknown>;
          for (const key of Object.keys(n)) {
            const val = indexable[key];
            if (Array.isArray(val)) {
              for (const child of val) {
                if (child && typeof child === 'object' && (child as { type?: string }).type) {
                  if (checkForStateVars(child as t.Node)) return true;
                }
              }
            } else if (val && typeof val === 'object' && (val as { type?: string }).type) {
              if (checkForStateVars(val as t.Node)) return true;
            }
          }
          return false;
        };
        usesStateValue = checkForStateVars(rightSide);
      }

      interactions.refMutations.push({
        refName,
        assignedValue,
        usesStateValue,
        line: node.loc?.start.line || 0,
      });
    }

    // Recursively visit all properties
    const indexableVisitNode = node as unknown as Record<string, unknown>;
    Object.keys(node).forEach((key) => {
      const value = indexableVisitNode[key];
      if (Array.isArray(value)) {
        value.forEach((child) => visitNode(child as t.Node | null | undefined, node));
      } else if (value && typeof value === 'object' && (value as { type?: string }).type) {
        visitNode(value as t.Node, node);
      }
    });

    ancestorStack.pop();
  }

  visitNode(hookBody);

  // Remove duplicates
  interactions.reads = [...new Set(interactions.reads)];
  interactions.modifications = [...new Set(interactions.modifications)];
  interactions.conditionalModifications = [...new Set(interactions.conditionalModifications)];
  interactions.functionalUpdates = [...new Set(interactions.functionalUpdates)];
  interactions.deferredModifications = [...new Set(interactions.deferredModifications)];

  return interactions;
}

/**
 * Analyze whether a conditional guard around a state setter prevents infinite loops.
 *
 * Common safe patterns:
 * 1. Toggle guard: `if (!value) setValue(true)` - only sets when false
 * 2. Equality guard: `if (value !== newValue) setValue(newValue)` - only sets when different
 * 3. Early return: `if (value === something) return; setValue(...)` - exits before setting
 */
function analyzeConditionalGuard(
  setterCall: t.CallExpression,
  ancestorStack: t.Node[],
  setterName: string,
  stateVar: string | undefined,
  _allStateVars: string[] // Reserved for future use
): GuardedModification | null {
  if (!stateVar) return null;

  // Find the nearest conditional ancestor
  for (let i = ancestorStack.length - 1; i >= 0; i--) {
    const ancestor = ancestorStack[i];

    // Check for IfStatement
    if (ancestor.type === 'IfStatement') {
      const condition = ancestor.test;
      const guardType = analyzeCondition(condition, stateVar, setterCall, ancestor);

      if (guardType) {
        return {
          setter: setterName,
          stateVariable: stateVar,
          guardType: guardType.type,
          isSafe: guardType.isSafe,
        };
      }
    }

    // Check for early return pattern in BlockStatement
    if (ancestor.type === 'BlockStatement') {
      const earlyReturnGuard = checkEarlyReturnPattern(ancestor, setterCall, stateVar);
      if (earlyReturnGuard) {
        return {
          setter: setterName,
          stateVariable: stateVar,
          guardType: 'early-return',
          isSafe: true,
        };
      }
    }
  }

  return null;
}

/**
 * Analyze if a condition creates a safe guard for state modification.
 */
function analyzeCondition(
  condition: t.Node | null | undefined,
  stateVar: string,
  setterCall: t.CallExpression,
  _ifStatement: t.IfStatement
): { type: GuardedModification['guardType']; isSafe: boolean; warning?: string } | null {
  if (!condition) return null;

  // Pattern 1: Toggle guard - `if (!stateVar)` or `if (stateVar === false)`
  // Setting to true when false (or vice versa) - only runs once
  if (condition.type === 'UnaryExpression' && condition.operator === '!') {
    if (condition.argument?.type === 'Identifier' && condition.argument.name === stateVar) {
      // Check if we're setting to a truthy value (common: true, or any non-falsy)
      const setterArg = setterCall.arguments?.[0];
      if (setterArg) {
        // `if (!value) setValue(true)` - toggle guard, safe
        if (setterArg.type === 'BooleanLiteral' && setterArg.value === true) {
          return { type: 'toggle-guard', isSafe: true };
        }
        // `if (!value) setValue(something)` where something is truthy - likely safe
        if (setterArg.type !== 'Identifier' || setterArg.name !== stateVar) {
          return { type: 'toggle-guard', isSafe: true };
        }
      }
    }
  }

  // Pattern 1b: `if (stateVar)` with setting to falsy
  if (condition.type === 'Identifier' && condition.name === stateVar) {
    const setterArg = setterCall.arguments?.[0];
    if (setterArg?.type === 'BooleanLiteral' && setterArg.value === false) {
      return { type: 'toggle-guard', isSafe: true };
    }
    if (
      setterArg?.type === 'NullLiteral' ||
      (setterArg?.type === 'Identifier' && setterArg.name === 'undefined')
    ) {
      return { type: 'toggle-guard', isSafe: true };
    }
  }

  // Pattern 2: Equality guard - `if (stateVar !== newValue)` or `if (newValue !== stateVar)`
  if (condition.type === 'BinaryExpression') {
    const { left, right, operator } = condition;

    // Check for !== or !=
    if (operator === '!==' || operator === '!=') {
      const hasStateOnLeft = left?.type === 'Identifier' && left.name === stateVar;
      const hasStateOnRight = right?.type === 'Identifier' && right.name === stateVar;

      if (hasStateOnLeft || hasStateOnRight) {
        return { type: 'equality-guard', isSafe: true };
      }

      // Check for PROPERTY equality guard with object spread risk
      // Pattern: if (user.id !== 5) setUser({ ...user, id: 5 })
      const leftIsMemberOfState =
        left?.type === 'MemberExpression' &&
        left.object?.type === 'Identifier' &&
        left.object.name === stateVar;

      const rightIsMemberOfState =
        right?.type === 'MemberExpression' &&
        right.object?.type === 'Identifier' &&
        right.object.name === stateVar;

      if (leftIsMemberOfState || rightIsMemberOfState) {
        // Check if setter creates a new object reference
        const setterArg = setterCall.arguments?.[0];
        if (setterArg && usesObjectSpread(setterArg, stateVar)) {
          // This is risky: guard checks property, but setter creates new object
          return {
            type: 'object-spread-risk',
            isSafe: false,
            warning:
              `Guard checks property of '${stateVar}' but setter creates new object reference. ` +
              `Even after the property matches, the object reference changes each render, ` +
              `which may cause issues if other effects or memoized values depend on object identity.`,
          };
        }

        // Property check without object spread - could be safe
        return { type: 'equality-guard', isSafe: true };
      }
    }

    // Check for === or == with early return (handled elsewhere)
  }

  // Pattern 3: Logical AND with state check - `if (someCondition && !stateVar)`
  if (condition.type === 'LogicalExpression' && condition.operator === '&&') {
    // Recursively check both sides
    const leftResult = analyzeCondition(condition.left, stateVar, setterCall, _ifStatement);
    const rightResult = analyzeCondition(condition.right, stateVar, setterCall, _ifStatement);

    if (leftResult?.isSafe) return leftResult;
    if (rightResult?.isSafe) return rightResult;
  }

  return null;
}

/**
 * Check for early return pattern:
 * ```
 * if (value === something) return;
 * setValue(newValue);
 * ```
 */
function checkEarlyReturnPattern(
  blockStatement: t.BlockStatement,
  setterCall: t.CallExpression,
  stateVar: string
): boolean {
  if (!blockStatement.body || !Array.isArray(blockStatement.body)) return false;

  // Find the index of the setter call in the block
  let setterIndex = -1;
  for (let i = 0; i < blockStatement.body.length; i++) {
    if (containsNode(blockStatement.body[i], setterCall)) {
      setterIndex = i;
      break;
    }
  }

  if (setterIndex <= 0) return false;

  // Check statements before the setter for early return guards
  for (let i = 0; i < setterIndex; i++) {
    const stmt = blockStatement.body[i];

    if (stmt.type === 'IfStatement') {
      // Check if it's `if (condition) return;`
      const hasReturn =
        stmt.consequent?.type === 'ReturnStatement' ||
        (stmt.consequent?.type === 'BlockStatement' &&
          stmt.consequent.body?.length === 1 &&
          stmt.consequent.body[0]?.type === 'ReturnStatement');

      if (hasReturn) {
        // Check if condition involves the state variable
        if (conditionInvolvesState(stmt.test, stateVar)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Check if a condition references a state variable
 */
function conditionInvolvesState(condition: t.Node | null | undefined, stateVar: string): boolean {
  if (!condition) return false;

  if (condition.type === 'Identifier' && condition.name === stateVar) {
    return true;
  }

  if (condition.type === 'BinaryExpression' || condition.type === 'LogicalExpression') {
    return (
      conditionInvolvesState(condition.left, stateVar) ||
      conditionInvolvesState(condition.right, stateVar)
    );
  }

  if (condition.type === 'UnaryExpression') {
    return conditionInvolvesState(condition.argument, stateVar);
  }

  if (condition.type === 'MemberExpression') {
    return conditionInvolvesState(condition.object, stateVar);
  }

  return false;
}

/**
 * Check if a setter argument uses object spread with the state variable.
 * Examples that return true:
 * - `{ ...user, id: 5 }`
 * - `{ ...user }`
 * - `Object.assign({}, user, { id: 5 })`
 */
function usesObjectSpread(setterArg: t.Node | null | undefined, stateVar: string): boolean {
  if (!setterArg) return false;

  // Check for object expression with spread: { ...stateVar, ... }
  if (setterArg.type === 'ObjectExpression') {
    for (const prop of setterArg.properties || []) {
      if (prop.type === 'SpreadElement') {
        // Check if spreading the state variable
        if (prop.argument?.type === 'Identifier' && prop.argument.name === stateVar) {
          return true;
        }
      }
    }
  }

  // Check for Object.assign({}, stateVar, ...)
  if (setterArg.type === 'CallExpression') {
    const callee = setterArg.callee;
    if (
      callee?.type === 'MemberExpression' &&
      callee.object?.type === 'Identifier' &&
      callee.object.name === 'Object' &&
      callee.property?.type === 'Identifier' &&
      callee.property.name === 'assign'
    ) {
      // Check if any argument is the state variable
      for (const arg of setterArg.arguments || []) {
        if (arg.type === 'Identifier' && arg.name === stateVar) {
          return true;
        }
      }
    }
  }

  // Check for array spread: [...items, newItem]
  if (setterArg.type === 'ArrayExpression') {
    for (const element of setterArg.elements || []) {
      if (element?.type === 'SpreadElement') {
        if (element.argument?.type === 'Identifier' && element.argument.name === stateVar) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Check if a node contains another node (by reference)
 */
function containsNode(tree: t.Node | null | undefined, target: t.Node): boolean {
  if (tree === target) return true;
  if (!tree || typeof tree !== 'object') return false;

  const indexableTree = tree as unknown as Record<string, unknown>;
  for (const key of Object.keys(tree)) {
    const value = indexableTree[key];
    if (Array.isArray(value)) {
      if (value.some((child) => containsNode(child as t.Node, target))) return true;
    } else if (value && typeof value === 'object') {
      if (containsNode(value as t.Node, target)) return true;
    }
  }

  return false;
}

function isInsideConditionalSimple(parent: t.Node | null | undefined): boolean {
  // Simple heuristic: check if we're inside an if statement block
  // This is a simplified version that looks for common conditional patterns
  const current = parent;

  while (current) {
    if (
      current.type === 'IfStatement' ||
      current.type === 'ConditionalExpression' ||
      current.type === 'LogicalExpression'
    ) {
      return true;
    }
    // For simplicity, we'll only go up one level to avoid complexity
    break;
  }

  return false;
}

/**
 * Check if a hook at the given line should be ignored based on comments.
 * Supports:
 * - // rcd-ignore (on same line)
 * - // rcd-ignore-next-line (on previous line)
 * - Block comments with rcd-ignore (inline or on same line)
 */
function isHookIgnored(fileContent: string, hookLine: number): boolean {
  const lines = fileContent.split('\n');

  // Check the hook's line for inline ignore comment
  if (hookLine > 0 && hookLine <= lines.length) {
    const currentLine = lines[hookLine - 1];
    if (/\/\/\s*rcd-ignore\b/.test(currentLine) || /\/\*\s*rcd-ignore\s*\*\//.test(currentLine)) {
      return true;
    }
  }

  // Check the previous line for rcd-ignore-next-line
  if (hookLine > 1 && hookLine <= lines.length) {
    const previousLine = lines[hookLine - 2];
    if (
      /\/\/\s*rcd-ignore-next-line\b/.test(previousLine) ||
      /\/\*\s*rcd-ignore-next-line\s*\*\//.test(previousLine)
    ) {
      return true;
    }
  }

  return false;
}

function createAnalysis(params: {
  type: IntelligentHookAnalysis['type'];
  errorCode: ErrorCode;
  category: IssueCategory;
  severity: IntelligentHookAnalysis['severity'];
  confidence: IntelligentHookAnalysis['confidence'];
  hookType: string;
  line: number;
  column?: number;
  file: string;
  problematicDependency: string;
  stateVariable?: string;
  setterFunction?: string;
  actualStateModifications: string[];
  stateReads: string[];
  explanation: string;
  debugInfo?: DebugInfo;
}): IntelligentHookAnalysis {
  const result: IntelligentHookAnalysis = {
    type: params.type,
    errorCode: params.errorCode,
    category: params.category,
    description: `${params.hookType} ${params.type.replace('-', ' ')}`,
    file: params.file,
    line: params.line,
    column: params.column,
    hookType: params.hookType,
    problematicDependency: params.problematicDependency,
    stateVariable: params.stateVariable,
    setterFunction: params.setterFunction,
    severity: params.severity,
    confidence: params.confidence,
    explanation: params.explanation,
    actualStateModifications: params.actualStateModifications,
    stateReads: params.stateReads,
  };

  // Only include debug info if debug mode is enabled
  if (currentOptions.debug && params.debugInfo) {
    result.debugInfo = params.debugInfo;
  }

  return result;
}
