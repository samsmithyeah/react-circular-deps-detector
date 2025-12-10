import {
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticTag,
  Range,
  Position,
  CodeAction,
  CodeActionKind,
  TextEdit,
} from 'vscode-languageserver';
import type { HookAnalysis, CrossFileCycle } from 'react-loop-detector';
import { fileUriToPath } from './utils.js';

/**
 * Maximum number of lines to search when looking for the end of a multi-line
 * declaration (e.g., function body, object literal). This is a safety limit
 * to prevent searching the entire file for malformed code.
 */
const MAX_DECLARATION_SEARCH_LINES = 100;

/**
 * Maximum number of lines to search when looking for a complete hook call.
 * Hook calls are typically shorter than function declarations.
 */
const MAX_HOOK_SEARCH_LINES = 50;

/**
 * Information about a variable declaration found in the document
 */
interface VariableDeclaration {
  /** The line number (0-indexed) where the variable is declared */
  line: number;
  /** The end line number (0-indexed) for multi-line declarations */
  endLine: number;
  /** The column where the declaration starts */
  startColumn: number;
  /** The column where the declaration ends */
  endColumn: number;
  /** The full line text */
  lineText: string;
  /** The indentation of the line */
  indent: string;
  /** The variable type (const, let, var, function) */
  declarationType: 'const' | 'let' | 'var' | 'function';
  /** The right-hand side of the assignment (for const/let/var) */
  initializerText?: string;
  /** Start column of the initializer */
  initializerStart?: number;
  /** End column of the initializer */
  initializerEnd?: number;
  /** Whether this is an arrow function or regular function */
  isArrowFunction?: boolean;
  /** Whether this is a function declaration (not expression) */
  isFunctionDeclaration?: boolean;
  /** The function body for function declarations */
  functionBody?: string;
}

/**
 * Maps HookAnalysis results to LSP Diagnostics
 */
export function mapAnalysisToDiagnostics(
  analysis: HookAnalysis[],
  crossFileCycles: CrossFileCycle[],
  fileUri: string
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const filePath = fileUriToPath(fileUri);

  // Map hook analysis issues
  for (const issue of analysis) {
    if (normalizeFilePath(issue.file) !== normalizeFilePath(filePath)) {
      continue;
    }

    const diagnostic = mapIssueToDiagnostic(issue);
    if (diagnostic) {
      diagnostics.push(diagnostic);
    }
  }

  // Map cross-file cycles
  for (const cycle of crossFileCycles) {
    const normalizedFilePath = normalizeFilePath(filePath);
    if (!cycle.files.some((f) => normalizeFilePath(f) === normalizedFilePath)) {
      continue;
    }

    const diagnostic = mapCycleToDiagnostic(cycle, filePath);
    if (diagnostic) {
      diagnostics.push(diagnostic);
    }
  }

  return diagnostics;
}

function mapIssueToDiagnostic(issue: HookAnalysis): Diagnostic {
  const severity = mapSeverity(issue.severity, issue.confidence, issue.category);
  const line = Math.max(0, issue.line - 1); // LSP is 0-indexed
  const column = issue.column ? Math.max(0, issue.column) : 0;

  const range: Range = {
    start: Position.create(line, column),
    end: Position.create(line, column + 100), // Approximate end
  };

  const tags: DiagnosticTag[] = [];
  if (issue.category === 'performance') {
    tags.push(DiagnosticTag.Unnecessary);
  }

  return {
    range,
    severity,
    code: issue.errorCode,
    source: 'react-loop-detector',
    message: formatMessage(issue),
    tags: tags.length > 0 ? tags : undefined,
    data: {
      errorCode: issue.errorCode,
      hookType: issue.hookType,
      problematicDependency: issue.problematicDependency,
      line: issue.line,
      confidence: issue.confidence,
      issueSeverity: issue.severity,
    },
  };
}

function mapCycleToDiagnostic(cycle: CrossFileCycle, currentFile: string): Diagnostic | null {
  // Find the dependency that involves the current file
  const relevantDep = cycle.dependencies.find(
    (dep) =>
      normalizeFilePath(dep.from) === normalizeFilePath(currentFile) ||
      normalizeFilePath(dep.to) === normalizeFilePath(currentFile)
  );

  const line = relevantDep?.line ? Math.max(0, relevantDep.line - 1) : 0;

  const range: Range = {
    start: Position.create(line, 0),
    end: Position.create(line, 100),
  };

  const cycleDescription = cycle.files.map((f) => getFileName(f)).join(' -> ');

  return {
    range,
    severity: DiagnosticSeverity.Warning,
    code: 'RLD-300',
    source: 'react-loop-detector',
    message: `Cross-file circular dependency detected (${cycle.type}): ${cycleDescription}`,
    data: {
      errorCode: 'RLD-300',
      cycleType: cycle.type,
      files: cycle.files,
      issueSeverity: 'high' as const,
      confidence: 'high' as const,
    },
  };
}

/**
 * Map issue severity and confidence to VS Code DiagnosticSeverity.
 *
 * The key principle: Only show red errors (Error) for issues that WILL crash the browser.
 * If the tool isn't certain, downgrade to Warning or Hint to reduce alert fatigue.
 *
 * Mapping:
 * - Critical + High confidence → Error (red squiggly) - guaranteed crash
 * - Critical + Medium confidence → Warning (yellow) - likely crash but uncertain
 * - Critical + Low confidence → Warning (yellow) - possible crash but uncertain
 * - High severity + Low/Medium confidence → Warning (yellow)
 * - Medium confidence (any severity) → Warning (yellow)
 * - Low confidence → Hint (dots) - uncertain, needs manual review
 * - Performance issues → Information (blue) with Unnecessary tag
 */
function mapSeverity(
  severity: 'high' | 'medium' | 'low',
  confidence: 'high' | 'medium' | 'low',
  category: string
): DiagnosticSeverity {
  // Only critical issues with HIGH confidence should be errors (red squiggly)
  // This is the "golden rule": if we show Error, the browser MUST crash
  if (category === 'critical' && confidence === 'high') {
    return DiagnosticSeverity.Error;
  }

  // Low confidence issues should be Hints (dots, non-intrusive)
  // These need manual review - we're not sure enough to warn strongly
  if (confidence === 'low') {
    return DiagnosticSeverity.Hint;
  }

  // Medium confidence or critical with non-high confidence → Warning
  // We're fairly sure but not certain enough for an error
  if (confidence === 'medium' || category === 'critical') {
    return DiagnosticSeverity.Warning;
  }

  // High confidence, non-critical issues: map by severity
  // Note: Even high severity non-critical issues should NOT be Error (red)
  // because the "golden rule" says Error = guaranteed crash, and non-critical
  // issues (performance, warnings) don't crash the browser
  switch (severity) {
    case 'high':
      return DiagnosticSeverity.Warning;
    case 'medium':
      return DiagnosticSeverity.Warning;
    case 'low':
      return DiagnosticSeverity.Information;
    default:
      return DiagnosticSeverity.Warning;
  }
}

function formatMessage(issue: HookAnalysis): string {
  // Use the explanation from the analysis
  let message = issue.explanation;

  // Add the suggestion if available - this makes the message actionable
  if (issue.suggestion) {
    message += `\n\n💡 Fix: ${issue.suggestion}`;
  }

  return message;
}

function normalizeFilePath(filePath: string): string {
  // Normalize path separators (keep case-sensitive for Linux compatibility)
  return filePath.replace(/\\/g, '/');
}

function getFileName(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || filePath;
}

/**
 * Extract the initializer expression from the rest of a line after "varName = ".
 * Handles multi-variable declarations like "const a = {}, b = [];" by stopping
 * at a top-level comma (outside of balanced brackets).
 */
function extractInitializerFromRest(restOfLine: string): string | null {
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let inTemplate = false;
  let templateDepth = 0;

  for (let i = 0; i < restOfLine.length; i++) {
    const char = restOfLine[i];
    const prevChar = i > 0 ? restOfLine[i - 1] : '';
    const nextChar = i < restOfLine.length - 1 ? restOfLine[i + 1] : '';

    // Skip comments
    if (!inString && !inTemplate) {
      if (char === '/' && nextChar === '/') {
        // Rest of line is a comment, return what we have
        return restOfLine.substring(0, i).trimEnd();
      }
      if (char === '/' && nextChar === '*') {
        // Block comment - skip to end
        const endIdx = restOfLine.indexOf('*/', i + 2);
        if (endIdx === -1) {
          return restOfLine.substring(0, i).trimEnd();
        }
        i = endIdx + 1;
        continue;
      }
    }

    // Handle string escapes
    if (prevChar === '\\' && (inString || inTemplate)) continue;

    // Handle strings
    if ((char === '"' || char === "'") && !inTemplate) {
      if (inString && stringChar === char) {
        inString = false;
      } else if (!inString) {
        inString = true;
        stringChar = char;
      }
      continue;
    }

    // Handle template literals
    if (char === '`') {
      if (inTemplate && templateDepth === 0) {
        inTemplate = false;
      } else if (!inString) {
        inTemplate = true;
      }
      continue;
    }

    if (inString) continue;

    // Handle ${} in templates
    if (inTemplate && char === '$' && nextChar === '{') {
      templateDepth++;
      i++;
      continue;
    }
    if (inTemplate && char === '}' && templateDepth > 0) {
      templateDepth--;
      continue;
    }

    // Track brackets
    if (char === '(' || char === '[' || char === '{') {
      depth++;
    } else if (char === ')' || char === ']' || char === '}') {
      depth--;
    }

    // At top level, comma or semicolon ends this initializer
    if (depth === 0 && (char === ',' || char === ';')) {
      return restOfLine.substring(0, i).trimEnd();
    }
  }

  // No comma/semicolon found, return the whole rest (trimmed)
  return restOfLine.trimEnd();
}

/**
 * Find the start line of the React component/function that contains the given line.
 * Returns the line number where the component function starts, or 0 if not found.
 * This is used to constrain variable searches to within the component scope,
 * preventing us from wrapping module-scope variables with hooks (which violates Rules of Hooks).
 */
function findComponentScopeStart(documentText: string, atLine: number): number {
  const lines = documentText.split('\n');

  // Track brace depth to find function boundaries
  let braceDepth = 0;
  let inComponent = false;
  let componentStartLine = 0;

  // First pass: scan forward from the start to find which function contains atLine
  for (let i = 0; i <= atLine && i < lines.length; i++) {
    const line = lines[i];

    // Check if this line starts a function (component candidate)
    // Match: function ComponentName, const ComponentName = function, const ComponentName = (
    // or arrow function definitions
    const isFunctionStart =
      /^\s*(export\s+)?(default\s+)?function\s+\w+/.test(line) ||
      /^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(function|\([^)]*\)\s*=>|\w+\s*=>)/.test(line);

    if (isFunctionStart && braceDepth === 0) {
      componentStartLine = i;
      inComponent = true;
    }

    // Count braces to track scope depth
    // Use simple counting (not perfect but good enough for this purpose)
    for (const char of line) {
      if (char === '{') braceDepth++;
      if (char === '}') {
        braceDepth--;
        if (braceDepth === 0 && inComponent) {
          // We closed a function, reset
          inComponent = false;
          if (i < atLine) {
            componentStartLine = 0;
          }
        }
      }
    }
  }

  return componentStartLine;
}

/**
 * Find a variable declaration in the document by name.
 * Searches for patterns like:
 * - const varName = ...
 * - let varName = ...
 * - var varName = ...
 * - function varName(...) { ... }
 *
 * Only searches within the React component scope to avoid wrapping
 * module-scope variables with hooks (which would violate Rules of Hooks).
 */
function findVariableDeclaration(
  documentText: string,
  varName: string,
  beforeLine: number
): VariableDeclaration | null {
  const lines = documentText.split('\n');

  // Find the component scope to constrain our search
  // We should not wrap variables declared outside the component
  const componentStartLine = findComponentScopeStart(documentText, beforeLine);

  // Search backwards from the hook line to find the variable declaration
  // Stop at the component boundary to avoid module-scope variables
  for (let lineIndex = beforeLine - 1; lineIndex >= componentStartLine; lineIndex--) {
    const line = lines[lineIndex];
    const indent = line.match(/^(\s*)/)?.[1] || '';

    // Skip lines that are at module scope (no indentation and we're past the component start)
    // This is an additional safety check
    if (lineIndex === componentStartLine && indent.length === 0) {
      // This is the component definition line itself, skip it
      continue;
    }

    // Check for const/let/var declarations with various patterns
    // Pattern 1: const varName = value; (variable is first)
    // Pattern 2: const a = {}, varName = value; (variable is not first)
    const varFirstRegex = new RegExp(`^(\\s*)(const|let|var)\\s+${escapeRegExp(varName)}\\s*=\\s*`);
    const varNotFirstRegex = new RegExp(
      `^(\\s*)(const|let|var)\\s+.*,\\s*${escapeRegExp(varName)}\\s*=\\s*`
    );

    const varFirstMatch = line.match(varFirstRegex);
    const varNotFirstMatch = !varFirstMatch ? line.match(varNotFirstRegex) : null;
    const varMatch = varFirstMatch || varNotFirstMatch;

    if (varMatch) {
      const [fullMatch, , declType] = varMatch;
      let initializerStartCol = fullMatch.length;

      // For varNotFirstMatch, we need to find where "varName =" actually starts
      if (varNotFirstMatch) {
        const varNameIdx = line.indexOf(varName + ' =', fullMatch.indexOf(','));
        if (varNameIdx === -1) {
          const varNameIdxNoSpace = line.indexOf(varName + '=', fullMatch.indexOf(','));
          if (varNameIdxNoSpace === -1) continue;
          initializerStartCol = varNameIdxNoSpace + varName.length + 1;
        } else {
          // Find the "=" after varName
          const eqIdx = line.indexOf('=', varNameIdx + varName.length);
          initializerStartCol = eqIdx + 1;
          // Skip whitespace after =
          while (initializerStartCol < line.length && line[initializerStartCol] === ' ') {
            initializerStartCol++;
          }
        }
      }

      // Extract the initializer, being careful with multi-variable declarations
      // e.g., "const a = {}, b = [];" - we only want the initializer for our variable
      const restOfLine = line.substring(initializerStartCol);
      const initializer = extractInitializerFromRest(restOfLine);

      if (!initializer) {
        continue; // Couldn't parse the initializer
      }

      const initializerStartTrimmed = initializerStartCol;

      // Check if this is a single-line declaration or spans multiple lines
      let fullInitializer = initializer.trimEnd();
      let endLine = lineIndex;

      // Handle multi-line declarations (object literals, arrow functions, etc.)
      if (!isBalanced(fullInitializer)) {
        // Collect lines until we find a balanced expression
        // Bounded by: beforeLine (must be declared before use) and MAX_DECLARATION_SEARCH_LINES (safety limit)
        const maxSearchLine = Math.min(
          lines.length,
          beforeLine,
          lineIndex + 1 + MAX_DECLARATION_SEARCH_LINES
        );
        for (let i = lineIndex + 1; i < maxSearchLine; i++) {
          fullInitializer += '\n' + lines[i];
          endLine = i;
          if (isBalanced(fullInitializer)) break;
        }
      }

      // Remove trailing semicolon if present
      fullInitializer = fullInitializer.replace(/;\s*$/, '');

      // Detect arrow function
      const isArrow = /^\s*(\([^)]*\)|[a-zA-Z_$][a-zA-Z0-9_$]*)\s*=>/.test(fullInitializer);

      return {
        line: lineIndex,
        endLine,
        startColumn: indent.length,
        endColumn: lines[endLine].length,
        lineText: line,
        indent,
        declarationType: declType as 'const' | 'let' | 'var',
        initializerText: fullInitializer,
        initializerStart: initializerStartTrimmed,
        initializerEnd: lines[endLine].length,
        isArrowFunction: isArrow,
      };
    }

    // Check for function declarations: function varName(...) { ... }
    const funcDeclRegex = new RegExp(`^(\\s*)function\\s+${escapeRegExp(varName)}\\s*\\(`);
    const funcMatch = line.match(funcDeclRegex);

    if (funcMatch) {
      // Find the full function body by tracking braces
      let fullFunction = line;
      let funcEndLine = lineIndex;

      if (!isBalanced(fullFunction)) {
        // Bounded by: beforeLine (must be declared before use) and MAX_DECLARATION_SEARCH_LINES (safety limit)
        const maxSearchLine = Math.min(
          lines.length,
          beforeLine,
          lineIndex + 1 + MAX_DECLARATION_SEARCH_LINES
        );
        for (let i = lineIndex + 1; i < maxSearchLine; i++) {
          fullFunction += '\n' + lines[i];
          funcEndLine = i;
          if (isBalanced(fullFunction)) break;
        }
      }

      return {
        line: lineIndex,
        endLine: funcEndLine,
        startColumn: indent.length,
        endColumn: lines[funcEndLine].length,
        lineText: line,
        indent,
        declarationType: 'function',
        isFunctionDeclaration: true,
        functionBody: fullFunction,
      };
    }
  }

  return null;
}

/**
 * Check if parentheses, brackets, and braces are balanced in a string.
 * Handles strings, template literals, and comments.
 */
function isBalanced(text: string): boolean {
  const stack: string[] = [];
  let inString = false;
  let stringChar = '';
  let inTemplate = false;
  let templateDepth = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const prevChar = i > 0 ? text[i - 1] : '';
    const nextChar = i < text.length - 1 ? text[i + 1] : '';

    // Skip comments when not in a string or template
    if (!inString && !inTemplate) {
      // Single-line comment: skip to end of line
      if (char === '/' && nextChar === '/') {
        const newlineIndex = text.indexOf('\n', i + 2);
        if (newlineIndex === -1) {
          break; // Comment goes to end of string
        }
        i = newlineIndex;
        continue;
      }
      // Block comment: skip to closing */
      if (char === '/' && nextChar === '*') {
        const commentEndIndex = text.indexOf('*/', i + 2);
        if (commentEndIndex === -1) {
          return false; // Unclosed block comment
        }
        i = commentEndIndex + 1;
        continue;
      }
    }

    // Handle string escapes
    if (prevChar === '\\' && (inString || inTemplate)) continue;

    // Handle string literals
    if ((char === '"' || char === "'") && !inTemplate) {
      if (inString && stringChar === char) {
        inString = false;
      } else if (!inString) {
        inString = true;
        stringChar = char;
      }
      continue;
    }

    // Handle template literals
    if (char === '`') {
      if (inTemplate && templateDepth === 0) {
        inTemplate = false;
      } else if (!inString) {
        inTemplate = true;
      }
      continue;
    }

    if (inString) continue;

    // Handle ${} in template literals
    if (inTemplate && char === '$' && nextChar === '{') {
      templateDepth++;
      i++; // Skip the { since we're tracking it with templateDepth
      continue;
    }

    // Track brackets
    if (char === '(' || char === '[' || char === '{') {
      stack.push(char);
    } else if (char === ')' || char === ']' || char === '}') {
      if (inTemplate && char === '}' && templateDepth > 0) {
        templateDepth--;
        continue;
      }
      const expected = char === ')' ? '(' : char === ']' ? '[' : '{';
      if (stack.length === 0 || stack[stack.length - 1] !== expected) {
        return false;
      }
      stack.pop();
    }
  }

  return stack.length === 0 && !inString && !inTemplate;
}

/**
 * Find the position of the closing parenthesis that matches the opening paren
 * at startIndex. Handles strings, template literals, and comments.
 * Returns -1 if not found.
 */
function findClosingParen(text: string, startIndex: number): number {
  let parenDepth = 0;
  let inString = false;
  let stringChar = '';
  let inTemplate = false;
  let templateDepth = 0;

  for (let i = startIndex; i < text.length; i++) {
    const char = text[i];
    const prevChar = i > 0 ? text[i - 1] : '';
    const nextChar = i < text.length - 1 ? text[i + 1] : '';

    // Skip comments when not in a string or template
    if (!inString && !inTemplate) {
      if (char === '/' && nextChar === '/') {
        const newlineIndex = text.indexOf('\n', i + 2);
        if (newlineIndex === -1) {
          break;
        }
        i = newlineIndex;
        continue;
      }
      if (char === '/' && nextChar === '*') {
        const commentEndIndex = text.indexOf('*/', i + 2);
        if (commentEndIndex === -1) {
          return -1;
        }
        i = commentEndIndex + 1;
        continue;
      }
    }

    // Handle string escapes
    if (prevChar === '\\' && (inString || inTemplate)) continue;

    // Handle string literals
    if ((char === '"' || char === "'") && !inTemplate) {
      if (inString && stringChar === char) {
        inString = false;
      } else if (!inString) {
        inString = true;
        stringChar = char;
      }
      continue;
    }

    // Handle template literals
    if (char === '`') {
      if (inTemplate && templateDepth === 0) {
        inTemplate = false;
      } else if (!inString) {
        inTemplate = true;
      }
      continue;
    }

    if (inString) continue;

    // Handle ${} in template literals
    if (inTemplate && char === '$' && nextChar === '{') {
      templateDepth++;
      i++;
      continue;
    }

    // Track parentheses
    if (char === '(') {
      parenDepth++;
    } else if (char === ')') {
      if (inTemplate && templateDepth > 0) {
        // Inside template expression, ignore
        continue;
      }
      parenDepth--;
      if (parenDepth === 0) {
        return i;
      }
    } else if (char === '}' && inTemplate && templateDepth > 0) {
      templateDepth--;
    }
  }

  return -1;
}

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check if a React hook import exists in the document
 */
function hasReactHookImport(documentText: string, hookName: string): boolean {
  // Check for various import patterns
  const patterns = [
    // import { useMemo } from 'react'
    new RegExp(`import\\s*{[^}]*\\b${hookName}\\b[^}]*}\\s*from\\s*['"]react['"]`),
    // import React, { useMemo } from 'react'
    new RegExp(`import\\s+React\\s*,\\s*{[^}]*\\b${hookName}\\b[^}]*}\\s*from\\s*['"]react['"]`),
    // import * as React from 'react' (can use React.useMemo)
    /import\s+\*\s+as\s+React\s+from\s*['"]react['"]/,
    // import React from 'react' (can use React.useMemo)
    /import\s+React\s+from\s*['"]react['"]/,
  ];

  return patterns.some((pattern) => pattern.test(documentText));
}

/**
 * Find the position to insert a new hook import
 * Returns the position and whether to add to existing import or create new.
 * Handles both single-line and multi-line import statements.
 */
function findImportInsertPosition(
  documentText: string,
  hookName: string
): { line: number; edit: string; replaceRange?: Range } | null {
  const lines = documentText.split('\n');

  // First, check if there's an existing React import with destructuring we can extend
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if this line starts a React import with destructuring
    if (/^\s*import\s*{/.test(line) || /^\s*import\s+\w+\s*,\s*{/.test(line)) {
      // Collect lines until we have a complete import statement (balanced braces + semicolon or from clause)
      let fullImport = line;
      let endLine = i;

      // Handle multi-line imports - collect until we have balanced braces and a complete statement
      while (endLine < lines.length - 1) {
        // Check if we have a complete import statement using regex
        // This is more robust than includes() as it validates the structure
        if (/}\s*from\s*['"][^'"]+['"]/.test(fullImport)) {
          break;
        }
        endLine++;
        fullImport += '\n' + lines[endLine];
      }

      // Use regex to properly match React imports - this validates the structure
      // and won't match 'react' inside comments or strings within the import
      const destructureMatch = fullImport.match(/import\s*{\s*([^}]*)\s*}\s*from\s*['"]react['"]/);
      const reactDestructureMatch = fullImport.match(
        /import\s+React\s*,\s*{\s*([^}]*)\s*}\s*from\s*['"]react['"]/
      );

      const match = reactDestructureMatch || destructureMatch;
      if (match) {
        const existingImports = match[1]
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        // Check if hook is already imported
        if (existingImports.includes(hookName)) {
          return null; // Already imported
        }

        // Add the hook to existing imports
        const newImports = [...existingImports, hookName].join(', ');

        // Rebuild the import statement (single line for simplicity)
        const newImport = reactDestructureMatch
          ? `import React, { ${newImports} } from 'react';`
          : `import { ${newImports} } from 'react';`;

        return {
          line: i,
          edit: newImport,
          replaceRange: {
            start: Position.create(i, 0),
            end: Position.create(endLine, lines[endLine].length),
          },
        };
      }
    }
  }

  // If no destructuring import found, look for other React imports to add after
  for (let i = 0; i < lines.length; i++) {
    // Find complete React import (may span multiple lines)
    let fullImport = lines[i];
    let endLine = i;

    // Collect lines if this looks like an import start
    if (/^\s*import\s+/.test(lines[i])) {
      // Collect lines until we have a complete statement (ends with semicolon or has complete from clause)
      while (endLine < lines.length - 1) {
        if (/from\s*['"][^'"]+['"]\s*;?\s*$/.test(fullImport)) {
          break;
        }
        endLine++;
        fullImport += '\n' + lines[endLine];
      }

      // Check if this is a React import using regex to match the from clause
      // This matches 'react' only in the from clause, not in comments/strings
      if (/from\s*['"]react['"]/.test(fullImport)) {
        return {
          line: endLine + 1,
          edit: `import { ${hookName} } from 'react';\n`,
        };
      }
    }
  }

  // No React import found - add at the top after any 'use strict' or comments
  let insertLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('//') || line.startsWith('/*') || line === "'use strict';") {
      insertLine = i + 1;
    } else {
      break;
    }
  }

  return {
    line: insertLine,
    edit: `import { ${hookName} } from 'react';\n`,
  };
}

/**
 * Create a "Wrap in useMemo" quick fix action for RLD-400 (unstable object)
 */
function createWrapInUseMemoAction(
  diagnostic: Diagnostic,
  uri: string,
  documentText: string,
  varName: string
): CodeAction | null {
  const declaration = findVariableDeclaration(
    documentText,
    varName,
    diagnostic.range.start.line + 1 // Convert from 0-indexed
  );

  if (!declaration || !declaration.initializerText) {
    return null;
  }

  // Don't offer wrap if it's already a hook call
  if (/^(useMemo|useCallback|useRef)\s*\(/.test(declaration.initializerText.trim())) {
    return null;
  }

  const edits: TextEdit[] = [];
  const lines = documentText.split('\n');

  // Calculate the range to replace (the initializer)
  const initText = declaration.initializerText;

  // For objects, wrap in useMemo(() => ({ ... }), [])
  // For arrays, wrap in useMemo(() => [...], [])
  // For function calls, wrap in useMemo(() => fnCall(), [])
  let wrappedCode: string;
  const trimmedInit = initText.trim();

  if (trimmedInit.startsWith('{')) {
    // Object literal - need parentheses around it in arrow function
    wrappedCode = `useMemo(() => (${initText}), [])`;
  } else {
    wrappedCode = `useMemo(() => ${initText}, [])`;
  }

  // Find the exact position of the initializer
  // The declaration line contains: const varName = <initializer>;
  const declLine = lines[declaration.line];
  const equalsIndex = declLine.indexOf('=');

  if (equalsIndex === -1) {
    return null;
  }

  // Find where the initializer starts (after = and whitespace)
  const afterEquals = declLine.substring(equalsIndex + 1);
  const whitespaceMatch = afterEquals.match(/^(\s*)/);
  const initStartCol = equalsIndex + 1 + (whitespaceMatch?.[1].length || 0);

  // Calculate end position (handle multi-line)
  let endLine = declaration.line;
  let endCol = declLine.length;

  // If multi-line, find the actual end
  if (initText.includes('\n')) {
    const initLines = initText.split('\n');
    endLine = declaration.line + initLines.length - 1;
    endCol = lines[endLine].length;
  }

  // Remove trailing semicolon from end position if present
  const lastLine = lines[endLine];
  const semiMatch = lastLine.match(/;\s*$/);
  if (semiMatch) {
    endCol = lastLine.length - semiMatch[0].length;
  }

  // Create the text edit for wrapping
  edits.push(
    TextEdit.replace(
      {
        start: Position.create(declaration.line, initStartCol),
        end: Position.create(endLine, endCol),
      },
      wrappedCode
    )
  );

  // Add import if needed
  if (!hasReactHookImport(documentText, 'useMemo')) {
    const importEdit = findImportInsertPosition(documentText, 'useMemo');
    if (importEdit) {
      if (importEdit.replaceRange) {
        edits.push(TextEdit.replace(importEdit.replaceRange, importEdit.edit));
      } else {
        edits.push(TextEdit.insert(Position.create(importEdit.line, 0), importEdit.edit));
      }
    }
  }

  return {
    title: `Wrap '${varName}' in useMemo`,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diagnostic],
    isPreferred: true,
    edit: {
      changes: {
        [uri]: edits,
      },
    },
  };
}

/**
 * Create a "Wrap in useCallback" quick fix action for RLD-402 (unstable function)
 */
function createWrapInUseCallbackAction(
  diagnostic: Diagnostic,
  uri: string,
  documentText: string,
  varName: string
): CodeAction | null {
  const declaration = findVariableDeclaration(
    documentText,
    varName,
    diagnostic.range.start.line + 1
  );

  if (!declaration) {
    return null;
  }

  const edits: TextEdit[] = [];
  const lines = documentText.split('\n');

  // Handle function declarations: function foo() { ... }
  if (declaration.isFunctionDeclaration && declaration.functionBody) {
    // Convert function declaration to const with useCallback
    // function foo(args) { body } -> const foo = useCallback((args) => { body }, []);

    const funcBody = declaration.functionBody;

    // Extract function params and body
    const funcMatch = funcBody.match(/function\s+\w+\s*\(([^)]*)\)\s*(\{[\s\S]*\})\s*$/);

    if (!funcMatch) {
      return null;
    }

    const [, params, body] = funcMatch;
    const wrappedCode = `const ${varName} = useCallback((${params}) => ${body}, []);`;

    // Use the endLine already calculated by findVariableDeclaration
    edits.push(
      TextEdit.replace(
        {
          start: Position.create(declaration.line, declaration.indent.length),
          end: Position.create(declaration.endLine, lines[declaration.endLine].length),
        },
        wrappedCode
      )
    );
  } else if (declaration.initializerText && declaration.isArrowFunction) {
    // Arrow function: const foo = () => { ... }
    // -> const foo = useCallback(() => { ... }, []);

    const initText = declaration.initializerText;
    const wrappedCode = `useCallback(${initText}, [])`;

    // Find initializer position
    const declLine = lines[declaration.line];
    const equalsIndex = declLine.indexOf('=');

    if (equalsIndex === -1) {
      return null;
    }

    const afterEquals = declLine.substring(equalsIndex + 1);
    const whitespaceMatch = afterEquals.match(/^(\s*)/);
    const initStartCol = equalsIndex + 1 + (whitespaceMatch?.[1].length || 0);

    // Calculate end position
    let endLine = declaration.line;
    let endCol = declLine.length;

    if (initText.includes('\n')) {
      const initLines = initText.split('\n');
      endLine = declaration.line + initLines.length - 1;
      endCol = lines[endLine].length;
    }

    // Remove trailing semicolon
    const lastLine = lines[endLine];
    const semiMatch = lastLine.match(/;\s*$/);
    if (semiMatch) {
      endCol = lastLine.length - semiMatch[0].length;
    }

    edits.push(
      TextEdit.replace(
        {
          start: Position.create(declaration.line, initStartCol),
          end: Position.create(endLine, endCol),
        },
        wrappedCode
      )
    );
  } else if (declaration.initializerText) {
    // Regular function expression: const foo = function() { ... }
    const initText = declaration.initializerText;

    // Check if it starts with 'function'
    if (!initText.trim().startsWith('function')) {
      return null;
    }

    // Convert to arrow function in useCallback
    const funcMatch = initText.match(/function\s*\(([^)]*)\)\s*(\{[\s\S]*\})\s*$/);
    if (!funcMatch) {
      return null;
    }

    const [, params, body] = funcMatch;
    const wrappedCode = `useCallback((${params}) => ${body}, [])`;

    // Find initializer position
    const declLine = lines[declaration.line];
    const equalsIndex = declLine.indexOf('=');

    if (equalsIndex === -1) {
      return null;
    }

    const afterEquals = declLine.substring(equalsIndex + 1);
    const whitespaceMatch = afterEquals.match(/^(\s*)/);
    const initStartCol = equalsIndex + 1 + (whitespaceMatch?.[1].length || 0);

    // Calculate end position
    let endLine = declaration.line;
    let endCol = declLine.length;

    if (initText.includes('\n')) {
      const initLines = initText.split('\n');
      endLine = declaration.line + initLines.length - 1;
      endCol = lines[endLine].length;
    }

    const lastLine = lines[endLine];
    const semiMatch = lastLine.match(/;\s*$/);
    if (semiMatch) {
      endCol = lastLine.length - semiMatch[0].length;
    }

    edits.push(
      TextEdit.replace(
        {
          start: Position.create(declaration.line, initStartCol),
          end: Position.create(endLine, endCol),
        },
        wrappedCode
      )
    );
  } else {
    return null;
  }

  // Add import if needed
  if (!hasReactHookImport(documentText, 'useCallback')) {
    const importEdit = findImportInsertPosition(documentText, 'useCallback');
    if (importEdit) {
      if (importEdit.replaceRange) {
        edits.push(TextEdit.replace(importEdit.replaceRange, importEdit.edit));
      } else {
        edits.push(TextEdit.insert(Position.create(importEdit.line, 0), importEdit.edit));
      }
    }
  }

  return {
    title: `Wrap '${varName}' in useCallback`,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diagnostic],
    isPreferred: true,
    edit: {
      changes: {
        [uri]: edits,
      },
    },
  };
}

/**
 * Create an "Add dependency array" quick fix action for RLD-500
 */
function createAddDependencyArrayAction(
  diagnostic: Diagnostic,
  uri: string,
  documentText: string
): CodeAction | null {
  const lines = documentText.split('\n');
  const lineIndex = diagnostic.range.start.line;

  if (lineIndex < 0 || lineIndex >= lines.length) {
    return null;
  }

  // Find the hook call on this line or nearby lines
  let hookText = '';

  // Collect lines that might be part of the hook call
  for (let i = lineIndex; i < Math.min(lineIndex + MAX_HOOK_SEARCH_LINES, lines.length); i++) {
    hookText += lines[i] + '\n';
    if (isBalanced(hookText) && hookText.includes(')')) {
      break;
    }
  }

  // Find the useEffect/useLayoutEffect call
  const hookMatch = hookText.match(/(useEffect|useLayoutEffect)\s*\(\s*/);
  if (!hookMatch) {
    return null;
  }

  // Find the closing parenthesis of the hook call using robust parsing
  // that handles strings, comments, and template literals
  const hookStartIndex = hookText.indexOf(hookMatch[0]);
  const openParenIndex = hookStartIndex + hookMatch[0].indexOf('(');
  const lastCloseParen = findClosingParen(hookText, openParenIndex);

  if (lastCloseParen === -1) {
    return null;
  }

  // Calculate the actual position in the document
  // Count newlines to find the line and column
  let currentLine = lineIndex;
  let currentCol = 0;

  for (let i = 0; i < lastCloseParen; i++) {
    if (hookText[i] === '\n') {
      currentLine++;
      currentCol = 0;
    } else {
      currentCol++;
    }
  }

  // The position where we want to insert ", []"
  const insertPos = Position.create(currentLine, currentCol);

  return {
    title: 'Add empty dependency array',
    kind: CodeActionKind.QuickFix,
    diagnostics: [diagnostic],
    isPreferred: true,
    edit: {
      changes: {
        [uri]: [TextEdit.insert(insertPos, ', []')],
      },
    },
  };
}

/**
 * Generate code actions (quick fixes) for a diagnostic
 */
export function generateCodeActions(
  diagnostic: Diagnostic,
  textDocumentUri: string,
  documentText: string
): CodeAction[] {
  const actions: CodeAction[] = [];
  const data = diagnostic.data as
    | {
        errorCode?: string;
        line?: number;
        files?: string[];
        problematicDependency?: string;
        hookType?: string;
      }
    | undefined;

  if (!data?.errorCode) {
    return actions;
  }

  // Add quick fix actions based on error code
  const errorCode = data.errorCode;
  const varName = data.problematicDependency;

  // RLD-400: Unstable object in deps -> Wrap in useMemo
  // RLD-401: Unstable array in deps -> Wrap in useMemo
  // RLD-403: Unstable function call result -> Wrap in useMemo
  if ((errorCode === 'RLD-400' || errorCode === 'RLD-401' || errorCode === 'RLD-403') && varName) {
    const useMemoAction = createWrapInUseMemoAction(
      diagnostic,
      textDocumentUri,
      documentText,
      varName
    );
    if (useMemoAction) {
      actions.push(useMemoAction);
    }
  }

  // RLD-402: Unstable function in deps -> Wrap in useCallback
  if (errorCode === 'RLD-402' && varName) {
    const useCallbackAction = createWrapInUseCallbackAction(
      diagnostic,
      textDocumentUri,
      documentText,
      varName
    );
    if (useCallbackAction) {
      actions.push(useCallbackAction);
    }
  }

  // RLD-500: Missing dependency array -> Add empty deps array
  if (errorCode === 'RLD-500') {
    const addDepsAction = createAddDependencyArrayAction(diagnostic, textDocumentUri, documentText);
    if (addDepsAction) {
      actions.push(addDepsAction);
    }
  }

  // Add "ignore this line" action
  const ignoreLine = createIgnoreLineAction(
    diagnostic,
    textDocumentUri,
    documentText,
    data.errorCode
  );
  if (ignoreLine) {
    actions.push(ignoreLine);
  }

  // Add "ignore this error code" action
  const ignoreCode = createIgnoreCodeAction(
    diagnostic,
    textDocumentUri,
    documentText,
    data.errorCode
  );
  if (ignoreCode) {
    actions.push(ignoreCode);
  }

  // For cross-file cycles, add navigation actions to related files
  if (data.files && data.files.length > 1) {
    const currentFilePath = fileUriToPath(textDocumentUri);
    const relatedFiles = data.files.filter(
      (f) => normalizeFilePath(f) !== normalizeFilePath(currentFilePath)
    );

    for (const relatedFile of relatedFiles) {
      const fileName = getFileName(relatedFile);
      actions.push({
        title: `Go to related file: ${fileName}`,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        command: {
          title: `Open ${fileName}`,
          command: 'vscode.open',
          arguments: [pathToFileUri(relatedFile)],
        },
      });
    }
  }

  return actions;
}

function pathToFileUri(filePath: string): string {
  // Convert file path to file:// URI
  const normalizedPath = filePath.replace(/\\/g, '/');
  if (normalizedPath.startsWith('/')) {
    return `file://${normalizedPath}`;
  }
  // Windows path
  return `file:///${normalizedPath}`;
}

function createIgnoreLineAction(
  diagnostic: Diagnostic,
  uri: string,
  documentText: string,
  errorCode: string
): CodeAction | null {
  const lines = documentText.split('\n');
  const lineIndex = diagnostic.range.start.line;

  if (lineIndex < 0 || lineIndex >= lines.length) {
    return null;
  }

  const currentLine = lines[lineIndex];
  const indent = currentLine.match(/^(\s*)/)?.[1] || '';

  const ignoreComment = `${indent}// rld-ignore-next-line ${errorCode}\n`;

  return {
    title: `Ignore this ${errorCode} issue`,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diagnostic],
    edit: {
      changes: {
        [uri]: [TextEdit.insert(Position.create(lineIndex, 0), ignoreComment)],
      },
    },
  };
}

function createIgnoreCodeAction(
  diagnostic: Diagnostic,
  uri: string,
  documentText: string,
  errorCode: string
): CodeAction | null {
  const lines = documentText.split('\n');
  const lineIndex = diagnostic.range.start.line;

  if (lineIndex < 0 || lineIndex >= lines.length) {
    return null;
  }

  const currentLine = lines[lineIndex];
  const indent = currentLine.match(/^(\s*)/)?.[1] || '';

  const ignoreComment = `${indent}// rld-ignore ${errorCode}\n`;

  return {
    title: `Disable ${errorCode} for this file`,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diagnostic],
    edit: {
      changes: {
        [uri]: [TextEdit.insert(Position.create(0, 0), ignoreComment)],
      },
    },
  };
}

/**
 * Filter diagnostics by severity and confidence settings
 */
export function filterDiagnostics(
  diagnostics: Diagnostic[],
  minSeverity: 'high' | 'medium' | 'low',
  minConfidence: 'high' | 'medium' | 'low'
): Diagnostic[] {
  const levelOrder = { high: 3, medium: 2, low: 1 };
  const minSeverityValue = levelOrder[minSeverity];
  const minConfidenceValue = levelOrder[minConfidence];

  return diagnostics.filter((diagnostic) => {
    const data = diagnostic.data as
      | { confidence?: 'high' | 'medium' | 'low'; issueSeverity?: 'high' | 'medium' | 'low' }
      | undefined;

    // Get original severity from data (not the mapped DiagnosticSeverity)
    const issueSeverity = data?.issueSeverity;
    const confidence = data?.confidence;

    // If data is missing, don't filter out (be safe - show the diagnostic)
    if (!issueSeverity || !confidence) {
      return true;
    }

    // Filter by both severity and confidence
    return (
      levelOrder[issueSeverity] >= minSeverityValue && levelOrder[confidence] >= minConfidenceValue
    );
  });
}
