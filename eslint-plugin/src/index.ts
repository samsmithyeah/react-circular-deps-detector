/**
 * ESLint Plugin for React Loop Detector
 *
 * This plugin provides single-file analysis rules to detect infinite re-render risks
 * in React hooks. For cross-file analysis, use the CLI tool (react-loop-detector).
 *
 * @example
 * ```javascript
 * // eslint.config.js
 * import reactLoopDetector from 'eslint-plugin-react-loop-detector';
 *
 * export default [
 *   {
 *     plugins: {
 *       'react-loop-detector': reactLoopDetector,
 *     },
 *     rules: {
 *       'react-loop-detector/no-render-phase-setstate': 'error',
 *       'react-loop-detector/no-effect-loop': 'error',
 *       'react-loop-detector/no-unstable-deps': 'warn',
 *       'react-loop-detector/no-missing-deps-array': 'error',
 *     },
 *   },
 * ];
 * ```
 */

import noRenderPhaseSetState from './rules/no-render-phase-setstate';
import noEffectLoop from './rules/no-effect-loop';
import noUnstableDeps from './rules/no-unstable-deps';
import noMissingDepsArray from './rules/no-missing-deps-array';

const rules = {
  'no-render-phase-setstate': noRenderPhaseSetState,
  'no-effect-loop': noEffectLoop,
  'no-unstable-deps': noUnstableDeps,
  'no-missing-deps-array': noMissingDepsArray,
};

const plugin = {
  meta: {
    name: 'eslint-plugin-react-loop-detector',
    version: '1.0.0',
  },
  rules,
  configs: {} as Record<string, unknown>,
};

// Flat config format (ESLint 9+)
plugin.configs = {
  recommended: {
    plugins: {
      'react-loop-detector': plugin,
    },
    rules: {
      'react-loop-detector/no-render-phase-setstate': 'error',
      'react-loop-detector/no-effect-loop': 'error',
      'react-loop-detector/no-unstable-deps': 'warn',
      'react-loop-detector/no-missing-deps-array': 'error',
    },
  },
  strict: {
    plugins: {
      'react-loop-detector': plugin,
    },
    rules: {
      'react-loop-detector/no-render-phase-setstate': 'error',
      'react-loop-detector/no-effect-loop': 'error',
      'react-loop-detector/no-unstable-deps': 'error',
      'react-loop-detector/no-missing-deps-array': 'error',
    },
  },
};

export = plugin;
