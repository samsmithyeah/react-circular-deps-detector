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

      // Only exit with error for critical issues
      const criticalIssues = results.circularDependencies.length + results.crossFileCycles.length;
      const confirmedLoops = results.intelligentHooksAnalysis 
        ? results.intelligentHooksAnalysis.filter((issue: any) => issue.type === 'confirmed-infinite-loop').length
        : results.hooksDependencyLoops.length + results.simpleHooksLoops.length + results.improvedHooksLoops.length;
      
      if (criticalIssues > 0 || confirmedLoops > 0) {
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

function displayIntelligentIssue(issue: any) {
  // Show location
  console.log(chalk.blue(`    📍 Location:`));
  console.log(chalk.gray(`       ${path.relative(process.cwd(), issue.file)}:${issue.line}`));
  console.log(chalk.gray(`       ${issue.hookType}${issue.functionName ? ` in ${issue.functionName}()` : ''}`));
  console.log();
  
  // Show the problem in simple terms
  console.log(chalk.blue(`    ❌ Problem:`));
  if (issue.type === 'confirmed-infinite-loop') {
    console.log(chalk.gray(`       This hook depends on '${issue.problematicDependency}' and modifies it, creating an infinite loop:`));
    console.log(chalk.gray(`       ${issue.problematicDependency} changes → hook runs → calls ${issue.setterFunction}() → ${issue.problematicDependency} changes → repeats forever`));
  } else {
    console.log(chalk.gray(`       This hook depends on '${issue.problematicDependency}' and conditionally modifies it.`));
    console.log(chalk.gray(`       If the condition doesn't prevent updates, this creates an infinite loop.`));
  }
  console.log();
  
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
  
  console.log();
}

function formatResults(results: any, options: any) {
  const { circularDependencies, crossFileCycles, hooksDependencyLoops, simpleHooksLoops, improvedHooksLoops, intelligentHooksAnalysis, summary } = results;
  
  let hasIssues = false;
  
  // Use intelligent analysis if available, otherwise fall back to basic analyzers
  const hooksIssues = intelligentHooksAnalysis && intelligentHooksAnalysis.length > 0 
    ? intelligentHooksAnalysis
    : [
        ...hooksDependencyLoops,
        ...simpleHooksLoops, 
        ...improvedHooksLoops
      ];
  
  // Separate intelligent analysis by severity and type
  const confirmedIssues = hooksIssues.filter((issue: any) => issue.type === 'confirmed-infinite-loop');
  const potentialIssues = hooksIssues.filter((issue: any) => issue.type === 'potential-issue');
  const safePatterns = hooksIssues.filter((issue: any) => issue.type === 'safe-pattern');
  
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
  
  // Show React hooks analysis results
  if (confirmedIssues.length === 0 && potentialIssues.length === 0) {
    console.log(chalk.green('✓ No React hooks dependency issues found'));
  } else {
    hasIssues = true;
    
    // Show confirmed infinite loops first (critical issues)
    if (confirmedIssues.length > 0) {
      console.log(chalk.red(`\n🚨 Found ${confirmedIssues.length} CONFIRMED infinite loop(s):\n`));
      
      confirmedIssues.forEach((issue: any, index: number) => {
        console.log(chalk.redBright(`${index + 1}. 🚨  GUARANTEED infinite re-render (high severity)`));
        console.log(chalk.redBright(`   Confidence: ${issue.confidence}`));
        console.log();
        
        displayIntelligentIssue(issue);
      });
    }
    
    // Show potential issues
    if (potentialIssues.length > 0) {
      console.log(chalk.yellow(`\n⚠️  Found ${potentialIssues.length} potential issue(s) to review:\n`));
      
      potentialIssues.forEach((issue: any, index: number) => {
        console.log(chalk.yellow(`${confirmedIssues.length + index + 1}. ⚠️  Potential infinite re-render (${issue.severity} severity)`));
        console.log(chalk.yellow(`   Confidence: ${issue.confidence}`));
        console.log();
        
        displayIntelligentIssue(issue);
      });
    }
  }
  
  if (!hasIssues) {
    console.log(chalk.green('\nNo circular dependencies or hooks issues found!'));
    console.log(chalk.gray('Your React hooks are properly configured.'));
  }

  // Intelligent summary
  const totalCriticalIssues = circularDependencies.length + crossFileCycles.length + confirmedIssues.length;
  const totalAllIssues = totalCriticalIssues + potentialIssues.length;
  
  console.log(chalk.blue('\nSummary:'));
  console.log(chalk.gray(`Files analyzed: ${summary.filesAnalyzed}`));
  console.log(chalk.gray(`Hooks analyzed: ${summary.hooksAnalyzed}`));
  
  if (intelligentHooksAnalysis && intelligentHooksAnalysis.length > 0) {
    // Show intelligent analysis summary
    if (totalCriticalIssues > 0) {
      console.log(chalk.red(`Critical issues: ${totalCriticalIssues}`));
      console.log(chalk.gray(`  Import cycles: ${circularDependencies.length + crossFileCycles.length}`));
      console.log(chalk.gray(`  Confirmed infinite loops: ${confirmedIssues.length}`));
    }
    
    if (potentialIssues.length > 0) {
      console.log(chalk.yellow(`Potential issues to review: ${potentialIssues.length}`));
    }
    
    if (totalCriticalIssues === 0 && potentialIssues.length === 0) {
      console.log(chalk.green(`No issues found`));
    }
  } else {
    // Fallback to basic summary
    if (totalAllIssues > 0) {
      console.log(chalk.red(`Issues found: ${totalAllIssues}`));
      console.log(chalk.gray(`  Import cycles: ${circularDependencies.length + crossFileCycles.length}`));
      console.log(chalk.gray(`  Hooks issues: ${hooksIssues.length}`));
    } else {
      console.log(chalk.green(`No issues found`));
    }
  }
}

program.parse();