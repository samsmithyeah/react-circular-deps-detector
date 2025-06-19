import * as parser from '@babel/parser';
import traverse, { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import * as fs from 'fs';

export interface HookInfo {
  name: string;
  dependencies: string[];
  line: number;
  column: number;
  file: string;
}

export interface ParsedFile {
  file: string;
  hooks: HookInfo[];
  variables: Map<string, Set<string>>;
}

const REACT_HOOKS = [
  'useEffect',
  'useLayoutEffect',
  'useMemo',
  'useCallback',
  'useImperativeHandle',
];

export function parseFile(filePath: string): ParsedFile {
  const code = fs.readFileSync(filePath, 'utf-8');
  const ast = parser.parse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'],
  });

  const hooks: HookInfo[] = [];
  const variables = new Map<string, Set<string>>();

  traverse(ast, {
    CallExpression(path: NodePath<t.CallExpression>) {
      const callee = path.node.callee;
      
      if (t.isIdentifier(callee) && REACT_HOOKS.includes(callee.name)) {
        const hookInfo = extractHookInfo(path, callee.name, filePath);
        if (hookInfo) {
          hooks.push(hookInfo);
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
  });

  return { file: filePath, hooks, variables };
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
    .map(el => el.name);

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
          if (!binding || binding.scope === path.scope) return;
          
          deps.add(path.node.name);
        } catch (e) {
          // Skip identifiers that cause errors
        }
      },
      noScope: true,
    });
  } catch (e) {
    // Skip nodes that cause errors
  }

  return deps;
}