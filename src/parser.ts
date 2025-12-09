import * as parser from '@babel/parser';
import traverse, { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import * as fs from 'fs';
import { AstCache, CacheableParsedData } from './cache';
import { isMemoCallExpression } from './utils';

export interface HookInfo {
  name: string;
  dependencies: string[];
  line: number;
  column: number;
  file: string;
}

export interface ImportInfo {
  source: string;
  imports: string[];
  isDefaultImport: boolean;
  isNamespaceImport: boolean;
  line: number;
}

export interface ExportInfo {
  name: string;
  isDefault: boolean;
  line: number;
  /** True if the export is wrapped with React.memo() or memo() */
  isMemoized?: boolean;
}

export interface ParsedFile {
  file: string;
  hooks: HookInfo[];
  variables: Map<string, Set<string>>;
  imports: ImportInfo[];
  exports: ExportInfo[];
  functions: Set<string>;
  contexts: Set<string>;
  ast: t.File; // Store the parsed AST to avoid re-parsing
  content: string; // Store file content for comment analysis
}

const REACT_HOOKS = [
  'useEffect',
  'useLayoutEffect',
  'useMemo',
  'useCallback',
  'useImperativeHandle',
];

export function parseFile(filePath: string): ParsedFile {
  const content = fs.readFileSync(filePath, 'utf-8');
  const ast = parser.parse(content, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'],
  });

  const hooks: HookInfo[] = [];
  const variables = new Map<string, Set<string>>();
  const imports: ImportInfo[] = [];
  const exports: ExportInfo[] = [];
  const functions = new Set<string>();
  const contexts = new Set<string>();
  // Track components wrapped with memo() or React.memo()
  const memoizedComponents = new Set<string>();

  traverse(ast, {
    ImportDeclaration(path: NodePath<t.ImportDeclaration>) {
      const importInfo = extractImportInfo(path);
      if (importInfo) {
        imports.push(importInfo);
      }
    },

    ExportNamedDeclaration(path: NodePath<t.ExportNamedDeclaration>) {
      const exportInfos = extractNamedExports(path, memoizedComponents);
      exports.push(...exportInfos);
    },

    ExportDefaultDeclaration(path: NodePath<t.ExportDefaultDeclaration>) {
      const exportInfo = extractDefaultExport(path, memoizedComponents);
      if (exportInfo) {
        exports.push(exportInfo);
      }
    },

    CallExpression(path: NodePath<t.CallExpression>) {
      const callee = path.node.callee;

      if (t.isIdentifier(callee) && REACT_HOOKS.includes(callee.name)) {
        const hookInfo = extractHookInfo(path, callee.name, filePath);
        if (hookInfo) {
          hooks.push(hookInfo);
        }
      }

      // Detect React.createContext calls
      if (
        t.isMemberExpression(callee) &&
        t.isIdentifier(callee.object) &&
        callee.object.name === 'React' &&
        t.isIdentifier(callee.property) &&
        callee.property.name === 'createContext'
      ) {
        const parent = path.parent;
        if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) {
          contexts.add(parent.id.name);
        }
      }

      // Detect memo() and React.memo() calls
      if (isMemoCallExpression(path.node)) {
        const parent = path.parent;
        if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) {
          memoizedComponents.add(parent.id.name);
        }
      }
    },

    VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
      if (t.isIdentifier(path.node.id)) {
        const varName = path.node.id.name;
        const deps = extractVariableDependencies(path.node.init);
        if (deps.size > 0) {
          variables.set(varName, deps);
        }
      }
    },

    FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
      if (path.node.id) {
        functions.add(path.node.id.name);
      }
    },

    ArrowFunctionExpression(path: NodePath<t.ArrowFunctionExpression>) {
      const parent = path.parent;
      if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) {
        functions.add(parent.id.name);
      }
    },
  });

  return { file: filePath, hooks, variables, imports, exports, functions, contexts, ast, content };
}

/**
 * Parse file with caching support for improved performance
 * @param filePath Path to the file
 * @param cache Optional cache instance for storing/retrieving parsed data
 */
export function parseFileWithCache(filePath: string, cache?: AstCache): ParsedFile {
  // Try to get cached data
  if (cache) {
    const cached = cache.get(filePath);
    if (cached) {
      // Reconstruct ParsedFile from cached data
      // We still need to parse the AST for hooks analysis, but we can skip expensive traversals
      const content = fs.readFileSync(filePath, 'utf-8');
      const ast = parser.parse(content, {
        sourceType: 'module',
        plugins: ['jsx', 'typescript'],
      });

      // Convert cached variables back to Map<string, Set<string>>
      const variables = new Map<string, Set<string>>();
      for (const [key, values] of cached.variables) {
        variables.set(key, new Set(values));
      }

      return {
        file: filePath,
        hooks: cached.hooks,
        variables,
        imports: cached.imports,
        exports: cached.exports,
        functions: new Set(cached.functions),
        contexts: new Set(cached.contexts),
        ast,
        content,
      };
    }
  }

  // Parse file normally
  const result = parseFile(filePath);

  // Cache the result
  if (cache) {
    const cacheableData: CacheableParsedData = {
      hooks: result.hooks,
      imports: result.imports,
      exports: result.exports,
      functions: Array.from(result.functions),
      contexts: Array.from(result.contexts),
      variables: Array.from(result.variables.entries()).map(([k, v]) => [k, Array.from(v)]),
    };
    cache.set(filePath, cacheableData);
  }

  return result;
}

function extractHookInfo(
  path: NodePath<t.CallExpression>,
  hookName: string,
  filePath: string
): HookInfo | null {
  const args = path.node.arguments;
  let depsArray: t.ArrayExpression | null = null;

  if (hookName === 'useEffect' || hookName === 'useLayoutEffect') {
    if (args.length >= 2 && t.isArrayExpression(args[1])) {
      depsArray = args[1] as t.ArrayExpression;
    }
  } else if (hookName === 'useMemo' || hookName === 'useCallback') {
    if (args.length >= 2 && t.isArrayExpression(args[1])) {
      depsArray = args[1] as t.ArrayExpression;
    }
  } else if (hookName === 'useImperativeHandle') {
    if (args.length >= 3 && t.isArrayExpression(args[2])) {
      depsArray = args[2] as t.ArrayExpression;
    }
  }

  if (!depsArray) {
    return null;
  }

  const dependencies = depsArray.elements
    .filter((el): el is t.Identifier => t.isIdentifier(el))
    .map((el) => el.name);

  const loc = path.node.loc;
  return {
    name: hookName,
    dependencies,
    line: loc?.start.line || 0,
    column: loc?.start.column || 0,
    file: filePath,
  };
}

function extractVariableDependencies(node: t.Node | null | undefined): Set<string> {
  const deps = new Set<string>();

  if (!node) return deps;

  try {
    traverse(node, {
      Identifier(path: NodePath<t.Identifier>) {
        if (!path.isReferencedIdentifier()) return;

        try {
          const binding = path.scope?.getBinding?.(path.node.name);
          // Only include identifiers that are actually function/variable references
          // Skip built-in objects, imports, and React hooks
          if (!binding || binding.scope === path.scope) return;

          const name = path.node.name;

          // Skip React hooks and common imports
          if (name.startsWith('use') && name[3] === name[3].toUpperCase()) return;
          if (['console', 'window', 'document', 'process', 'Buffer'].includes(name)) return;

          // Only include if it looks like a local variable or function
          if (
            binding.kind === 'var' ||
            binding.kind === 'let' ||
            binding.kind === 'const' ||
            binding.kind === 'hoisted'
          ) {
            deps.add(name);
          }
        } catch {
          // Skip identifiers that cause errors
        }
      },
      noScope: true,
    });
  } catch {
    // Skip nodes that cause errors
  }

  return deps;
}

function extractImportInfo(path: NodePath<t.ImportDeclaration>): ImportInfo | null {
  const source = path.node.source.value;
  const loc = path.node.loc;
  const line = loc?.start.line || 0;

  // Skip non-relative imports (external libraries)
  if (!source.startsWith('.') && !source.startsWith('/')) {
    return null;
  }

  const imports: string[] = [];
  let isDefaultImport = false;
  let isNamespaceImport = false;

  path.node.specifiers.forEach((spec) => {
    if (t.isImportDefaultSpecifier(spec)) {
      imports.push(spec.local.name);
      isDefaultImport = true;
    } else if (t.isImportNamespaceSpecifier(spec)) {
      imports.push(spec.local.name);
      isNamespaceImport = true;
    } else if (t.isImportSpecifier(spec)) {
      imports.push(spec.local.name);
    }
  });

  return {
    source,
    imports,
    isDefaultImport,
    isNamespaceImport,
    line,
  };
}

function extractNamedExports(
  path: NodePath<t.ExportNamedDeclaration>,
  memoizedComponents: Set<string>
): ExportInfo[] {
  const exports: ExportInfo[] = [];
  const loc = path.node.loc;
  const line = loc?.start.line || 0;

  if (path.node.declaration) {
    // export const foo = ...
    // export function foo() { ... }
    if (t.isVariableDeclaration(path.node.declaration)) {
      path.node.declaration.declarations.forEach((decl) => {
        if (t.isIdentifier(decl.id)) {
          const name = decl.id.name;
          // Check if this export is a memo-wrapped component
          // Also check if the initializer is a memo() call directly
          const isMemoized = memoizedComponents.has(name) || isMemoCallExpression(decl.init);
          exports.push({
            name,
            isDefault: false,
            line,
            isMemoized: isMemoized || undefined,
          });
        }
      });
    } else if (t.isFunctionDeclaration(path.node.declaration) && path.node.declaration.id) {
      exports.push({
        name: path.node.declaration.id.name,
        isDefault: false,
        line,
      });
    }
  } else if (path.node.specifiers) {
    // export { foo, bar }
    path.node.specifiers.forEach((spec) => {
      if (t.isExportSpecifier(spec)) {
        const localName = spec.local.name;
        const exportedName =
          spec.exported.type === 'Identifier' ? spec.exported.name : spec.exported.value;
        exports.push({
          name: exportedName,
          isDefault: false,
          line,
          isMemoized: memoizedComponents.has(localName) || undefined,
        });
      }
    });
  }

  return exports;
}

function extractDefaultExport(
  path: NodePath<t.ExportDefaultDeclaration>,
  memoizedComponents: Set<string>
): ExportInfo | null {
  const loc = path.node.loc;
  const line = loc?.start.line || 0;

  let name = 'default';
  let isMemoized = false;

  if (t.isFunctionDeclaration(path.node.declaration) && path.node.declaration.id) {
    name = path.node.declaration.id.name;
  } else if (t.isIdentifier(path.node.declaration)) {
    name = path.node.declaration.name;
    // Check if the exported identifier is a memoized component
    isMemoized = memoizedComponents.has(name);
  } else if (isMemoCallExpression(path.node.declaration)) {
    // export default memo(Component) - directly exported memo call
    isMemoized = true;
    // Try to extract name from memo argument
    const memoArg = (path.node.declaration as t.CallExpression).arguments[0];
    if (t.isIdentifier(memoArg)) {
      name = memoArg.name;
    } else if (t.isFunctionExpression(memoArg) && memoArg.id) {
      name = memoArg.id.name;
    }
  }

  return {
    name,
    isDefault: true,
    line,
    isMemoized: isMemoized || undefined,
  };
}
