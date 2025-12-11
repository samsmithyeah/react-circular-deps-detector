/**
 * TypeScript Type Checker Module
 *
 * Provides TypeScript Compiler API integration for enhanced stability detection.
 * This is an optional "strict" mode that uses actual type information instead of
 * heuristics to determine variable stability.
 *
 * Performance optimizations:
 * - TRUE lazy loading: TypeScript Language Service only initialized on first type query
 * - Incremental updates: File changes update the program incrementally, not from scratch
 * - Per-file caching: Type information is cached per-file for fast repeated queries
 * - Persistent instances: VS Code extension can persist the TypeChecker across analyses
 *
 * Benefits over heuristic-based detection:
 * - Accurately detects readonly/immutable types
 * - Understands generic return types from hooks
 * - Recognizes `as const` assertions
 * - Tracks type narrowing and discriminated unions
 * - Resolves actual return types of functions
 */

import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';
import { TsconfigManager, createTsconfigManager } from './tsconfig-manager';

export interface TypeCheckerOptions {
  /** Project root directory (where tsconfig.json is located) */
  projectRoot: string;
  /** Optional custom tsconfig path */
  tsconfigPath?: string;
  /** Cache type information for performance */
  cacheTypes?: boolean;
}

export interface TypeInfo {
  /** Whether this type is considered stable (won't cause re-renders) */
  isStable: boolean;
  /** Human-readable type representation */
  typeString: string;
  /** Why this type is stable or unstable */
  reason: string;
  /** Whether this is a primitive type */
  isPrimitive: boolean;
  /** Whether this is marked as readonly */
  isReadonly: boolean;
  /** Whether this uses 'as const' assertion */
  isConstAssertion: boolean;
}

export interface FunctionReturnInfo {
  /** Return type of the function */
  returnType: TypeInfo;
  /** Whether the function has stable return type */
  isStableReturn: boolean;
}

/**
 * Language Service Host implementation for incremental type checking.
 * This allows efficient updates when files change without rebuilding the entire program.
 */
class LazyLanguageServiceHost implements ts.LanguageServiceHost {
  private fileVersions = new Map<string, number>();
  private fileSnapshots = new Map<string, ts.IScriptSnapshot>();
  private parsedConfig: ts.ParsedCommandLine | null = null;
  private configPath: string | null = null;
  private projectRoot: string;
  private tsconfigPath?: string;

  constructor(projectRoot: string, tsconfigPath?: string) {
    this.projectRoot = projectRoot;
    this.tsconfigPath = tsconfigPath;
  }

  /**
   * Lazy load the tsconfig - only called when actually needed
   */
  private ensureConfig(): ts.ParsedCommandLine | null {
    if (this.parsedConfig !== null) {
      return this.parsedConfig;
    }

    this.configPath = this.findTsConfig();
    if (!this.configPath) {
      return null;
    }

    const configFile = ts.readConfigFile(this.configPath, ts.sys.readFile);
    if (configFile.error) {
      return null;
    }

    this.parsedConfig = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      path.dirname(this.configPath)
    );

    return this.parsedConfig;
  }

  private findTsConfig(): string | null {
    if (this.tsconfigPath) {
      return fs.existsSync(this.tsconfigPath) ? this.tsconfigPath : null;
    }

    let dir = this.projectRoot;
    const root = path.parse(dir).root;

    while (dir !== root) {
      const tsconfigPath = path.join(dir, 'tsconfig.json');
      if (fs.existsSync(tsconfigPath)) {
        return tsconfigPath;
      }
      dir = path.dirname(dir);
    }

    return null;
  }

  getCompilationSettings(): ts.CompilerOptions {
    const config = this.ensureConfig();
    return config?.options ?? {};
  }

  getScriptFileNames(): string[] {
    const config = this.ensureConfig();
    return config?.fileNames ?? [];
  }

  getScriptVersion(fileName: string): string {
    return String(this.fileVersions.get(fileName) ?? 0);
  }

  getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
    // Check our cache first
    const cached = this.fileSnapshots.get(fileName);
    if (cached) {
      return cached;
    }

    // Read from disk
    if (!fs.existsSync(fileName)) {
      return undefined;
    }

    const content = fs.readFileSync(fileName, 'utf-8');
    const snapshot = ts.ScriptSnapshot.fromString(content);
    this.fileSnapshots.set(fileName, snapshot);
    return snapshot;
  }

  getCurrentDirectory(): string {
    return this.projectRoot;
  }

  getDefaultLibFileName(options: ts.CompilerOptions): string {
    return ts.getDefaultLibFilePath(options);
  }

  fileExists(fileName: string): boolean {
    return ts.sys.fileExists(fileName);
  }

  readFile(fileName: string): string | undefined {
    return ts.sys.readFile(fileName);
  }

  readDirectory(
    path: string,
    extensions?: readonly string[],
    exclude?: readonly string[],
    include?: readonly string[],
    depth?: number
  ): string[] {
    return ts.sys.readDirectory(path, extensions, exclude, include, depth);
  }

  directoryExists(directoryName: string): boolean {
    return ts.sys.directoryExists(directoryName);
  }

  getDirectories(directoryName: string): string[] {
    return ts.sys.getDirectories(directoryName);
  }

  /**
   * Update a file's content in the cache.
   * This triggers incremental re-analysis on next type query.
   */
  updateFile(fileName: string, content: string): void {
    const version = (this.fileVersions.get(fileName) ?? 0) + 1;
    this.fileVersions.set(fileName, version);
    this.fileSnapshots.set(fileName, ts.ScriptSnapshot.fromString(content));
  }

  /**
   * Clear a file from the cache (e.g., when file is deleted)
   */
  removeFile(fileName: string): void {
    this.fileVersions.delete(fileName);
    this.fileSnapshots.delete(fileName);
  }

  /**
   * Check if configuration was successfully loaded
   */
  hasValidConfig(): boolean {
    return this.ensureConfig() !== null;
  }

  /**
   * Get the config path (for error messages)
   */
  getConfigPath(): string | null {
    this.ensureConfig();
    return this.configPath;
  }
}

/**
 * TypeScript-based type checker for enhanced stability detection.
 *
 * Uses TRUE lazy loading: the TypeScript Language Service is only initialized
 * when a type query is actually made, not when the TypeChecker is constructed.
 * This dramatically improves startup time when strict mode is enabled but
 * no type queries are needed (e.g., files that don't have complex patterns).
 */
export class TypeChecker {
  private languageService: ts.LanguageService | null = null;
  private languageServiceHost: LazyLanguageServiceHost | null = null;
  private options: TypeCheckerOptions;
  private typeCache: Map<string, TypeInfo> = new Map();
  private sourceFileCache: Map<string, ts.SourceFile> = new Map();
  private initAttempted = false;
  private initError: Error | null = null;

  constructor(options: TypeCheckerOptions) {
    this.options = options;
  }

  /**
   * Ensure the Language Service is initialized.
   * This is called lazily on first type query, not during construction.
   * Returns true if initialization succeeded.
   */
  private ensureInitialized(): boolean {
    if (this.languageService !== null) {
      return true;
    }

    // If we have a valid host from initialize(), create the language service now
    if (this.languageServiceHost !== null) {
      try {
        this.languageService = ts.createLanguageService(
          this.languageServiceHost,
          ts.createDocumentRegistry()
        );
        return true;
      } catch (error) {
        this.initError = error instanceof Error ? error : new Error(String(error));
        return false;
      }
    }

    // If init was already attempted and we don't have a host, it failed
    if (this.initAttempted) {
      return false;
    }

    // First time - do full initialization
    this.initAttempted = true;

    try {
      this.languageServiceHost = new LazyLanguageServiceHost(
        this.options.projectRoot,
        this.options.tsconfigPath
      );

      if (!this.languageServiceHost.hasValidConfig()) {
        this.initError = new Error(
          'No tsconfig.json found. TypeScript strict mode requires a TypeScript project.'
        );
        this.languageServiceHost = null;
        return false;
      }

      // Create the Language Service (this is lightweight - actual parsing is deferred)
      this.languageService = ts.createLanguageService(
        this.languageServiceHost,
        ts.createDocumentRegistry()
      );

      return true;
    } catch (error) {
      this.initError = error instanceof Error ? error : new Error(String(error));
      return false;
    }
  }

  /**
   * Initialize the TypeScript program and type checker.
   * For backwards compatibility - validates config but defers Language Service creation.
   * The Language Service is created lazily on first type query.
   */
  initialize(): boolean {
    // If already fully initialized, return success
    if (this.languageService !== null) {
      return true;
    }

    // If we already have a host, config is valid - language service will be created on demand
    if (this.languageServiceHost !== null) {
      return true;
    }

    // If init was already attempted and failed (no host), return false
    if (this.initAttempted) {
      return false;
    }

    this.initAttempted = true;

    try {
      this.languageServiceHost = new LazyLanguageServiceHost(
        this.options.projectRoot,
        this.options.tsconfigPath
      );

      if (!this.languageServiceHost.hasValidConfig()) {
        this.initError = new Error(
          'No tsconfig.json found. TypeScript strict mode requires a TypeScript project.'
        );
        this.languageServiceHost = null;
        return false;
      }

      // DON'T create the language service yet - defer until first query
      // This is the key optimization: we validate config but don't load the program
      return true;
    } catch (error) {
      this.initError = error instanceof Error ? error : new Error(String(error));
      return false;
    }
  }

  /**
   * Get initialization error if any
   */
  getInitError(): Error | null {
    return this.initError;
  }

  /**
   * Update file content for incremental analysis.
   * Call this when a file changes to enable efficient re-analysis.
   */
  updateFile(filePath: string, content: string): void {
    if (this.languageServiceHost) {
      this.languageServiceHost.updateFile(filePath, content);
    }

    // Invalidate caches for this file
    this.sourceFileCache.delete(filePath);

    // Clear type cache entries for this file
    const keysToDelete: string[] = [];
    for (const key of this.typeCache.keys()) {
      if (key.startsWith(filePath + ':')) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.typeCache.delete(key);
    }
  }

  /**
   * Remove a file from the cache (e.g., when deleted)
   */
  removeFile(filePath: string): void {
    if (this.languageServiceHost) {
      this.languageServiceHost.removeFile(filePath);
    }
    this.sourceFileCache.delete(filePath);

    // Clear type cache entries for this file
    const keysToDelete: string[] = [];
    for (const key of this.typeCache.keys()) {
      if (key.startsWith(filePath + ':')) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.typeCache.delete(key);
    }
  }

  /**
   * Get the TypeScript type checker (for internal use).
   * Lazily initializes the language service if needed.
   */
  private getChecker(): ts.TypeChecker | null {
    if (!this.ensureInitialized()) {
      return null;
    }

    // After ensureInitialized() succeeds, languageService is guaranteed to be set
    const program = this.languageService!.getProgram();
    return program?.getTypeChecker() ?? null;
  }

  /**
   * Get the current program (for internal use).
   * Lazily initializes the language service if needed.
   */
  private getProgram(): ts.Program | null {
    if (!this.ensureInitialized()) {
      return null;
    }

    // After ensureInitialized() succeeds, languageService is guaranteed to be set
    return this.languageService!.getProgram() ?? null;
  }

  /**
   * Get source file for a given path
   */
  private getSourceFile(filePath: string): ts.SourceFile | undefined {
    if (this.sourceFileCache.has(filePath)) {
      return this.sourceFileCache.get(filePath);
    }

    const program = this.getProgram();
    const sourceFile = program?.getSourceFile(filePath);
    if (sourceFile) {
      this.sourceFileCache.set(filePath, sourceFile);
    }
    return sourceFile;
  }

  /**
   * Analyze a variable's type at a specific location
   */
  getTypeAtLocation(filePath: string, line: number, variableName: string): TypeInfo | null {
    const checker = this.getChecker();
    const program = this.getProgram();
    if (!checker || !program) {
      return null;
    }

    const cacheKey = `${filePath}:${line}:${variableName}`;
    if (this.options.cacheTypes && this.typeCache.has(cacheKey)) {
      return this.typeCache.get(cacheKey)!;
    }

    const sourceFile = this.getSourceFile(filePath);
    if (!sourceFile) {
      return null;
    }

    // Find the node at the given line
    const node = this.findNodeAtLine(sourceFile, line, variableName);
    if (!node) {
      return null;
    }

    const type = checker.getTypeAtLocation(node);
    const typeInfo = this.analyzeType(type, checker);

    if (this.options.cacheTypes) {
      this.typeCache.set(cacheKey, typeInfo);
    }

    return typeInfo;
  }

  /**
   * Get return type of a function call
   */
  getFunctionReturnType(
    filePath: string,
    line: number,
    functionName: string
  ): FunctionReturnInfo | null {
    const checker = this.getChecker();
    const program = this.getProgram();
    if (!checker || !program) {
      return null;
    }

    const sourceFile = this.getSourceFile(filePath);
    if (!sourceFile) {
      return null;
    }

    // Find the call expression at the given line
    const callNode = this.findCallExpressionAtLine(sourceFile, line, functionName);
    if (!callNode) {
      return null;
    }

    const signature = checker.getResolvedSignature(callNode);
    if (!signature) {
      return null;
    }

    const returnType = checker.getReturnTypeOfSignature(signature);
    const typeInfo = this.analyzeType(returnType, checker);

    return {
      returnType: typeInfo,
      isStableReturn: typeInfo.isStable,
    };
  }

  /**
   * Check if a type is considered stable
   */
  isTypeStable(filePath: string, line: number, variableName: string): boolean {
    const typeInfo = this.getTypeAtLocation(filePath, line, variableName);
    return typeInfo?.isStable ?? false;
  }

  /**
   * Analyze a TypeScript type and determine if it's stable
   */
  private analyzeType(type: ts.Type, checker: ts.TypeChecker): TypeInfo {
    const typeString = checker.typeToString(type);

    // Check for primitive types
    if (this.isPrimitiveType(type)) {
      return {
        isStable: true,
        typeString,
        reason: 'Primitive types are compared by value, not reference',
        isPrimitive: true,
        isReadonly: false,
        isConstAssertion: false,
      };
    }

    // Check for literal types (e.g., 'foo', 123, true)
    if (type.isLiteral()) {
      return {
        isStable: true,
        typeString,
        reason: 'Literal types are immutable',
        isPrimitive: true,
        isReadonly: false,
        isConstAssertion: false,
      };
    }

    // Check for readonly array or tuple
    if (this.isReadonlyArray(typeString)) {
      return {
        isStable: true,
        typeString,
        reason: 'Readonly arrays are considered stable',
        isPrimitive: false,
        isReadonly: true,
        isConstAssertion: false,
      };
    }

    // Check for Readonly<T> wrapper
    if (this.hasReadonlyModifier(typeString)) {
      return {
        isStable: true,
        typeString,
        reason: 'Type has Readonly modifier',
        isPrimitive: false,
        isReadonly: true,
        isConstAssertion: false,
      };
    }

    // Check for 'as const' assertion (frozen object/array)
    if (this.isConstAssertion(type)) {
      return {
        isStable: true,
        typeString,
        reason: 'Type uses as const assertion (frozen)',
        isPrimitive: false,
        isReadonly: true,
        isConstAssertion: true,
      };
    }

    // Check for function types - they're stable if defined once
    if (type.getCallSignatures().length > 0 && !this.isUnionOrIntersection(type)) {
      // Function type - depends on how it's defined
      // If it's a type reference (not inline), it's likely stable
      if (type.aliasSymbol) {
        return {
          isStable: true,
          typeString,
          reason: 'Named function type is stable',
          isPrimitive: false,
          isReadonly: false,
          isConstAssertion: false,
        };
      }
    }

    // Check for React.RefObject or MutableRefObject
    if (this.isReactRef(typeString)) {
      return {
        isStable: true,
        typeString,
        reason: 'React ref objects are stable across renders',
        isPrimitive: false,
        isReadonly: false,
        isConstAssertion: false,
      };
    }

    // Check for React.Dispatch (setState function)
    if (this.isReactDispatch(typeString)) {
      return {
        isStable: true,
        typeString,
        reason: 'React state setters are stable across renders',
        isPrimitive: false,
        isReadonly: false,
        isConstAssertion: false,
      };
    }

    // Default: objects and arrays are unstable
    if (this.isObjectOrArrayType(type)) {
      return {
        isStable: false,
        typeString,
        reason: 'Object/array types create new references on each render',
        isPrimitive: false,
        isReadonly: false,
        isConstAssertion: false,
      };
    }

    // Unknown type - assume unstable for safety
    return {
      isStable: false,
      typeString,
      reason: 'Unknown type - assuming unstable for safety',
      isPrimitive: false,
      isReadonly: false,
      isConstAssertion: false,
    };
  }

  /**
   * Check if type is a primitive (string, number, boolean, null, undefined, symbol, bigint)
   */
  private isPrimitiveType(type: ts.Type): boolean {
    const flags = type.flags;
    return !!(
      flags & ts.TypeFlags.String ||
      flags & ts.TypeFlags.Number ||
      flags & ts.TypeFlags.Boolean ||
      flags & ts.TypeFlags.Null ||
      flags & ts.TypeFlags.Undefined ||
      flags & ts.TypeFlags.ESSymbol ||
      flags & ts.TypeFlags.BigInt ||
      flags & ts.TypeFlags.Void ||
      flags & ts.TypeFlags.StringLiteral ||
      flags & ts.TypeFlags.NumberLiteral ||
      flags & ts.TypeFlags.BooleanLiteral
    );
  }

  /**
   * Check if type is a readonly array (based on type string)
   */
  private isReadonlyArray(typeString: string): boolean {
    return (
      typeString.startsWith('readonly ') ||
      typeString.startsWith('ReadonlyArray<') ||
      typeString.includes('readonly [')
    );
  }

  /**
   * Check if type has Readonly<T> wrapper (based on type string)
   */
  private hasReadonlyModifier(typeString: string): boolean {
    return typeString.startsWith('Readonly<');
  }

  /**
   * Check if type is from 'as const' assertion
   */
  private isConstAssertion(type: ts.Type): boolean {
    // Check if all properties are readonly
    const props = type.getProperties();
    if (props.length === 0) return false;

    for (const prop of props) {
      const declarations = prop.getDeclarations();
      if (declarations && declarations.length > 0) {
        const decl = declarations[0];
        if (ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl)) {
          const modifiers = ts.getModifiers(decl);
          const hasReadonly = modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword);
          if (!hasReadonly) {
            return false;
          }
        }
      }
    }

    return props.length > 0;
  }

  /**
   * Check if type is React.RefObject or React.MutableRefObject (based on type string)
   */
  private isReactRef(typeString: string): boolean {
    return (
      typeString.includes('RefObject<') ||
      typeString.includes('MutableRefObject<') ||
      typeString.includes('React.RefObject<') ||
      typeString.includes('React.MutableRefObject<')
    );
  }

  /**
   * Check if type is React.Dispatch (setState function type) (based on type string)
   */
  private isReactDispatch(typeString: string): boolean {
    return (
      typeString.includes('Dispatch<') ||
      typeString.includes('React.Dispatch<') ||
      typeString.includes('SetStateAction<')
    );
  }

  /**
   * Check if type is a union or intersection
   */
  private isUnionOrIntersection(type: ts.Type): boolean {
    return !!(type.flags & ts.TypeFlags.Union || type.flags & ts.TypeFlags.Intersection);
  }

  /**
   * Check if type is an object or array type
   */
  private isObjectOrArrayType(type: ts.Type): boolean {
    return !!(type.flags & ts.TypeFlags.Object);
  }

  /**
   * Find a node at a specific line with a given name.
   * Finds all matching nodes and returns the most specific one (smallest span).
   */
  private findNodeAtLine(
    sourceFile: ts.SourceFile,
    line: number,
    name: string
  ): ts.Node | undefined {
    const candidates: ts.Node[] = [];

    const visit = (node: ts.Node): void => {
      const nodeStart = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      // TypeScript lines are 0-based, our lines are 1-based
      if (nodeStart.line === line - 1) {
        if (ts.isIdentifier(node) && node.text === name) {
          candidates.push(node);
        } else if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === name
        ) {
          candidates.push(node);
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    // Return the smallest (most specific) matching node
    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0];

    return candidates.reduce((smallest, node) => {
      const smallestSpan = smallest.getEnd() - smallest.getStart();
      const nodeSpan = node.getEnd() - node.getStart();
      return nodeSpan < smallestSpan ? node : smallest;
    });
  }

  /**
   * Find a call expression at a specific line.
   * Finds all matching call expressions and returns the most specific one (smallest span).
   */
  private findCallExpressionAtLine(
    sourceFile: ts.SourceFile,
    line: number,
    functionName: string
  ): ts.CallExpression | undefined {
    const candidates: ts.CallExpression[] = [];

    const visit = (node: ts.Node): void => {
      const nodeStart = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      if (nodeStart.line === line - 1) {
        if (ts.isCallExpression(node)) {
          const calleeText = node.expression.getText(sourceFile);
          if (calleeText === functionName || calleeText.endsWith(`.${functionName}`)) {
            candidates.push(node);
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    // Return the smallest (most specific) matching call expression
    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0];

    return candidates.reduce((smallest, node) => {
      const smallestSpan = smallest.getEnd() - smallest.getStart();
      const nodeSpan = node.getEnd() - node.getStart();
      return nodeSpan < smallestSpan ? node : smallest;
    });
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.typeCache.clear();
    this.sourceFileCache.clear();
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.clearCache();
    if (this.languageService) {
      this.languageService.dispose();
      this.languageService = null;
    }
    this.languageServiceHost = null;
    this.initAttempted = false;
    this.initError = null;
  }

  /**
   * Check if the TypeChecker has been initialized (language service created).
   * Useful for performance monitoring.
   */
  isInitialized(): boolean {
    return this.languageService !== null;
  }

  /**
   * Check if initialization was attempted (even if it failed).
   * Useful for debugging.
   */
  wasInitAttempted(): boolean {
    return this.initAttempted;
  }
}

/**
 * Create a type checker instance for a project
 */
export function createTypeChecker(options: TypeCheckerOptions): TypeChecker {
  return new TypeChecker(options);
}

/**
 * Singleton map for persistent TypeChecker instances per project.
 * Used by the VS Code extension to persist the TypeChecker across analyses.
 */
const persistentTypeCheckers = new Map<string, TypeChecker>();

/**
 * Get or create a persistent TypeChecker instance for a project.
 * This is used by the VS Code extension to maintain the TypeChecker across
 * file changes, enabling efficient incremental updates instead of recreating
 * the entire TypeScript program for each analysis.
 *
 * @param options - TypeChecker options
 * @returns A persistent TypeChecker instance for the project
 */
export function getPersistentTypeChecker(options: TypeCheckerOptions): TypeChecker {
  const key = options.tsconfigPath ?? options.projectRoot;

  let checker = persistentTypeCheckers.get(key);
  if (!checker) {
    checker = new TypeChecker(options);
    persistentTypeCheckers.set(key, checker);
  }

  return checker;
}

/**
 * Dispose and remove a persistent TypeChecker instance.
 * Call this when a workspace is closed or the extension is deactivated.
 *
 * @param projectRoot - The project root to dispose the TypeChecker for
 */
export function disposePersistentTypeChecker(projectRoot: string): void {
  const checker = persistentTypeCheckers.get(projectRoot);
  if (checker) {
    checker.dispose();
    persistentTypeCheckers.delete(projectRoot);
  }
}

/**
 * Dispose all persistent TypeChecker instances.
 * Call this when the extension is fully deactivated.
 */
export function disposeAllPersistentTypeCheckers(): void {
  for (const checker of persistentTypeCheckers.values()) {
    checker.dispose();
  }
  persistentTypeCheckers.clear();
}

/**
 * Check if TypeScript strict mode is available for a project
 */
export function isTypeScriptProject(projectRoot: string): boolean {
  // Check for tsconfig.json
  let dir = projectRoot;
  const root = path.parse(dir).root;

  while (dir !== root) {
    if (fs.existsSync(path.join(dir, 'tsconfig.json'))) {
      return true;
    }
    dir = path.dirname(dir);
  }

  return false;
}

/**
 * TypeChecker Pool for Monorepo Support
 *
 * Manages multiple TypeChecker instances, one per tsconfig.json.
 * Uses lazy loading - only creates TypeChecker instances when files
 * from that tsconfig are first queried.
 *
 * This enables efficient type checking in monorepos where different
 * packages have their own tsconfig files with different settings.
 */
export class TypeCheckerPool {
  private checkers = new Map<string, TypeChecker>();
  private tsconfigManager: TsconfigManager;
  private workspaceRoot: string;
  private initErrors = new Map<string, Error>();

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.tsconfigManager = createTsconfigManager(workspaceRoot);
  }

  /**
   * Get the TypeChecker instance for a specific file.
   * Lazily creates the TypeChecker if it doesn't exist yet.
   *
   * @param filePath - The source file to get a TypeChecker for
   * @returns TypeChecker instance, or null if no tsconfig covers this file
   */
  getCheckerForFile(filePath: string): TypeChecker | null {
    const tsconfig = this.tsconfigManager.getTsconfigForFile(filePath);
    if (!tsconfig) {
      return null;
    }

    return this.getCheckerForTsconfig(tsconfig.path);
  }

  /**
   * Get or create a TypeChecker for a specific tsconfig.
   */
  private getCheckerForTsconfig(tsconfigPath: string): TypeChecker | null {
    // Check if we already have a checker for this tsconfig
    if (this.checkers.has(tsconfigPath)) {
      return this.checkers.get(tsconfigPath)!;
    }

    // Check if we've already tried and failed to create a checker
    if (this.initErrors.has(tsconfigPath)) {
      return null;
    }

    // Create a new TypeChecker for this tsconfig
    try {
      const checker = new TypeChecker({
        projectRoot: path.dirname(tsconfigPath),
        tsconfigPath: tsconfigPath,
        cacheTypes: true,
      });

      if (checker.initialize()) {
        this.checkers.set(tsconfigPath, checker);
        return checker;
      } else {
        const error = checker.getInitError();
        if (error) {
          this.initErrors.set(tsconfigPath, error);
        }
        return null;
      }
    } catch (error) {
      this.initErrors.set(tsconfigPath, error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }

  /**
   * Update a file's content in the appropriate TypeChecker.
   * Routes the update to the correct TypeChecker based on the file's tsconfig.
   *
   * @param filePath - The file that was updated
   * @param content - The new content of the file
   */
  updateFile(filePath: string, content: string): void {
    const tsconfig = this.tsconfigManager.getTsconfigForFile(filePath);
    if (tsconfig && this.checkers.has(tsconfig.path)) {
      this.checkers.get(tsconfig.path)!.updateFile(filePath, content);
    }
  }

  /**
   * Remove a file from the appropriate TypeChecker.
   *
   * @param filePath - The file that was deleted
   */
  removeFile(filePath: string): void {
    const tsconfig = this.tsconfigManager.getTsconfigForFile(filePath);
    if (tsconfig && this.checkers.has(tsconfig.path)) {
      this.checkers.get(tsconfig.path)!.removeFile(filePath);
    }
  }

  /**
   * Get the TsconfigManager for workspace package resolution.
   */
  getTsconfigManager(): TsconfigManager {
    return this.tsconfigManager;
  }

  /**
   * Check if the workspace is a monorepo.
   */
  isMonorepo(): boolean {
    return this.tsconfigManager.isMonorepo();
  }

  /**
   * Get the number of TypeChecker instances currently loaded.
   * Useful for monitoring and debugging.
   */
  getLoadedCheckerCount(): number {
    return this.checkers.size;
  }

  /**
   * Get all tsconfig paths that have TypeCheckers loaded.
   */
  getLoadedTsconfigPaths(): string[] {
    return Array.from(this.checkers.keys());
  }

  /**
   * Clear the cache for a specific tsconfig.
   * The TypeChecker will be recreated on next access.
   */
  invalidateTsconfig(tsconfigPath: string): void {
    const absolutePath = path.resolve(tsconfigPath);
    const checker = this.checkers.get(absolutePath);
    if (checker) {
      checker.dispose();
      this.checkers.delete(absolutePath);
    }
    this.initErrors.delete(absolutePath);
    this.tsconfigManager.invalidateTsconfig(absolutePath);
  }

  /**
   * Dispose all TypeChecker instances and clear caches.
   */
  dispose(): void {
    for (const checker of this.checkers.values()) {
      checker.dispose();
    }
    this.checkers.clear();
    this.initErrors.clear();
    this.tsconfigManager.clearCache();
  }
}

/**
 * Singleton map for persistent TypeCheckerPool instances per workspace.
 * Used by the VS Code extension to persist the pool across analyses.
 */
const persistentPools = new Map<string, TypeCheckerPool>();

/**
 * Get or create a persistent TypeCheckerPool for a workspace.
 * This is used by the VS Code extension to maintain the pool across
 * file changes, enabling efficient incremental updates.
 *
 * @param workspaceRoot - The root directory of the workspace
 * @returns A persistent TypeCheckerPool instance for the workspace
 */
export function getPersistentTypeCheckerPool(workspaceRoot: string): TypeCheckerPool {
  const normalizedRoot = path.resolve(workspaceRoot);

  let pool = persistentPools.get(normalizedRoot);
  if (!pool) {
    pool = new TypeCheckerPool(normalizedRoot);
    persistentPools.set(normalizedRoot, pool);
  }

  return pool;
}

/**
 * Dispose and remove a persistent TypeCheckerPool.
 * Call this when a workspace is closed.
 *
 * @param workspaceRoot - The workspace root to dispose the pool for
 */
export function disposePersistentTypeCheckerPool(workspaceRoot: string): void {
  const normalizedRoot = path.resolve(workspaceRoot);
  const pool = persistentPools.get(normalizedRoot);
  if (pool) {
    pool.dispose();
    persistentPools.delete(normalizedRoot);
  }
}

/**
 * Dispose all persistent TypeCheckerPool instances.
 * Call this when the extension is fully deactivated.
 */
export function disposeAllPersistentTypeCheckerPools(): void {
  for (const pool of persistentPools.values()) {
    pool.dispose();
  }
  persistentPools.clear();
}
