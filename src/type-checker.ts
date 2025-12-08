/**
 * TypeScript Type Checker Module
 *
 * Provides TypeScript Compiler API integration for enhanced stability detection.
 * This is an optional "strict" mode that uses actual type information instead of
 * heuristics to determine variable stability.
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
 * TypeScript-based type checker for enhanced stability detection
 */
export class TypeChecker {
  private program: ts.Program | null = null;
  private checker: ts.TypeChecker | null = null;
  private options: TypeCheckerOptions;
  private typeCache: Map<string, TypeInfo> = new Map();
  private sourceFileCache: Map<string, ts.SourceFile> = new Map();
  private initialized = false;
  private initError: Error | null = null;

  constructor(options: TypeCheckerOptions) {
    this.options = options;
  }

  /**
   * Initialize the TypeScript program and type checker.
   * This is done lazily to avoid overhead when not using strict mode.
   */
  initialize(): boolean {
    if (this.initialized) {
      return this.program !== null;
    }

    this.initialized = true;

    try {
      const configPath = this.findTsConfig();
      if (!configPath) {
        this.initError = new Error(
          'No tsconfig.json found. TypeScript strict mode requires a TypeScript project.'
        );
        return false;
      }

      const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
      if (configFile.error) {
        this.initError = new Error(
          `Error reading tsconfig.json: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`
        );
        return false;
      }

      const parsedConfig = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        path.dirname(configPath)
      );

      if (parsedConfig.errors.length > 0) {
        const errors = parsedConfig.errors
          .map((e) => ts.flattenDiagnosticMessageText(e.messageText, '\n'))
          .join('\n');
        this.initError = new Error(`Error parsing tsconfig.json: ${errors}`);
        return false;
      }

      // Create the program
      this.program = ts.createProgram({
        rootNames: parsedConfig.fileNames,
        options: parsedConfig.options,
      });

      this.checker = this.program.getTypeChecker();
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
   * Find tsconfig.json in the project
   */
  private findTsConfig(): string | null {
    if (this.options.tsconfigPath) {
      return fs.existsSync(this.options.tsconfigPath) ? this.options.tsconfigPath : null;
    }

    // Search upward from project root
    let dir = this.options.projectRoot;
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

  /**
   * Get source file for a given path
   */
  private getSourceFile(filePath: string): ts.SourceFile | undefined {
    if (this.sourceFileCache.has(filePath)) {
      return this.sourceFileCache.get(filePath);
    }

    const sourceFile = this.program?.getSourceFile(filePath);
    if (sourceFile) {
      this.sourceFileCache.set(filePath, sourceFile);
    }
    return sourceFile;
  }

  /**
   * Analyze a variable's type at a specific location
   */
  getTypeAtLocation(filePath: string, line: number, variableName: string): TypeInfo | null {
    if (!this.checker || !this.program) {
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

    const type = this.checker.getTypeAtLocation(node);
    const typeInfo = this.analyzeType(type);

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
    if (!this.checker || !this.program) {
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

    const signature = this.checker.getResolvedSignature(callNode);
    if (!signature) {
      return null;
    }

    const returnType = this.checker.getReturnTypeOfSignature(signature);
    const typeInfo = this.analyzeType(returnType);

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
  private analyzeType(type: ts.Type): TypeInfo {
    const typeString = this.checker!.typeToString(type);

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
    if (this.isReadonlyArray(type)) {
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
    if (this.hasReadonlyModifier(type)) {
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
    if (this.isReactRef(type)) {
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
    if (this.isReactDispatch(type)) {
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
   * Check if type is a readonly array
   */
  private isReadonlyArray(type: ts.Type): boolean {
    const typeString = this.checker!.typeToString(type);
    return (
      typeString.startsWith('readonly ') ||
      typeString.startsWith('ReadonlyArray<') ||
      typeString.includes('readonly [')
    );
  }

  /**
   * Check if type has Readonly<T> wrapper
   */
  private hasReadonlyModifier(type: ts.Type): boolean {
    const typeString = this.checker!.typeToString(type);
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
   * Check if type is React.RefObject or React.MutableRefObject
   */
  private isReactRef(type: ts.Type): boolean {
    const typeString = this.checker!.typeToString(type);
    return (
      typeString.includes('RefObject<') ||
      typeString.includes('MutableRefObject<') ||
      typeString.includes('React.RefObject<') ||
      typeString.includes('React.MutableRefObject<')
    );
  }

  /**
   * Check if type is React.Dispatch (setState function type)
   */
  private isReactDispatch(type: ts.Type): boolean {
    const typeString = this.checker!.typeToString(type);
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
    this.program = null;
    this.checker = null;
    this.initialized = false;
  }
}

/**
 * Create a type checker instance for a project
 */
export function createTypeChecker(options: TypeCheckerOptions): TypeChecker {
  return new TypeChecker(options);
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
