# React Circular Dependencies Detector

A CLI tool to detect circular dependencies in React hooks' dependency arrays. This tool helps identify potential infinite re-render loops caused by circular references in `useEffect`, `useCallback`, `useMemo`, and other React hooks.

## Installation

### Global Installation (Recommended)

```bash
npm install -g react-circular-deps-detector
```

### Local Installation

```bash
npm install --save-dev react-circular-deps-detector
```

## Usage

### Command Line

After global installation, you can use either `react-circular-deps` or the shorter `rcd` command:

```bash
# Analyze a single file
react-circular-deps src/components/MyComponent.tsx

# Analyze an entire project
react-circular-deps ./src

# Using the short alias
rcd ./src

# With custom file pattern
rcd ./src --pattern "**/*.{ts,tsx}"

# Exclude specific patterns (node_modules is excluded by default)
rcd ./src --ignore "**/tests/**" "**/*.test.tsx"

# Output as JSON
rcd ./src --json

# Disable colored output
rcd ./src --no-color
```

### NPM Scripts

If installed locally, add to your `package.json`:

```json
{
  "scripts": {
    "check-circular-deps": "react-circular-deps ./src"
  }
}
```

## What It Detects

The tool analyzes React hooks and identifies circular dependencies like:

```javascript
// Example 1: Circular dependency between callbacks
const [data, setData] = useState(null);

const fetchData = useCallback(() => {
  processData();
}, [data, processData]); // 🔴 Circular: fetchData → processData → fetchData

const processData = useCallback(() => {
  setData(fetchData());
}, [fetchData]);

// Example 2: Self-referential dependency
const memoizedValue = useMemo(() => {
  return computeValue(memoizedValue); // 🔴 Self-reference
}, [memoizedValue]);

// Example 3: Multiple hook circular dependency
useEffect(() => {
  handleChange();
}, [value, handleChange]); // 🔴 If handleChange depends on value
```

## Options

- `--pattern, -p <pattern>`: Glob pattern for files to analyze (default: `**/*.{js,jsx,ts,tsx}`)
- `--ignore, -i <patterns...>`: Patterns to ignore (default: `node_modules`, `.git`, `dist`, `build`, etc.)
- `--json`: Output results as JSON for CI/CD integration
- `--no-color`: Disable colored output
- `--help`: Display help information
- `--version`: Display version

## Exit Codes

- `0`: No circular dependencies found
- `1`: Circular dependencies detected or error occurred

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

## Output Example

```
Analyzing React hooks in: /path/to/project
Pattern: **/*.{js,jsx,ts,tsx}

✗ Found 2 circular dependencies:

1. src/components/UserProfile.tsx:45
   Hook: useCallback
   Cycle: updateUser → userData → fetchUser

2. src/hooks/useDataSync.ts:78
   Hook: useEffect
   Cycle: syncData → localData → syncData

Summary:
  Files analyzed: 23
  Hooks analyzed: 67
  Circular dependencies: 2
```

## Integration with CI/CD

Use the JSON output for easy integration with CI/CD pipelines:

```bash
# In your CI script
rcd ./src --json > circular-deps-report.json

# The tool exits with code 1 if circular dependencies are found
if [ $? -eq 1 ]; then
  echo "Circular dependencies detected!"
  exit 1
fi
```

## License

MIT