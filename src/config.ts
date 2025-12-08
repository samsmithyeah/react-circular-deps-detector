import * as fs from 'fs';
import * as path from 'path';

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
}

const CONFIG_FILES = ['rld.config.js', 'rld.config.json', '.rldrc', '.rldrc.json'];

/**
 * Default configuration
 */
export const DEFAULT_CONFIG: Required<RcdConfig> = {
  stableHooks: [],
  unstableHooks: [],
  ignore: [],
  minSeverity: 'low',
  minConfidence: 'low',
  includePotentialIssues: true,
  customFunctions: {},
  strictMode: false,
  tsconfigPath: undefined as unknown as string,
};

/**
 * Load configuration from the nearest config file
 * @param startDir Directory to start searching from
 * @returns Merged configuration with defaults
 */
export function loadConfig(startDir: string): Required<RcdConfig> {
  const configPath = findConfigFile(startDir);

  if (!configPath) {
    return DEFAULT_CONFIG;
  }

  try {
    const config = loadConfigFile(configPath);
    return mergeConfig(DEFAULT_CONFIG, config);
  } catch (error) {
    console.warn(`Warning: Could not load config from ${configPath}:`, error);
    return DEFAULT_CONFIG;
  }
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
 * Merge user config with defaults
 */
function mergeConfig(defaults: Required<RcdConfig>, userConfig: RcdConfig): Required<RcdConfig> {
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
