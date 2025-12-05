# React Loop Detector

A static analysis tool to detect circular dependencies and infinite re-render risks in React applications. Analyzes both import cycles between files and React hooks dependency arrays to identify potential infinite loops that can crash your app or cause performance issues.

## Features

- **Import Cycle Detection**: Finds circular imports between files
- **React Hooks Analysis**: Detects infinite re-render risks in `useEffect`, `useCallback`, `useMemo`, `useLayoutEffect`, and `useImperativeHandle`
- **Cross-File Cycle Detection**: Identifies import cycles spanning multiple files, including context and function-call based cycles
- **Error Codes**: Stable error codes (RLD-XXX) for filtering and ignoring specific issue types
- **Issue Categories**: Separate critical (crashes), warning (logic bugs), and performance issues
- **Code Frames**: Shows actual code snippets in output for easy debugging
- **Multiple Output Formats**: JSON, SARIF (for GitHub Code Scanning), and compact mode
- **Configurable**: Supports config files for custom hooks and ignore patterns
- **Caching**: Optional AST caching to speed up repeated runs
- **Zero Config**: Works out of the box with sensible defaults

## Installation

### Global Installation

```bash
npm install -g react-loop-detector
```

### Local Installation

```bash
npm install --save-dev react-loop-detector
```

## Usage

### Command Line

After installation, use either `react-loop-detector` or the shorter `rld` alias:

```bash
# Analyze an entire project
rld ./src

# Custom file pattern
rld ./src --pattern "**/*.tsx"

# Ignore additional patterns
rld ./src --ignore "**/tests/**" "**/*.test.tsx"

# Output as JSON
rld ./src --json

# Filter by severity (only show high severity issues)
rld ./src --min-severity high

# Filter by confidence
rld ./src --min-confidence medium

# Only show confirmed infinite loops (skip potential issues)
rld ./src --confirmed-only

# Enable caching for faster repeated runs
rld ./src --cache

# Disable colored output
rld ./src --no-color

# Compact output (one line per issue, Unix-style)
rld ./src --compact

# SARIF output for GitHub Code Scanning
rld ./src --sarif > results.sarif

# Generate default config file
rld init
```

### NPM Scripts

If installed locally, add to your `package.json`:

```json
{
  "scripts": {
    "check-loops": "rld ./src"
  }
}
```

### Programmatic API

```typescript
import { detectCircularDependencies } from 'react-loop-detector';

const results = await detectCircularDependencies('./src', {
  pattern: '**/*.{tsx,ts}',
  ignore: ['**/node_modules/**'],
  cache: true,
  config: {
    minSeverity: 'medium',
    minConfidence: 'high',
    includePotentialIssues: true,
  },
});

// Access results
console.log(results.circularDependencies);      // Import-level cycles
console.log(results.crossFileCycles);           // File-level import cycles
console.log(results.intelligentHooksAnalysis);  // Hooks issues
console.log(results.summary);                   // Statistics
```

## What It Detects

### Import Circular Dependencies

Detects circular imports between files that can cause module loading issues:

```typescript
// file1.ts
import { utilityB } from './file2';
export const utilityA = () => utilityB();

// file2.ts
import { utilityA } from './file1'; // Circular import!
export const utilityB = () => utilityA();
```

### React Hooks Infinite Loops

Identifies when hooks depend on state they also modify:

```typescript
// CONFIRMED INFINITE LOOP
const [isLoading, setIsLoading] = useState(false);

const fetchData = useCallback(async () => {
  setIsLoading(true);     // Modifies isLoading
  await api.call();
  setIsLoading(false);
}, [isLoading]);          // Depends on isLoading → infinite loop!

// FIX: Remove the dependency
const fetchData = useCallback(async () => {
  setIsLoading(true);
  await api.call();
  setIsLoading(false);
}, []);                   // No dependencies = stable function
```

### Potential Issues (Conditional Modifications)

```typescript
// POTENTIAL ISSUE - depends on guard condition
const [data, setData] = useState(null);

useEffect(() => {
  if (!data) {           // Guard condition
    setData(fetchData());
  }
}, [data]);              // May or may not cause issues
```

### Function Recreation Chains

```typescript
// Functions that depend on each other
const functionA = useCallback(() => {
  functionB();
}, [functionB]);

const functionB = useCallback(() => {
  functionA();
}, [functionA]);         // Circular dependency!

// FIX: Break the chain
const functionA = useCallback(() => {
  // Direct implementation
}, []);

const functionB = useCallback(() => {
  functionA();           // functionA is now stable
}, []);
```

## Configuration

Create a config file in your project root. Supported formats:

- `rld.config.js` / `rld.config.mjs`
- `rld.config.json`
- `.rldrc` / `.rldrc.json`

### Example Configuration

```json
{
  "stableHooks": ["useQuery", "useSelector", "useTranslation"],
  "unstableHooks": ["useUnstableThirdPartyThing"],
  "customFunctions": {
    "useApi": { "stable": true },
    "makeRequest": { "deferred": true }
  },
  "ignore": ["src/generated/**", "**/*.test.tsx"],
  "minSeverity": "medium",
  "minConfidence": "high",
  "includePotentialIssues": true
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `stableHooks` | `string[]` | `[]` | Hooks that return stable references |
| `unstableHooks` | `string[]` | `[]` | Hooks that return unstable references |
| `customFunctions` | `object` | `{}` | Custom function stability info |
| `ignore` | `string[]` | `[]` | Additional patterns to ignore |
| `minSeverity` | `"high" \| "medium" \| "low"` | `"low"` | Minimum severity to report |
| `minConfidence` | `"high" \| "medium" \| "low"` | `"low"` | Minimum confidence to report |
| `includePotentialIssues` | `boolean` | `true` | Include potential issues |

## CLI Options

| Option | Description |
|--------|-------------|
| `-p, --pattern <pattern>` | Glob pattern for files (default: `**/*.{js,jsx,ts,tsx}`) |
| `-i, --ignore <patterns...>` | Patterns to ignore |
| `--json` | Output as JSON |
| `--sarif` | Output in SARIF format (for GitHub Code Scanning) |
| `--compact` | Compact output (one line per issue) |
| `--debug` | Show internal decision logic for debugging false positives |
| `--parallel` | Use parallel parsing with worker threads (faster for large projects) |
| `--workers <count>` | Number of worker threads (default: CPU cores - 1) |
| `--no-color` | Disable colored output |
| `--min-severity <level>` | Minimum severity: `high`, `medium`, `low` |
| `--min-confidence <level>` | Minimum confidence: `high`, `medium`, `low` |
| `--confirmed-only` | Only report confirmed infinite loops |
| `--cache` | Enable AST caching for faster runs |

### Commands

| Command | Description |
|---------|-------------|
| `rld <path>` | Analyze the given path for issues |
| `rld watch <path>` | Watch for file changes and re-analyze automatically |
| `rld init` | Generate a default `rld.config.json` file |

## Error Codes

Issues are identified by stable error codes that you can use for filtering:

| Code | Category | Description |
|------|----------|-------------|
| `RLD-100` | Critical | setState called during render (synchronous loop) |
| `RLD-200` | Critical | useEffect unconditional setState loop |
| `RLD-201` | Critical | useEffect missing deps with setState |
| `RLD-202` | Critical | useLayoutEffect unconditional setState loop |
| `RLD-300` | Warning | Cross-file loop risk |
| `RLD-400` | Performance | Unstable object reference in deps |
| `RLD-401` | Performance | Unstable array reference in deps |
| `RLD-402` | Performance | Unstable function reference in deps |
| `RLD-410` | Warning | Object spread guard risk |
| `RLD-420` | Warning | useCallback/useMemo modifies dependency |
| `RLD-501` | Warning | Conditional modification needs review |
| `RLD-600` | Warning | Ref mutation with state value (stale closure risk) |

You can ignore specific error codes using comments:

```typescript
// rld-ignore RLD-400
useEffect(() => { ... }, [{ id: 1 }]);
```

## Output Example

### Default (Verbose) Output

```
Analyzing React hooks in: /path/to/project
Pattern: **/*.{js,jsx,ts,tsx}

✓ No import circular dependencies found
✓ No cross-file import cycles found

🚨 Found 1 CONFIRMED infinite loop(s):

1. 🚨 [RLD-200] CRITICAL - Infinite re-render
   Severity: high | Confidence: high

    📍 Location:
       src/components/UserProfile.tsx:45
       useEffect

    📝 Code:
         43 |
         44 |   // This will cause an infinite loop
       > 45 |   useEffect(() => {
         46 |     setUserData({ ...userData, updated: true });
         47 |   }, [userData]);

    ❌ Problem:
       useEffect modifies 'userData' via 'setUserData()' while depending on it, creating guaranteed infinite loop.

Summary:
Files analyzed: 42
Hooks analyzed: 156
Critical issues: 1
  Import cycles: 0
  Confirmed infinite loops: 1
```

### Compact Output (`--compact`)

```
src/components/UserProfile.tsx:45:0 - error RLD-200: useEffect modifies 'userData' via 'setUserData()' while depending on it
src/utils/helpers.tsx:23:0 - warning RLD-400: Unstable object reference in deps
src/hooks/useData.tsx:12:0 - info RLD-400: Unstable array reference in deps

3 issue(s) found
```

## Default Ignored Patterns

The following patterns are ignored by default:

- `**/node_modules/**`
- `**/.git/**`
- `**/dist/**`
- `**/build/**`
- `**/.expo/**`
- `**/.next/**`
- `**/.nuxt/**`
- `**/.cache/**`

## Exit Codes

- `0`: No critical issues found
- `1`: Critical issues detected (import cycles or confirmed infinite loops)

## CI/CD Integration

### Basic Integration

```bash
# In your CI script
rld ./src --json > loop-report.json

# Exit with error on critical issues
if [ $? -eq 1 ]; then
  echo "Critical issues detected!"
  exit 1
fi
```

Or use the `--confirmed-only` flag to only fail on guaranteed infinite loops:

```bash
rld ./src --confirmed-only
```

### GitHub Code Scanning

Use SARIF output to display results inline in Pull Requests:

```yaml
# .github/workflows/code-scanning.yml
name: Code Scanning
on: [push, pull_request]

jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - run: npm ci
      - run: npx rld ./src --sarif > results.sarif

      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
```

## Development

```bash
# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Build the project
npm run build

# Build in watch mode
npm run dev
```

## License

MIT
