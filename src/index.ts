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

// Intelligent hooks analysis
export {
  analyzeHooksIntelligently,
  IntelligentHookAnalysis,
  AnalyzerOptions,
  isConfiguredStableHook,
  isConfiguredUnstableHook,
  isConfiguredStableFunction,
  isConfiguredDeferredFunction,
} from './intelligent-hooks-analyzer';

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
