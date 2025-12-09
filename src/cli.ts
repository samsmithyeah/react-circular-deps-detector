#!/usr/bin/env node

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import chalk from 'chalk';
import chokidar from 'chokidar';
import { codeFrameColumns } from '@babel/code-frame';
import { detectCircularDependencies, DetectionResults, CircularDependency } from './detector';
import { CrossFileCycle } from './module-graph';
import { HookAnalysis } from './orchestrator';

interface CliOptions {
  pattern: string;
  ignore: string[];
  json?: boolean;
  sarif?: boolean;
  color?: boolean;
  compact?: boolean;
  debug?: boolean;
  parallel?: boolean;
  workers?: number;
  minSeverity?: 'high' | 'medium' | 'low';
  minConfidence?: 'high' | 'medium' | 'low';
  confirmedOnly?: boolean;
  cache?: boolean;
  strict?: boolean;
  tsconfigPath?: string;
  presets?: boolean; // Commander turns --no-presets into presets: false
}

// SARIF output types
interface SarifResult {
  ruleId: string;
  level: 'error' | 'warning' | 'note';
  message: { text: string };
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region: {
        startLine: number;
        startColumn?: number;
      };
    };
  }>;
}

interface SarifReport {
  version: string;
  $schema: string;
  runs: Array<{
    tool: {
      driver: {
        name: string;
        version: string;
        informationUri: string;
        rules: Array<{
          id: string;
          name: string;
          shortDescription: { text: string };
          helpUri?: string;
          properties?: { category: string };
        }>;
      };
    };
    results: SarifResult[];
  }>;
}

function generateSarifReport(results: DetectionResults): SarifReport {
  const sarifResults: SarifResult[] = [];

  // Add circular dependencies
  results.circularDependencies.forEach((dep) => {
    sarifResults.push({
      ruleId: 'IMPORT-CYCLE',
      level: 'error',
      message: { text: `Import cycle detected: ${dep.cycle.join(' → ')}` },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: dep.file },
            region: { startLine: dep.line },
          },
        },
      ],
    });
  });

  // Add cross-file cycles
  results.crossFileCycles.forEach((cycle) => {
    sarifResults.push({
      ruleId: 'CROSS-FILE-CYCLE',
      level: 'error',
      message: {
        text: `Cross-file import cycle: ${cycle.files.map((f) => path.basename(f)).join(' → ')}`,
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: cycle.files[0] },
            region: { startLine: 1 },
          },
        },
      ],
    });
  });

  // Add hooks issues
  results.intelligentHooksAnalysis.forEach((issue) => {
    const level =
      issue.category === 'critical' ? 'error' : issue.category === 'warning' ? 'warning' : 'note';
    // Include suggestion in message if available
    const messageText = issue.suggestion
      ? `${issue.explanation}\n\nFix: ${issue.suggestion}`
      : issue.explanation;
    sarifResults.push({
      ruleId: issue.errorCode,
      level,
      message: { text: messageText },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: issue.file },
            region: {
              startLine: issue.line,
              startColumn: issue.column,
            },
          },
        },
      ],
    });
  });

  // Define rules
  const rules = [
    {
      id: 'IMPORT-CYCLE',
      name: 'Import Cycle',
      shortDescription: { text: 'Circular import dependency detected' },
      properties: { category: 'critical' },
    },
    {
      id: 'CROSS-FILE-CYCLE',
      name: 'Cross-File Cycle',
      shortDescription: { text: 'Cross-file import cycle detected' },
      properties: { category: 'critical' },
    },
    {
      id: 'RLD-100',
      name: 'Render Phase setState',
      shortDescription: { text: 'setState called during render' },
      properties: { category: 'critical' },
    },
    {
      id: 'RLD-101',
      name: 'Render Phase setState (indirect)',
      shortDescription: { text: 'setState called during render via function call' },
      properties: { category: 'critical' },
    },
    {
      id: 'RLD-200',
      name: 'Effect Loop',
      shortDescription: { text: 'useEffect unconditional setState loop' },
      properties: { category: 'critical' },
    },
    {
      id: 'RLD-201',
      name: 'Missing Deps Loop',
      shortDescription: { text: 'useEffect missing deps with setState' },
      properties: { category: 'critical' },
    },
    {
      id: 'RLD-202',
      name: 'Layout Effect Loop',
      shortDescription: { text: 'useLayoutEffect unconditional setState loop' },
      properties: { category: 'critical' },
    },
    {
      id: 'RLD-300',
      name: 'Cross-File Loop',
      shortDescription: { text: 'Cross-file loop risk' },
      properties: { category: 'warning' },
    },
    {
      id: 'RLD-301',
      name: 'Cross-File Conditional',
      shortDescription: { text: 'Cross-file conditional modification' },
      properties: { category: 'warning' },
    },
    {
      id: 'RLD-400',
      name: 'Unstable Object',
      shortDescription: { text: 'Unstable object reference in deps' },
      properties: { category: 'performance' },
    },
    {
      id: 'RLD-401',
      name: 'Unstable Array',
      shortDescription: { text: 'Unstable array reference in deps' },
      properties: { category: 'performance' },
    },
    {
      id: 'RLD-402',
      name: 'Unstable Function',
      shortDescription: { text: 'Unstable function reference in deps' },
      properties: { category: 'performance' },
    },
    {
      id: 'RLD-403',
      name: 'Unstable Call Result',
      shortDescription: { text: 'Unstable function call result in deps' },
      properties: { category: 'performance' },
    },
    {
      id: 'RLD-404',
      name: 'Unstable Context Value',
      shortDescription: { text: 'Unstable context provider value' },
      properties: { category: 'performance' },
    },
    {
      id: 'RLD-405',
      name: 'Unstable JSX Prop',
      shortDescription: { text: 'Unstable JSX prop' },
      properties: { category: 'performance' },
    },
    {
      id: 'RLD-406',
      name: 'Unstable Callback Dep',
      shortDescription: { text: 'Unstable callback in useCallback deps' },
      properties: { category: 'performance' },
    },
    {
      id: 'RLD-407',
      name: 'useSyncExternalStore Unstable Snapshot',
      shortDescription: { text: 'Unstable getSnapshot in useSyncExternalStore' },
      properties: { category: 'critical' },
    },
    {
      id: 'RLD-410',
      name: 'Object Spread Risk',
      shortDescription: { text: 'Object spread guard risk' },
      properties: { category: 'warning' },
    },
    {
      id: 'RLD-420',
      name: 'Callback Modifies Dep',
      shortDescription: { text: 'useCallback/useMemo modifies dependency' },
      properties: { category: 'warning' },
    },
    {
      id: 'RLD-500',
      name: 'Missing Deps Array',
      shortDescription: { text: 'useEffect missing dependency array' },
      properties: { category: 'critical' },
    },
    {
      id: 'RLD-501',
      name: 'Conditional Modification',
      shortDescription: { text: 'Conditional modification needs review' },
      properties: { category: 'warning' },
    },
    {
      id: 'RLD-600',
      name: 'Ref Mutation Risk',
      shortDescription: { text: 'Ref mutation with state value (stale closure risk)' },
      properties: { category: 'warning' },
    },
  ];

  return {
    version: '2.1.0',
    $schema:
      'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: 'react-loop-detector',
            version: '1.0.0',
            informationUri: 'https://github.com/samsmithyeah/react-loop-detector',
            rules,
          },
        },
        results: sarifResults,
      },
    ],
  };
}

// Cache for file contents to avoid re-reading
const fileContentCache = new Map<string, string>();

function getFileContent(filePath: string): string | null {
  if (fileContentCache.has(filePath)) {
    return fileContentCache.get(filePath)!;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    fileContentCache.set(filePath, content);
    return content;
  } catch {
    return null;
  }
}

function generateCodeFrame(filePath: string, line: number, column?: number): string | null {
  const content = getFileContent(filePath);
  if (!content) return null;

  try {
    const location = {
      start: { line, column: column ?? 0 },
    };
    return codeFrameColumns(content, location, {
      highlightCode: chalk.level > 0,
      linesAbove: 2,
      linesBelow: 2,
    });
  } catch {
    return null;
  }
}

const program = new Command();

program
  .name('react-loop-detector')
  .description('Detect circular import dependencies and React hooks infinite re-render risks')
  .version('1.0.0')
  .argument('<path>', 'Path to React project or file to analyze')
  .option('-p, --pattern <pattern>', 'Glob pattern for files to analyze', '**/*.{js,jsx,ts,tsx}')
  .option('-i, --ignore <patterns...>', 'Patterns to ignore', [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/.expo/**',
    '**/.next/**',
    '**/.nuxt/**',
    '**/.cache/**',
  ])
  .option('--json', 'Output results as JSON')
  .option('--sarif', 'Output results in SARIF format (for GitHub Code Scanning)')
  .option('--no-color', 'Disable colored output')
  .option('--compact', 'Compact output format (one line per issue)')
  .option('--debug', 'Show internal decision logic for debugging false positives')
  .option('--parallel', 'Use parallel parsing with worker threads (faster for large projects)')
  .option('--workers <count>', 'Number of worker threads (default: CPU cores - 1)', parseInt)
  .option('--min-severity <level>', 'Minimum severity to report (high, medium, low)', 'low')
  .option(
    '--min-confidence <level>',
    'Minimum confidence to report (high, medium, low). Default: medium (hides uncertain detections)',
    'medium'
  )
  .option('--confirmed-only', 'Only report confirmed infinite loops (not potential issues)')
  .option('--cache', 'Enable caching for faster repeated runs')
  .option(
    '--strict',
    'Enable TypeScript strict mode for type-based stability detection (slower but more accurate)'
  )
  .option('--tsconfig <path>', 'Path to tsconfig.json (for --strict mode)')
  .option('--no-presets', 'Disable auto-detection of library presets from package.json')
  .action(async (targetPath: string, options: CliOptions) => {
    try {
      // Disable colors if --no-color flag is used
      if (options.color === false) {
        chalk.level = 0;
        process.env.FORCE_COLOR = '0';
        process.env.NO_COLOR = '1';
      }

      const absolutePath = path.resolve(targetPath);

      if (!fs.existsSync(absolutePath)) {
        console.error(chalk.red(`Error: Path "${absolutePath}" does not exist`));
        process.exit(1);
      }

      if (!options.json && !options.sarif) {
        console.log(chalk.blue(`Analyzing React hooks in: ${absolutePath}`));
        console.log(chalk.gray(`Pattern: ${options.pattern}`));
        if (options.strict) {
          console.log(
            chalk.yellow(`Strict mode enabled: Using TypeScript compiler for type-based analysis`)
          );
        }
      }

      const results = await detectCircularDependencies(absolutePath, {
        pattern: options.pattern,
        ignore: options.ignore,
        cache: options.cache,
        debug: options.debug,
        parallel: options.parallel,
        workers: options.workers,
        strict: options.strict,
        tsconfigPath: options.tsconfigPath,
        config: {
          minSeverity: options.minSeverity,
          minConfidence: options.minConfidence,
          includePotentialIssues: !options.confirmedOnly,
          strictMode: options.strict,
          tsconfigPath: options.tsconfigPath,
          noPresets: options.presets === false, // --no-presets becomes presets: false
        },
      });

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
      } else if (options.sarif) {
        const sarifReport = generateSarifReport(results);
        console.log(JSON.stringify(sarifReport, null, 2));
      } else {
        formatResults(results, options.compact, options.debug);
      }

      // Only exit with error for critical issues
      const criticalIssues = results.circularDependencies.length + results.crossFileCycles.length;
      const confirmedLoops = results.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'confirmed-infinite-loop'
      ).length;

      if (criticalIssues > 0 || confirmedLoops > 0) {
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

function displayCompactIssue(issue: HookAnalysis) {
  const relPath = path.relative(process.cwd(), issue.file);
  const col = issue.column ?? 0;
  const level =
    issue.category === 'critical' ? 'error' : issue.category === 'warning' ? 'warning' : 'info';

  // Format: file:line:col - level CODE: description
  const color =
    issue.category === 'critical'
      ? chalk.red
      : issue.category === 'warning'
        ? chalk.yellow
        : chalk.cyan;
  console.log(
    color(
      `${relPath}:${issue.line}:${col} - ${level} ${issue.errorCode}: ${issue.explanation.split('.')[0]}`
    )
  );
}

function displayDebugInfo(issue: HookAnalysis) {
  if (!issue.debugInfo) return;

  const debug = issue.debugInfo;
  console.log(chalk.magenta(`    🔧 Debug Info:`));
  console.log(chalk.magenta(`       Reason: ${debug.reason}`));

  if (debug.stateTracking) {
    const st = debug.stateTracking;
    if (st.declaredStateVars.length > 0) {
      console.log(chalk.gray(`       State variables: ${st.declaredStateVars.join(', ')}`));
    }
    if (st.setterFunctions.length > 0) {
      console.log(chalk.gray(`       Setter functions: ${st.setterFunctions.join(', ')}`));
    }
    if (st.unstableVariables.length > 0) {
      console.log(chalk.gray(`       Unstable variables: ${st.unstableVariables.join(', ')}`));
    }
  }

  if (debug.dependencyAnalysis) {
    const da = debug.dependencyAnalysis;
    console.log(chalk.gray(`       Dependencies analyzed: [${da.rawDependencies.join(', ')}]`));
    if (da.problematicDeps.length > 0) {
      console.log(chalk.gray(`       Problematic: [${da.problematicDeps.join(', ')}]`));
    }
    if (da.safeDeps.length > 0) {
      console.log(chalk.gray(`       Safe: [${da.safeDeps.join(', ')}]`));
    }
  }

  if (debug.guardInfo) {
    const gi = debug.guardInfo;
    console.log(
      chalk.gray(
        `       Guard detected: ${gi.hasGuard ? 'yes' : 'no'}${gi.guardType ? ` (${gi.guardType})` : ''}`
      )
    );
  }

  if (debug.deferredInfo) {
    const di = debug.deferredInfo;
    if (di.isDeferred) {
      console.log(
        chalk.gray(`       Deferred: yes${di.deferredContext ? ` (${di.deferredContext})` : ''}`)
      );
    }
  }

  console.log();
}

function displayIssue(issue: HookAnalysis, showDebug?: boolean) {
  // Show location
  console.log(chalk.blue(`    📍 Location:`));
  console.log(chalk.gray(`       ${path.relative(process.cwd(), issue.file)}:${issue.line}`));
  console.log(
    chalk.gray(`       ${issue.hookType}${issue.functionName ? ` in ${issue.functionName}()` : ''}`)
  );
  console.log();

  // Show code frame
  const codeFrame = generateCodeFrame(issue.file, issue.line, issue.column);
  if (codeFrame) {
    console.log(chalk.blue(`    📝 Code:`));
    // Indent each line of the code frame
    const indentedFrame = codeFrame
      .split('\n')
      .map((line) => `       ${line}`)
      .join('\n');
    console.log(indentedFrame);
    console.log();
  }

  // Show the problem in simple terms
  console.log(chalk.blue(`    ❌ Problem:`));

  // Use the explanation field if available - it contains the most accurate description
  if (issue.explanation) {
    // Split long explanations into multiple lines for readability
    // Use lookbehind to split on whitespace following a period (preserves periods in names/versions)
    const lines = issue.explanation.split(/(?<=\.)\s+/).filter((l) => l.trim());
    for (const line of lines) {
      const trimmedLine = line.trim();
      console.log(chalk.gray(`       ${trimmedLine}${trimmedLine.endsWith('.') ? '' : '.'}`));
    }
  } else if (issue.type === 'confirmed-infinite-loop' && issue.setterFunction) {
    console.log(
      chalk.gray(
        `       This hook depends on '${issue.problematicDependency}' and modifies it, creating an infinite loop:`
      )
    );
    console.log(
      chalk.gray(
        `       ${issue.problematicDependency} changes → hook runs → calls ${issue.setterFunction}() → ${issue.problematicDependency} changes → repeats forever`
      )
    );
  } else if (issue.type === 'potential-issue') {
    console.log(
      chalk.gray(
        `       This hook depends on '${issue.problematicDependency}' and conditionally modifies it.`
      )
    );
    console.log(
      chalk.gray(`       If the condition doesn't prevent updates, this creates an infinite loop.`)
    );
  } else {
    console.log(
      chalk.gray(
        `       Issue with dependency '${issue.problematicDependency}' in ${issue.hookType}.`
      )
    );
  }
  console.log();

  // Show actionable suggestion if available
  if (issue.suggestion) {
    console.log(chalk.blue(`    💡 How to fix:`));
    console.log(chalk.green(`       ${issue.suggestion}`));
    console.log();
  }

  // Show what the code is doing (only if it adds clarity)
  if (issue.actualStateModifications.length > 1 || issue.stateReads.length > 1) {
    console.log(chalk.blue(`    🔍 Details:`));
    if (issue.stateReads.length > 1) {
      console.log(chalk.gray(`       Reads: ${issue.stateReads.join(', ')}`));
    }
    if (issue.actualStateModifications.length > 1) {
      console.log(chalk.gray(`       Modifies: ${issue.actualStateModifications.join(', ')}`));
    }
    console.log();
  }

  // Show debug info if enabled
  if (showDebug && issue.debugInfo) {
    displayDebugInfo(issue);
  }

  console.log();
}

function formatResults(results: DetectionResults, compact?: boolean, debug?: boolean) {
  const { circularDependencies, crossFileCycles, intelligentHooksAnalysis, summary } = results;

  let hasIssues = false;

  // Separate by severity type
  const confirmedIssues = intelligentHooksAnalysis.filter(
    (issue) => issue.type === 'confirmed-infinite-loop'
  );
  const potentialIssues = intelligentHooksAnalysis.filter(
    (issue) => issue.type === 'potential-issue'
  );

  const totalHooksIssues = confirmedIssues.length + potentialIssues.length;

  // COMPACT MODE: Show Unix-style one-line-per-issue output
  if (compact) {
    // Import cycles
    circularDependencies.forEach((dep: CircularDependency) => {
      const relPath = path.relative(process.cwd(), dep.file);
      console.log(
        chalk.red(`${relPath}:${dep.line}:0 - error IMPORT-CYCLE: ${dep.cycle.join(' → ')}`)
      );
    });

    // Cross-file cycles
    crossFileCycles.forEach((cycle: CrossFileCycle) => {
      const relPath = path.relative(process.cwd(), cycle.files[0]);
      console.log(
        chalk.red(
          `${relPath}:1:0 - error CROSS-FILE-CYCLE: ${cycle.files.map((f) => path.basename(f)).join(' → ')}`
        )
      );
    });

    // Hooks issues
    intelligentHooksAnalysis.forEach((issue) => {
      displayCompactIssue(issue);
    });

    // Brief summary
    const total =
      circularDependencies.length + crossFileCycles.length + intelligentHooksAnalysis.length;
    if (total > 0) {
      console.log(chalk.gray(`\n${total} issue(s) found`));
    }
    return;
  }

  // VERBOSE MODE (default): Show detailed output

  // Show import/file-level circular dependencies
  if (circularDependencies.length === 0) {
    console.log(chalk.green('✓ No import circular dependencies found'));
  } else {
    hasIssues = true;
    console.log(
      chalk.red(`\n❌ Found ${circularDependencies.length} import circular dependencies:\n`)
    );

    circularDependencies.forEach((dep: CircularDependency, index: number) => {
      console.log(
        chalk.yellow(`${index + 1}. ${path.relative(process.cwd(), dep.file)}:${dep.line}`)
      );
      console.log(chalk.gray(`   Hook: ${dep.hookName}`));
      console.log(chalk.gray(`   Cycle: ${dep.cycle.join(' → ')}`));
      console.log();
    });
  }

  // Show cross-file cycles
  if (crossFileCycles.length === 0) {
    console.log(chalk.green('✓ No cross-file import cycles found'));
  } else {
    hasIssues = true;
    console.log(chalk.red(`\n❌ Found ${crossFileCycles.length} cross-file import cycles:\n`));

    crossFileCycles.forEach((cycle: CrossFileCycle, index: number) => {
      console.log(chalk.yellow(`${index + 1}. Import cycle between files:`));

      const relativeFiles = cycle.files.map((file: string) => path.relative(process.cwd(), file));
      console.log(chalk.gray(`   ${relativeFiles.join(' → ')}`));

      if (cycle.dependencies.length > 0) {
        console.log(
          chalk.cyan(
            `   Fix: Remove one of these imports or refactor shared code into a separate file`
          )
        );
      }
      console.log();
    });
  }

  // Show React hooks analysis results
  if (totalHooksIssues === 0) {
    console.log(chalk.green('✓ No React hooks dependency issues found'));
  } else {
    hasIssues = true;

    // Show confirmed infinite loops first (critical issues)
    if (confirmedIssues.length > 0) {
      console.log(chalk.red(`\n🚨 Found ${confirmedIssues.length} CONFIRMED infinite loop(s):\n`));

      confirmedIssues.forEach((issue, index: number) => {
        const categoryLabel =
          issue.category === 'critical' ? 'CRITICAL' : issue.category.toUpperCase();
        console.log(
          chalk.redBright(
            `${index + 1}. 🚨 [${issue.errorCode}] ${categoryLabel} - Infinite re-render`
          )
        );
        console.log(
          chalk.redBright(`   Severity: ${issue.severity} | Confidence: ${issue.confidence}`)
        );
        console.log();

        displayIssue(issue, debug);
      });
    }

    // Separate performance issues from warning issues
    const warningIssues = potentialIssues.filter((issue) => issue.category === 'warning');
    const performanceIssues = potentialIssues.filter((issue) => issue.category === 'performance');

    // Show warning issues
    if (warningIssues.length > 0) {
      console.log(chalk.yellow(`\n⚠️  Found ${warningIssues.length} warning(s) to review:\n`));

      warningIssues.forEach((issue, index: number) => {
        console.log(
          chalk.yellow(
            `${confirmedIssues.length + index + 1}. ⚠️  [${issue.errorCode}] WARNING - ${issue.description}`
          )
        );
        console.log(
          chalk.yellow(`   Severity: ${issue.severity} | Confidence: ${issue.confidence}`)
        );
        console.log();

        displayIssue(issue, debug);
      });
    }

    // Show performance issues
    if (performanceIssues.length > 0) {
      console.log(chalk.cyan(`\n📊 Found ${performanceIssues.length} performance issue(s):\n`));

      performanceIssues.forEach((issue, index: number) => {
        console.log(
          chalk.cyan(
            `${confirmedIssues.length + warningIssues.length + index + 1}. 📊 [${issue.errorCode}] PERFORMANCE - ${issue.description}`
          )
        );
        console.log(chalk.cyan(`   Severity: ${issue.severity} | Confidence: ${issue.confidence}`));
        console.log();

        displayIssue(issue, debug);
      });
    }
  }

  if (!hasIssues) {
    console.log(chalk.green('\nNo circular dependencies or hooks issues found!'));
    console.log(chalk.gray('Your React hooks are properly configured.'));
  }

  // Summary
  const importCyclesCount = circularDependencies.length + crossFileCycles.length;
  const warningIssues = potentialIssues.filter((issue) => issue.category === 'warning');
  const performanceIssues = potentialIssues.filter((issue) => issue.category === 'performance');

  console.log(chalk.blue('\nSummary:'));
  console.log(chalk.gray(`Files analyzed: ${summary.filesAnalyzed}`));
  console.log(chalk.gray(`Hooks analyzed: ${summary.hooksAnalyzed}`));

  const totalCriticalIssues = importCyclesCount + confirmedIssues.length;
  if (totalCriticalIssues > 0) {
    console.log(chalk.red(`Critical issues: ${totalCriticalIssues}`));
    console.log(chalk.gray(`  Import cycles: ${importCyclesCount}`));
    console.log(chalk.gray(`  Confirmed infinite loops: ${confirmedIssues.length}`));
  }

  if (warningIssues.length > 0) {
    console.log(chalk.yellow(`Warnings to review: ${warningIssues.length}`));
  }

  if (performanceIssues.length > 0) {
    console.log(chalk.cyan(`Performance issues: ${performanceIssues.length}`));
  }

  if (totalCriticalIssues === 0 && potentialIssues.length === 0) {
    console.log(chalk.green(`No issues found`));
  }
}

// Watch command for continuous monitoring
program
  .command('watch <path>')
  .description('Watch for file changes and re-analyze automatically')
  .option('-p, --pattern <pattern>', 'Glob pattern for files to analyze', '**/*.{js,jsx,ts,tsx}')
  .option('-i, --ignore <patterns...>', 'Patterns to ignore', [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
  ])
  .option('--min-severity <level>', 'Minimum severity to report (high, medium, low)', 'low')
  .option(
    '--min-confidence <level>',
    'Minimum confidence to report (high, medium, low). Default: medium',
    'medium'
  )
  .option('--confirmed-only', 'Only report confirmed infinite loops')
  .option('--compact', 'Compact output format')
  .action(async (targetPath: string, watchOptions: Partial<CliOptions>) => {
    const absolutePath = path.resolve(targetPath);

    if (!fs.existsSync(absolutePath)) {
      console.error(chalk.red(`Error: Path "${absolutePath}" does not exist`));
      process.exit(1);
    }

    console.log(chalk.blue(`\n👀 Watching for changes in: ${absolutePath}`));
    console.log(chalk.gray(`Pattern: ${watchOptions.pattern}`));
    console.log(chalk.gray('Press Ctrl+C to stop\n'));

    // Run initial analysis
    let isAnalyzing = false;
    let pendingAnalysis = false;

    const runAnalysis = async () => {
      if (isAnalyzing) {
        pendingAnalysis = true;
        return;
      }

      isAnalyzing = true;
      console.log(chalk.gray(`\n[${new Date().toLocaleTimeString()}] Analyzing...`));

      try {
        const results = await detectCircularDependencies(absolutePath, {
          pattern: watchOptions.pattern || '**/*.{js,jsx,ts,tsx}',
          ignore: watchOptions.ignore || [],
          config: {
            minSeverity: watchOptions.minSeverity as 'high' | 'medium' | 'low',
            minConfidence: watchOptions.minConfidence as 'high' | 'medium' | 'low',
            includePotentialIssues: !watchOptions.confirmedOnly,
          },
        });

        // Clear terminal for fresh output
        console.clear();
        console.log(chalk.blue(`👀 Watching: ${absolutePath}`));
        console.log(chalk.gray(`[${new Date().toLocaleTimeString()}] Last analysis\n`));

        formatResults(results, watchOptions.compact);
      } catch (error) {
        console.error(chalk.red('Error during analysis:'), error);
      }

      isAnalyzing = false;

      if (pendingAnalysis) {
        pendingAnalysis = false;
        runAnalysis();
      }
    };

    // Run initial analysis
    await runAnalysis();

    // Watch for changes
    const watcher = chokidar.watch(
      path.join(absolutePath, watchOptions.pattern || '**/*.{js,jsx,ts,tsx}'),
      {
        ignored: watchOptions.ignore || ['**/node_modules/**', '**/.git/**'],
        persistent: true,
        ignoreInitial: true,
      }
    );

    // Debounce file changes
    let debounceTimer: NodeJS.Timeout | null = null;

    watcher.on('change', (changedPath) => {
      console.log(chalk.yellow(`\n📝 Changed: ${path.relative(absolutePath, changedPath)}`));

      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = setTimeout(() => {
        runAnalysis();
      }, 300);
    });

    watcher.on('add', (addedPath) => {
      console.log(chalk.green(`\n➕ Added: ${path.relative(absolutePath, addedPath)}`));

      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = setTimeout(() => {
        runAnalysis();
      }, 300);
    });

    watcher.on('unlink', (removedPath) => {
      console.log(chalk.red(`\n➖ Removed: ${path.relative(absolutePath, removedPath)}`));

      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = setTimeout(() => {
        runAnalysis();
      }, 300);
    });

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log(chalk.blue('\n\n👋 Stopping watch mode...'));
      watcher.close();
      process.exit(0);
    });
  });

// Init command to generate default config file
program
  .command('init')
  .description('Generate a default rld.config.json configuration file')
  .action(() => {
    const configPath = path.join(process.cwd(), 'rld.config.json');

    if (fs.existsSync(configPath)) {
      console.log(chalk.yellow(`Config file already exists: ${configPath}`));
      console.log(chalk.gray('Delete it first if you want to regenerate.'));
      process.exit(1);
    }

    const defaultConfig = {
      stableHooks: ['useQuery', 'useSelector', 'useTranslation'],
      unstableHooks: [],
      customFunctions: {
        // Example: "useApi": { "stable": true },
        // Example: "makeRequest": { "deferred": true }
      },
      ignore: [],
      minSeverity: 'low',
      minConfidence: 'low',
      includePotentialIssues: true,
    };

    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2) + '\n');
    console.log(chalk.green(`Created ${configPath}`));
    console.log(chalk.gray('\nConfiguration options:'));
    console.log(chalk.gray('  stableHooks: Hooks that return stable references (e.g., useQuery)'));
    console.log(chalk.gray('  unstableHooks: Hooks that return unstable references'));
    console.log(chalk.gray('  customFunctions: Custom function stability settings'));
    console.log(chalk.gray('  ignore: Additional patterns to ignore'));
    console.log(chalk.gray('  minSeverity: Minimum severity to report (high, medium, low)'));
    console.log(chalk.gray('  minConfidence: Minimum confidence to report (high, medium, low)'));
    console.log(chalk.gray('  includePotentialIssues: Include potential issues in results'));
  });

program.parse();
