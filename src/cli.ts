#!/usr/bin/env node

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import chalk from 'chalk';
import { detectCircularDependencies } from './detector';

const program = new Command();

program
  .name('react-circular-deps')
  .description('CLI tool to detect circular dependencies in React hooks dependency arrays')
  .version('1.0.0')
  .argument('<path>', 'Path to React project or file to analyze')
  .option('-p, --pattern <pattern>', 'Glob pattern for files to analyze', '**/*.{js,jsx,ts,tsx}')
  .option('-i, --ignore <patterns...>', 'Patterns to ignore', ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.expo/**', '**/.next/**', '**/.nuxt/**', '**/.cache/**'])
  .option('--json', 'Output results as JSON')
  .option('--no-color', 'Disable colored output')
  .action(async (targetPath: string, options: any) => {
    try {
      const absolutePath = path.resolve(targetPath);
      
      if (!fs.existsSync(absolutePath)) {
        console.error(chalk.red(`Error: Path "${absolutePath}" does not exist`));
        process.exit(1);
      }

      console.log(chalk.blue(`Analyzing React hooks in: ${absolutePath}`));
      console.log(chalk.gray(`Pattern: ${options.pattern}`));
      
      const results = await detectCircularDependencies(absolutePath, {
        pattern: options.pattern,
        ignore: options.ignore,
      });

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        formatResults(results, options);
      }

      if (results.circularDependencies.length > 0) {
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

function formatResults(results: any, options: any) {
  const { circularDependencies, summary } = results;
  
  if (circularDependencies.length === 0) {
    console.log(chalk.green('\n✓ No circular dependencies found!'));
  } else {
    console.log(chalk.red(`\n✗ Found ${circularDependencies.length} circular dependencies:\n`));
    
    circularDependencies.forEach((dep: any, index: number) => {
      console.log(chalk.yellow(`${index + 1}. ${dep.file}:${dep.line}`));
      console.log(chalk.gray(`   Hook: ${dep.hookName}`));
      console.log(chalk.gray(`   Cycle: ${dep.cycle.join(' → ')}`));
      console.log();
    });
  }

  console.log(chalk.blue('\nSummary:'));
  console.log(chalk.gray(`  Files analyzed: ${summary.filesAnalyzed}`));
  console.log(chalk.gray(`  Hooks analyzed: ${summary.hooksAnalyzed}`));
  console.log(chalk.gray(`  Circular dependencies: ${summary.circularDependencies}`));
}

program.parse();