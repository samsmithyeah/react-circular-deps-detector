/**
 * Control Flow Graph module for analyzing code execution paths.
 *
 * This module provides:
 * - CFG construction from Babel AST
 * - Reachability analysis
 * - Path condition extraction
 * - Guard effectiveness analysis
 * - setState-specific analysis for React hooks
 * - Visualization utilities
 */

// Types
export type {
  CFG,
  CFGNode,
  CFGNodeType,
  CFGEdgeType,
  CFGBuilderOptions,
  CFGBuilderContext,
  LoopContext,
  TryContext,
  SwitchContext,
  BreakableContext,
  ReachabilityResult,
  PathCondition,
  GuardAnalysis,
  SetStateAnalysisResult,
} from './cfg-types';

// Builder
export { buildCFG, CFGBuilder } from './cfg-builder';

// Analyzer
export {
  analyzeReachability,
  findAllPaths,
  extractPathConditions,
  isGuaranteedToExecute,
  analyzeGuards,
  conditionInvolvesVariable,
  computeDominators,
} from './cfg-analyzer';

// setState Analyzer (React-specific)
export {
  analyzeSetStateCalls,
  hasUnconditionalSetStateCFG,
  type SetStateAnalysis,
} from './setState-analyzer';

// Visualizer
export { cfgToDot, cfgStats, type DotOptions } from './cfg-visualizer';
