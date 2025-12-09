import * as fs from 'fs';
import * as path from 'path';
import { detectApplicablePresets, getDetectedPresetNames, mergePresets } from './presets';

/**
 * Configuration schema for rcd (React Circular Dependencies detector)
 */
export interface RcdConfig {
  /**
   * Hooks that are known to return stable references (won't cause re-renders)
   * @example ["useQuery", "useSelector", "useTranslation"]
   */
  stableHooks?: string[];

  /**
   * Hooks that are known to return unstable references
   * @example ["useUnstableThirdPartyThing"]
   */
  unstableHooks?: string[];

  /**
   * Files or patterns to ignore during analysis
   * Example: ["src/generated", "*.test.tsx"]
   */
  ignore?: string[];

  /**
   * Minimum severity level to report
   * @default "low"
   */
  minSeverity?: 'high' | 'medium' | 'low';

  /**
   * Minimum confidence level to report
   * @default "low"
   */
  minConfidence?: 'high' | 'medium' | 'low';

  /**
   * Whether to include potential issues (not just confirmed loops)
   * @default true
   */
  includePotentialIssues?: boolean;

  /**
   * Custom rules for specific functions
   * Keys are function names, values are stability info
   */
  customFunctions?: Record<
    string,
    {
      /** Whether this function returns stable references */
      stable?: boolean;
      /** Whether this function is async/deferred (won't cause immediate re-renders) */
      deferred?: boolean;
    }
  >;

  /**
   * Enable strict mode using TypeScript Compiler API for more accurate stability detection.
   * Requires a TypeScript project with tsconfig.json.
   * This mode is slower but provides type-based stability analysis instead of heuristics.
   * @default false
   */
  strictMode?: boolean;

  /**
   * Custom path to tsconfig.json (only used when strictMode is enabled)
   * If not specified, will search upward from the target directory.
   */
  tsconfigPath?: string;

  /**
   * Disable automatic detection of library presets from package.json.
   * When false (default), the tool will auto-detect installed libraries
   * (e.g., React Query, Redux, Zustand) and apply their stable hook configurations.
   * @default false
   */
  noPresets?: boolean;
}

const CONFIG_FILES = ['rld.config.js', 'rld.config.json', '.rldrc', '.rldrc.json'];

/**
 * Default configuration
 *
 * Note: minConfidence defaults to 'medium' to reduce alert fatigue.
 * Low-confidence detections are hidden by default since they may be false positives.
 * Users can set minConfidence: 'low' to see all detections including uncertain ones.
 */
export const DEFAULT_CONFIG: Required<RcdConfig> = {
  stableHooks: [],
  unstableHooks: [],
  ignore: [],
  minSeverity: 'low',
  minConfidence: 'medium', // Default to medium to reduce false positives
  includePotentialIssues: true,
  customFunctions: {},
  strictMode: false,
  tsconfigPath: undefined as unknown as string,
  noPresets: false,
};

/**
 * Result of loading config, including detected presets info
 */
export interface LoadConfigResult {
  config: Required<RcdConfig>;
  detectedPresets: string[];
  configPath: string | null;
}

/**
 * Load configuration from the nearest config file
 * @param startDir Directory to start searching from
 * @param options Options for loading
 * @returns Merged configuration with defaults
 */
export function loadConfig(startDir: string, options?: { verbose?: boolean }): Required<RcdConfig> {
  const result = loadConfigWithInfo(startDir, options);
  return result.config;
}

/**
 * Load configuration and return additional info about what was detected
 * @param startDir Directory to start searching from
 * @param options Options for loading
 * @returns Config along with detected presets and config path info
 */
export function loadConfigWithInfo(
  startDir: string,
  options?: { verbose?: boolean; noPresets?: boolean }
): LoadConfigResult {
  const configPath = findConfigFile(startDir);
  let userConfig: RcdConfig = {};

  if (configPath) {
    try {
      userConfig = loadConfigFile(configPath);
    } catch (error) {
      console.warn(`Warning: Could not load config from ${configPath}:`, error);
    }
  }

  // Check if presets are disabled (CLI flag takes precedence over config file)
  const noPresets = options?.noPresets ?? userConfig.noPresets ?? DEFAULT_CONFIG.noPresets;

  // Detect and apply presets if not disabled
  let presetConfig: Partial<RcdConfig> = {};
  let detectedPresets: string[] = [];

  if (!noPresets) {
    const packageJsonPath = findPackageJson(startDir);
    if (packageJsonPath) {
      const dependencies = readDependencies(packageJsonPath);
      const applicablePresets = detectApplicablePresets(dependencies);

      if (applicablePresets.length > 0) {
        detectedPresets = getDetectedPresetNames(dependencies);
        const merged = mergePresets(applicablePresets);
        presetConfig = {
          stableHooks: merged.stableHooks,
          unstableHooks: merged.unstableHooks,
          customFunctions: merged.customFunctions,
        };

        if (options?.verbose) {
          console.log(`Auto-detected library presets: ${detectedPresets.join(', ')}`);
        }
      }
    }
  }

  // Merge order: defaults < presets < user config (user config wins)
  const config = mergeConfig(mergeConfig(DEFAULT_CONFIG, presetConfig), userConfig);

  return {
    config,
    detectedPresets,
    configPath,
  };
}

/**
 * Find the nearest config file by walking up the directory tree
 */
function findConfigFile(startDir: string): string | null {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;

  while (dir !== root) {
    for (const configFile of CONFIG_FILES) {
      const configPath = path.join(dir, configFile);
      if (fs.existsSync(configPath)) {
        return configPath;
      }
    }
    dir = path.dirname(dir);
  }

  return null;
}

/**
 * Load and parse a config file
 */
function loadConfigFile(configPath: string): RcdConfig {
  const ext = path.extname(configPath);

  if (ext === '.json' || configPath.endsWith('.rcdrc')) {
    const content = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(content);
  }

  if (ext === '.js') {
    // For CommonJS config files, use require

    const config = require(configPath);
    return config.default || config;
  }

  if (ext === '.mjs') {
    // ESM modules cannot be loaded synchronously with require()
    // Users should use .js (CommonJS) or .json config files
    throw new Error(
      `ESM config files (.mjs) are not supported. Please use rld.config.js (CommonJS) or rld.config.json instead.`
    );
  }

  throw new Error(`Unsupported config file format: ${ext}`);
}

/**
 * Find the nearest package.json by walking up the directory tree
 */
function findPackageJson(startDir: string): string | null {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;

  while (dir !== root) {
    const packagePath = path.join(dir, 'package.json');
    if (fs.existsSync(packagePath)) {
      return packagePath;
    }
    dir = path.dirname(dir);
  }

  return null;
}

/**
 * Read dependencies from a package.json file
 * @returns Combined dependencies and devDependencies
 */
function readDependencies(packageJsonPath: string): Record<string, string> {
  try {
    const content = fs.readFileSync(packageJsonPath, 'utf-8');
    const pkg = JSON.parse(content);
    return {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };
  } catch (error) {
    console.warn(`Warning: Could not read dependencies from ${packageJsonPath}:`, error);
    return {};
  }
}

/**
 * Merge user config with defaults
 */
export function mergeConfig(
  defaults: Required<RcdConfig>,
  userConfig: Partial<RcdConfig>
): Required<RcdConfig> {
  return {
    stableHooks: [...defaults.stableHooks, ...(userConfig.stableHooks || [])],
    unstableHooks: [...defaults.unstableHooks, ...(userConfig.unstableHooks || [])],
    ignore: [...defaults.ignore, ...(userConfig.ignore || [])],
    minSeverity: userConfig.minSeverity ?? defaults.minSeverity,
    minConfidence: userConfig.minConfidence ?? defaults.minConfidence,
    includePotentialIssues: userConfig.includePotentialIssues ?? defaults.includePotentialIssues,
    customFunctions: { ...defaults.customFunctions, ...userConfig.customFunctions },
    strictMode: userConfig.strictMode ?? defaults.strictMode,
    tsconfigPath: userConfig.tsconfigPath ?? defaults.tsconfigPath,
    noPresets: userConfig.noPresets ?? defaults.noPresets,
  };
}

/**
 * Get severity level as a number for comparison
 */
export function severityLevel(severity: 'high' | 'medium' | 'low'): number {
  switch (severity) {
    case 'high':
      return 3;
    case 'medium':
      return 2;
    case 'low':
      return 1;
  }
}

/**
 * Get confidence level as a number for comparison
 */
export function confidenceLevel(confidence: 'high' | 'medium' | 'low'): number {
  switch (confidence) {
    case 'high':
      return 3;
    case 'medium':
      return 2;
    case 'low':
      return 1;
  }
}
