#!/usr/bin/env node

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import chalk from 'chalk';
import { detectCircularDependencies } from './detector';

const program = new Command();

program
  .name('react-circular-deps')
  .description('Detect circular import dependencies and React hooks infinite re-render risks')
  .version('1.0.0')
  .argument('<path>', 'Path to React project or file to analyze')
  .option('-p, --pattern <pattern>', 'Glob pattern for files to analyze', '**/*.{js,jsx,ts,tsx}')
  .option('-i, --ignore <patterns...>', 'Patterns to ignore', ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.expo/**', '**/.next/**', '**/.nuxt/**', '**/.cache/**'])
  .option('--json', 'Output results as JSON')
  .option('--no-color', 'Disable colored output')
  .action(async (targetPath: string, options: any) => {
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

      if (!options.json) {
        console.log(chalk.blue(`Analyzing React hooks in: ${absolutePath}`));
        console.log(chalk.gray(`Pattern: ${options.pattern}`));
      }
      
      const results = await detectCircularDependencies(absolutePath, {
        pattern: options.pattern,
        ignore: options.ignore,
      });

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        formatResults(results, options);
      }

      if (results.circularDependencies.length > 0 || results.crossFileCycles.length > 0 || results.hooksDependencyLoops.length > 0 || results.simpleHooksLoops.length > 0 || results.improvedHooksLoops.length > 0) {
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

function formatResults(results: any, options: any) {
  const { circularDependencies, crossFileCycles, hooksDependencyLoops, simpleHooksLoops, improvedHooksLoops, summary } = results;
  
  let hasIssues = false;
  
  // Combine all hooks-related issues for cleaner output
  const allHooksIssues = [
    ...hooksDependencyLoops,
    ...simpleHooksLoops, 
    ...improvedHooksLoops
  ];
  
  // Show import/file-level circular dependencies
  if (circularDependencies.length === 0) {
    console.log(chalk.green('✓ No import circular dependencies found'));
  } else {
    hasIssues = true;
    console.log(chalk.red(`\n❌ Found ${circularDependencies.length} import circular dependencies:\n`));
    
    circularDependencies.forEach((dep: any, index: number) => {
      console.log(chalk.yellow(`${index + 1}. ${path.relative(process.cwd(), dep.file)}:${dep.line}`));
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
    
    crossFileCycles.forEach((cycle: any, index: number) => {
      console.log(chalk.yellow(`${index + 1}. Import cycle between files:`));
      
      const relativeFiles = cycle.files.map((file: string) => path.relative(process.cwd(), file));
      console.log(chalk.gray(`   ${relativeFiles.join(' → ')}`));
      
      if (cycle.dependencies.length > 0) {
        console.log(chalk.cyan(`   Fix: Remove one of these imports or refactor shared code into a separate file`));
      }
      console.log();
    });
  }
  
  // Show React hooks dependency issues
  if (allHooksIssues.length === 0) {
    console.log(chalk.green('✓ No React hooks dependency issues found'));
  } else {
    hasIssues = true;
    console.log(chalk.red(`\n❌ Found ${allHooksIssues.length} React hooks dependency issues:\n`));
    
    allHooksIssues.forEach((issue: any, index: number) => {
      const severityColor = issue.severity === 'high' ? chalk.redBright : chalk.yellow;
      const severityIcon = issue.severity === 'high' ? '🚨' : '⚠️';
      
      // Main issue header with better spacing
      console.log(severityColor(`${index + 1}. ${severityIcon}  Infinite re-render risk (${issue.severity} severity)`));
      console.log();
      
      // Show location with indentation
      const file = issue.file || (issue.files && issue.files[0]);
      if (file) {
        console.log(chalk.blue(`    📍 Location:`));
        console.log(chalk.gray(`       ${path.relative(process.cwd(), file)}${issue.line ? ':' + issue.line : ''}`));
        console.log();
      }
      
      // Show hook and function info
      const hookType = issue.hookType || issue.hookName || 'React hook';
      console.log(chalk.blue(`    🎣 Hook:`));
      console.log(chalk.gray(`       ${hookType}${issue.functionName ? ` (function: ${issue.functionName})` : ''}`));
      console.log();
      
      // Show the problem
      const dependency = issue.problematicDependency || 
                        (issue.stateVariables && issue.stateVariables[0]) ||
                        'Unknown';
      console.log(chalk.blue(`    ⚠️  Problem:`));
      console.log(chalk.gray(`       Depends on '${dependency}' but may modify it`));
      
      // Show state/setter relationship if available
      if (issue.stateVariable && issue.setterFunction) {
        console.log(chalk.gray(`       ${issue.stateVariable} → ${issue.setterFunction}`));
      }
      console.log();
      
      // Show fix suggestion with better formatting
      console.log(chalk.blue(`    💡 Solution:`));
      if (issue.severity === 'high') {
        console.log(chalk.cyan(`       Remove '${dependency}' from dependencies or use stable references`));
      } else {
        console.log(chalk.cyan(`       Review if '${dependency}' dependency is necessary`));
      }
      
      console.log();
      console.log();
    });
  }
  
  if (!hasIssues) {
    console.log(chalk.green('\nNo circular dependencies or hooks issues found!'));
    console.log(chalk.gray('Your React hooks are properly configured.'));
  }

  // Simplified summary
  const totalIssues = circularDependencies.length + crossFileCycles.length + allHooksIssues.length;
  
  console.log(chalk.blue('\nSummary:'));
  console.log(chalk.gray(`Files analyzed: ${summary.filesAnalyzed}`));
  console.log(chalk.gray(`Hooks analyzed: ${summary.hooksAnalyzed}`));
  if (totalIssues > 0) {
    console.log(chalk.red(`Issues found: ${totalIssues}`));
    console.log(chalk.gray(`  Import cycles: ${circularDependencies.length + crossFileCycles.length}`));
    console.log(chalk.gray(`  Hooks issues: ${allHooksIssues.length}`));
  } else {
    console.log(chalk.green(`No issues found`));
  }
}

program.parse();