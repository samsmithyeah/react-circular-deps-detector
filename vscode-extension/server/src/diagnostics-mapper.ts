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
 * Generate code actions (quick fixes) for a diagnostic
 */
export function generateCodeActions(
  diagnostic: Diagnostic,
  textDocumentUri: string,
  documentText: string
): CodeAction[] {
  const actions: CodeAction[] = [];
  const data = diagnostic.data as
    | { errorCode?: string; line?: number; files?: string[] }
    | undefined;

  if (!data?.errorCode) {
    return actions;
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
