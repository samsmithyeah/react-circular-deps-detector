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
import type { IntelligentHookAnalysis, CrossFileCycle } from 'react-loop-detector';
import { fileUriToPath } from './utils.js';

/**
 * Maps IntelligentHookAnalysis results to LSP Diagnostics
 */
export function mapAnalysisToDiagnostics(
  analysis: IntelligentHookAnalysis[],
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

function mapIssueToDiagnostic(issue: IntelligentHookAnalysis): Diagnostic {
  const severity = mapSeverity(issue.severity, issue.category);
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
    },
  };
}

function mapSeverity(severity: 'high' | 'medium' | 'low', category: string): DiagnosticSeverity {
  // Critical issues are errors
  if (category === 'critical') {
    return DiagnosticSeverity.Error;
  }

  // Map by severity
  switch (severity) {
    case 'high':
      return DiagnosticSeverity.Error;
    case 'medium':
      return DiagnosticSeverity.Warning;
    case 'low':
      return DiagnosticSeverity.Information;
    default:
      return DiagnosticSeverity.Warning;
  }
}

function formatMessage(issue: IntelligentHookAnalysis): string {
  // Use the explanation from the analysis, but make it more concise for the IDE
  const baseMessage = issue.explanation;

  // Add the problematic dependency if available
  if (issue.problematicDependency && issue.problematicDependency !== 'N/A') {
    return `${baseMessage} (dependency: ${issue.problematicDependency})`;
  }

  return baseMessage;
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
  _minConfidence: 'high' | 'medium' | 'low'
): Diagnostic[] {
  // Note: confidence filtering would require storing confidence in diagnostic data
  // For now, we only filter by severity
  const severityOrder = { high: 3, medium: 2, low: 1 };
  const minSeverityValue = severityOrder[minSeverity];

  return diagnostics.filter((diagnostic) => {
    // Map LSP severity back to our severity levels
    let diagSeverity: 'high' | 'medium' | 'low';
    switch (diagnostic.severity) {
      case DiagnosticSeverity.Error:
        diagSeverity = 'high';
        break;
      case DiagnosticSeverity.Warning:
        diagSeverity = 'medium';
        break;
      default:
        diagSeverity = 'low';
    }

    return severityOrder[diagSeverity] >= minSeverityValue;
  });
}
