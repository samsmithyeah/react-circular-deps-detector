/**
 * React Loop Detector
 *
 * A tool to detect circular dependencies and infinite re-render risks in React hooks.
 *
 * @example
 * ```typescript
 * import { detectCircularDependencies } from 'react-loop-detector';
 *
 * const results = await detectCircularDependencies('./src', {
 *   pattern: '**\/*.{tsx,ts}',
 *   ignore: ['**\/node_modules/**'],
 * });
 *
 * console.log(results.intelligentHooksAnalysis);
 * ```
 */

// Core detector
export {
  detectCircularDependencies,
  DetectionResults,
  DetectorOptions,
  CircularDependency,
} from './detector';

// Intelligent hooks analysis (main entry point)
export {
  analyzeHooks,
  HookAnalysis,
  AnalyzerOptions,
  ErrorCode,
  IssueCategory,
  DebugInfo,
  isConfiguredStableHook,
  isConfiguredUnstableHook,
  isConfiguredStableFunction,
  isConfiguredDeferredFunction,
} from './orchestrator';

// Analyzer modules (for advanced usage)
export {
  extractStateInfo,
  extractUnstableVariables,
  UnstableVariable,
  StateAndRefInfo,
  StabilityConfig,
  StabilityCheckContext,
} from './state-extractor';

export { detectSetStateDuringRender, isInsideSafeContext } from './render-phase-detector';

export {
  analyzeConditionalGuard,
  analyzeCondition,
  checkEarlyReturnPattern,
} from './guard-analyzer';

export { detectUseEffectWithoutDeps, analyzeStateInteractions } from './effect-analyzer';

export { findHookNodes, analyzeHookNode } from './hook-analyzer';

export { checkUnstableReferences } from './unstable-refs-detector';

// Shared types and utilities
export {
  HookNodeInfo,
  StateInteraction,
  RefMutation,
  FunctionReference,
  GuardedModification,
  CreateAnalysisParams,
} from './types';

export { isHookIgnored, containsNode, createAnalysis, usesObjectSpread } from './utils';

// Parser
export {
  parseFile,
  parseFileWithCache,
  ParsedFile,
  HookInfo,
  ImportInfo,
  ExportInfo,
} from './parser';

// Configuration
export { loadConfig, RcdConfig, DEFAULT_CONFIG, severityLevel, confidenceLevel } from './config';

// Cache
export { AstCache, CacheableParsedData } from './cache';

// Cross-file analysis
export { analyzeCrossFileRelations, CrossFileAnalysis } from './cross-file-analyzer';

// Module graph
export { buildModuleGraph, detectAdvancedCrossFileCycles, CrossFileCycle } from './module-graph';

// Type checker (for strict mode)
export {
  TypeChecker,
  createTypeChecker,
  isTypeScriptProject,
  TypeInfo,
  TypeCheckerOptions,
} from './type-checker';

// Path resolver
export { createPathResolver, PathResolver, PathResolverOptions } from './path-resolver';
