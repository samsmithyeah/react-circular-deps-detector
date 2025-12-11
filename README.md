# React Loop Detector

A static analysis tool to detect circular dependencies and infinite re-render risks in React applications. Analyzes both import cycles between files and React hooks dependency arrays to identify potential infinite loops that can crash your app or cause performance issues.

## Features

- **Import Cycle Detection**: Finds circular imports between files
- **React Hooks Analysis**: Detects infinite re-render risks in `useEffect`, `useCallback`, `useMemo`, `useLayoutEffect`, and `useImperativeHandle`
- **Cross-File Cycle Detection**: Identifies import cycles spanning multiple files, including context and function-call based cycles
- **TypeScript Strict Mode**: Auto-enabled for TypeScript projects - uses the TypeScript compiler for accurate type-based stability detection
- **Library Presets**: Built-in presets for Zustand, React Query, React Redux, and more - automatically detects libraries from package.json
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

# TypeScript strict mode (auto-enabled when tsconfig.json found)
# Uses TypeScript compiler for more accurate type-based analysis
rld ./src --strict

# Disable strict mode (faster, uses heuristics only)
rld ./src --no-strict

# Disable colored output
rld ./src --no-color

# Compact output (one line per issue, Unix-style)
rld ./src --compact

# SARIF output for GitHub Code Scanning
rld ./src --sarif > results.sarif

# Generate default config file
rld init

# Analyze only files changed since a git ref (essential for CI in large repos)
rld ./src --since main

# Also analyze files that import the changed files
rld ./src --since main --include-dependents

# Compare against a specific commit
rld ./src --since HEAD~5
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

### CI/CD Integration

For large repositories, use `--since` to only analyze changed files. This dramatically speeds up CI checks:

```yaml
# GitHub Actions example
- name: Check for React loops
  run: npx react-loop-detector ./src --since origin/main --include-dependents
```

The `--since` option:
- Only analyzes files that have changed since the specified git ref
- Automatically includes uncommitted and untracked files
- Works with branch names (`main`), commits (`abc123`), or relative refs (`HEAD~5`)

The `--include-dependents` option:
- Also analyzes files that import the changed files
- Catches issues where changes in one file affect others
- Recommended for thorough CI checks

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

## React Compiler (React 19) Compatibility

React 19 introduces the React Compiler (formerly "React Forget"), which automatically memoizes components and hooks for better performance. You might wonder: "If the compiler auto-memoizes everything, do I still need this tool?"

**Yes.** The React Compiler and React Loop Detector solve different problems:

| Aspect | React Compiler | React Loop Detector |
|--------|----------------|---------------------|
| **Problem domain** | Performance optimization | Logic bug detection |
| **What it does** | Auto-memoizes values to prevent unnecessary re-renders | Detects infinite loops caused by circular state dependencies |
| **Example fix** | Caches `{ id: userId }` so the same object reference is reused | Warns that `useEffect(() => setX(x+1), [x])` loops forever |

### Why the Compiler Can't Fix Logic Bugs

The React Compiler optimizes *when* things re-render, not *what* they do. Consider:

```typescript
const [count, setCount] = useState(0);

// ❌ INFINITE LOOP - React Compiler cannot fix this
useEffect(() => {
  setCount(count + 1);  // Always runs, always updates count
}, [count]);            // count changes → effect runs → count changes → ...
```

The compiler might memoize the `count + 1` expression, but the fundamental problem remains: the effect modifies the state it depends on. This is a logic bug that causes an infinite loop regardless of memoization.

### What Each Tool Catches

**React Compiler prevents:**
- Unnecessary re-renders from new object/array references
- Performance issues from unmemoized callbacks
- Wasted renders when props haven't semantically changed

**React Loop Detector catches:**
- Effects that modify their own dependencies (guaranteed loops)
- Circular function dependencies in hooks
- Cross-file state cycles through props and callbacks
- Conditional modifications that may cause loops

### Using Both Together

For a robust React codebase, use both:

1. **React Compiler** (React 19+): Handles performance automatically
2. **React Loop Detector**: Catches logic bugs that cause infinite loops

The tools are complementary—the compiler makes your app fast, this tool keeps it from crashing.

## Configuration

Create a config file in your project root. Supported formats:

- `rld.config.js` (CommonJS)
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
| `stableHookPatterns` | `string[]` | `[]` | Regex patterns for stable hooks (e.g., `"^use\\w+Store$"` for Zustand) |
| `unstableHookPatterns` | `string[]` | `[]` | Regex patterns for unstable hooks |
| `customFunctions` | `object` | `{}` | Custom function stability info |
| `ignore` | `string[]` | `[]` | Additional patterns to ignore |
| `minSeverity` | `"high" \| "medium" \| "low"` | `"low"` | Minimum severity to report |
| `minConfidence` | `"high" \| "medium" \| "low"` | `"medium"` | Minimum confidence to report |
| `includePotentialIssues` | `boolean` | `true` | Include potential issues |
| `noPresets` | `boolean` | `false` | Disable auto-detection of library presets |
| `strictMode` | `boolean` | auto | Use TypeScript compiler for type-based analysis. Auto-enabled when `tsconfig.json` found |
| `tsconfigPath` | `string` | - | Custom path to tsconfig.json (only used when strictMode is enabled) |

### Library Presets (Auto-Detection)

React Loop Detector automatically detects popular React libraries from your `package.json` and applies their stable hook configurations. This means you get accurate analysis out of the box without manual configuration.

**Supported Libraries (24+):**

| Category | Libraries |
|----------|-----------|
| **Data Fetching** | TanStack Query, SWR, Apollo Client, RTK Query, tRPC |
| **State Management** | Redux, Zustand, Jotai, Recoil, Valtio, MobX, XState |
| **Forms** | React Hook Form, Formik |
| **Routing** | React Router, TanStack Router, Expo Router |
| **i18n** | react-i18next, react-intl |
| **Animation** | Framer Motion, React Spring |
| **UI Components** | Chakra UI, Material UI, Radix UI |
| **Utilities** | use-debounce, react-use, usehooks-ts |

**Example configurations applied:**

| Library | Example Stable Hooks |
|---------|---------------------|
| **TanStack Query** | `useQuery`, `useMutation`, `useQueryClient` |
| **Redux** | `useSelector`, `useDispatch`, `useStore` |
| **Zustand** | `useStore`, `useShallow`, plus pattern `/^use\w+Store$/` |
| **React Router** | `useNavigate`, `useParams`, `useLocation` |
| **React Hook Form** | `useForm`, `useController`, `useWatch` |

See the full list with all hooks in `src/presets.ts`.

**Disabling Presets:**

If you prefer to configure everything manually:

```json
{
  "noPresets": true,
  "stableHooks": ["useQuery", "useSelector"]
}
```

Or via CLI:

```bash
rld ./src --no-presets
```

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
| `--min-confidence <level>` | Minimum confidence: `high`, `medium`, `low` (default: `medium`) |
| `--confirmed-only` | Only report confirmed infinite loops |
| `--cache` | Enable AST caching for faster runs. Disables parallel processing. |
| `--no-presets` | Disable auto-detection of library presets from package.json |
| `--strict` | Enable TypeScript strict mode (auto-enabled when tsconfig.json found) |
| `--no-strict` | Disable strict mode (use heuristics only) |
| `--tsconfig <path>` | Path to tsconfig.json (for strict mode) |
| `--since <ref>` | Only analyze files changed since git ref (e.g., `main`, `HEAD~5`) |
| `--include-dependents` | When using `--since`, also analyze files that import changed files |

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
| `RLD-101` | Critical | setState via function call during render |
| `RLD-200` | Critical | useEffect unconditional setState loop |
| `RLD-201` | Critical | useEffect missing deps with setState |
| `RLD-202` | Critical | useLayoutEffect unconditional setState loop |
| `RLD-300` | Warning | Cross-file loop risk |
| `RLD-301` | Warning | Cross-file conditional modification |
| `RLD-400` | Performance | Unstable object reference in deps |
| `RLD-401` | Performance | Unstable array reference in deps |
| `RLD-402` | Performance | Unstable function reference in deps |
| `RLD-403` | Performance | Unstable function call result in deps |
| `RLD-404` | Performance | Unstable Context.Provider value |
| `RLD-405` | Performance | Unstable prop to memoized component |
| `RLD-406` | Performance | Unstable callback in useCallback deps |
| `RLD-407` | Critical | useSyncExternalStore unstable getSnapshot (synchronous infinite loop) |
| `RLD-410` | Warning | Object spread guard risk |
| `RLD-420` | Warning | useCallback/useMemo modifies dependency |
| `RLD-500` | Warning | Missing dependency array |
| `RLD-501` | Warning | Conditional modification needs review |
| `RLD-600` | Warning | Ref mutation with state value during render phase (effect-phase is safe) |

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

Additionally, files larger than **1MB** are automatically skipped to avoid analyzing bundled or generated files.

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
