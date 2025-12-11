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
  StrictModeDetection,
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

export {
  detectSetStateDuringRender,
  detectRefMutationDuringRender,
  isInsideSafeContext,
} from './render-phase-detector';

export {
  analyzeConditionalGuard,
  analyzeCondition,
  checkEarlyReturnPattern,
} from './guard-analyzer';

export {
  detectUseEffectWithoutDeps,
  analyzeStateInteractions,
  buildLocalFunctionSetterMap,
} from './effect-analyzer';

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
export {
  loadConfig,
  loadConfigWithInfo,
  LoadConfigResult,
  mergeConfig,
  RcdConfig,
  DEFAULT_CONFIG,
  severityLevel,
  confidenceLevel,
} from './config';

// Library presets
export {
  LIBRARY_PRESETS,
  LibraryPreset,
  detectApplicablePresets,
  mergePresets,
  getDetectedPresetNames,
} from './presets';

// Cache
export { AstCache, CacheableParsedData } from './cache';

// Cross-file analysis
export { analyzeCrossFileRelations, CrossFileAnalysis } from './cross-file-analyzer';

// Module graph
export { buildModuleGraph, detectAdvancedCrossFileCycles, CrossFileCycle } from './module-graph';

// Type checker (for strict mode)
export {
  TypeChecker,
  TypeCheckerPool,
  createTypeChecker,
  getPersistentTypeChecker,
  getPersistentTypeCheckerPool,
  disposePersistentTypeChecker,
  disposePersistentTypeCheckerPool,
  disposeAllPersistentTypeCheckers,
  disposeAllPersistentTypeCheckerPools,
  isTypeScriptProject,
  TypeInfo,
  TypeCheckerOptions,
} from './type-checker';

// Tsconfig manager (for monorepo support)
export {
  TsconfigManager,
  TsconfigInfo,
  WorkspacePackage,
  MonorepoInfo,
  createTsconfigManager,
} from './tsconfig-manager';

// Path resolver
export {
  createPathResolver,
  createMultiProjectPathResolver,
  PathResolver,
  PathResolverOptions,
  MultiProjectPathResolver,
  MultiProjectPathResolverOptions,
} from './path-resolver';
