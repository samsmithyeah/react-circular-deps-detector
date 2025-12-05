# React Loop Detector

A static analysis tool to detect circular dependencies and infinite re-render risks in React applications. Analyzes both import cycles between files and React hooks dependency arrays to identify potential infinite loops that can crash your app or cause performance issues.

## Features

- **Import Cycle Detection**: Finds circular imports between files
- **React Hooks Analysis**: Detects infinite re-render risks in `useEffect`, `useCallback`, `useMemo`, `useLayoutEffect`, and `useImperativeHandle`
- **Cross-File Cycle Detection**: Identifies import cycles spanning multiple files, including context and function-call based cycles
- **Severity Classification**: Issues are marked as HIGH (guaranteed infinite loops) or MEDIUM (potential issues)
- **Confidence Levels**: Issues rated high, medium, or low confidence
- **Configurable**: Supports config files for custom hooks and ignore patterns
- **Caching**: Optional AST caching to speed up repeated runs
- **JSON Output**: Machine-readable format for CI/CD integration
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
| `--no-color` | Disable colored output |
| `--min-severity <level>` | Minimum severity: `high`, `medium`, `low` |
| `--min-confidence <level>` | Minimum confidence: `high`, `medium`, `low` |
| `--confirmed-only` | Only report confirmed infinite loops |
| `--cache` | Enable AST caching for faster runs |

## Output Example

```
Analyzing React hooks in: /path/to/project
Pattern: **/*.{js,jsx,ts,tsx}

✓ No import circular dependencies found
✓ No cross-file import cycles found

🚨 Found 1 CONFIRMED infinite loop(s):

1. 🚨  GUARANTEED infinite re-render (high severity)
   Confidence: high

    📍 Location:
       src/components/UserProfile.tsx:45
       useCallback in updateUser()

    ❌ Problem:
       This hook depends on 'userData' and modifies it, creating an infinite loop:
       userData changes → hook runs → calls setUserData() → userData changes → repeats forever

Summary:
Files analyzed: 42
Hooks analyzed: 156
Critical issues: 1
  Import cycles: 0
  Confirmed infinite loops: 1
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
