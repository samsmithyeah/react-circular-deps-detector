# React Loop Detector - VS Code Extension

Detect infinite re-render risks and circular dependencies in React hooks directly in your IDE.

## Features

- **Real-time Detection**: Instantly see potential infinite loop risks as you type
- **Cross-file Analysis**: Detect circular dependencies that span multiple files
- **Quick Fixes**: Add `// rld-ignore` comments with a single click
- **Configurable**: Supports `rld.config.json` for custom hook and function configurations

## Error Codes

| Code    | Category    | Description                                                              |
| ------- | ----------- | ------------------------------------------------------------------------ |
| RLD-100 | Critical    | setState called during render (synchronous loop)                         |
| RLD-101 | Critical    | Render phase setState via function call                                  |
| RLD-200 | Critical    | useEffect unconditional setState loop                                    |
| RLD-201 | Critical    | useEffect missing deps with setState                                     |
| RLD-202 | Critical    | useLayoutEffect unconditional setState loop                              |
| RLD-300 | Warning     | Cross-file loop risk                                                     |
| RLD-301 | Warning     | Cross-file conditional modification                                      |
| RLD-400 | Performance | Unstable object reference in deps                                        |
| RLD-401 | Performance | Unstable array reference in deps                                         |
| RLD-402 | Performance | Unstable function reference in deps                                      |
| RLD-403 | Performance | Unstable function call result in deps                                    |
| RLD-410 | Warning     | Object spread guard risk                                                 |
| RLD-420 | Warning     | useCallback/useMemo modifies dependency                                  |
| RLD-500 | Warning     | useEffect missing dependency array                                       |
| RLD-501 | Warning     | Conditional modification needs review                                    |
| RLD-600 | Warning     | Ref mutation with state value during render phase (effect-phase is safe) |

## Configuration

### Extension Settings

- `reactLoopDetector.enable`: Enable/disable the extension
- `reactLoopDetector.minSeverity`: Minimum severity level to report (`high`, `medium`, `low`)
- `reactLoopDetector.minConfidence`: Minimum confidence level to report (`high`, `medium`, `low`)
- `reactLoopDetector.strictMode`: Enable TypeScript-based stability detection
- `reactLoopDetector.debounceMs`: Debounce delay before re-analysis (default: 1000ms)

### Project Configuration

Create an `rld.config.json` in your project root:

```json
{
  "stableHooks": ["useQuery", "useSelector", "useAppSelector"],
  "unstableHooks": ["useLocalState"],
  "customFunctions": {
    "debounce": { "stable": true },
    "throttle": { "stable": true, "deferred": true }
  },
  "ignore": ["**/generated/**"]
}
```

## Commands

- **React Loop Detector: Analyze Workspace** - Manually trigger a full workspace analysis
- **React Loop Detector: Clear Cache** - Clear the analysis cache

## How It Works

The extension uses a two-tier analysis strategy:

1. **Fast single-file analysis** (~100ms debounce): Provides immediate feedback for obvious issues within a single file as you type
2. **Full cross-file analysis** (~1000ms debounce): Detects circular dependencies that span multiple files

This ensures you get instant feedback while still catching complex cross-file issues.

## Requirements

- VS Code 1.85.0 or higher
- Node.js 16.0.0 or higher

## Related

- [react-loop-detector](https://www.npmjs.com/package/react-loop-detector) - CLI tool
- [eslint-plugin-react-loop-detector](https://www.npmjs.com/package/eslint-plugin-react-loop-detector) - ESLint plugin

## License

MIT
