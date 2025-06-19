# React Circular Dependencies Detector

A comprehensive CLI tool to detect circular dependencies and infinite re-render risks in React applications. This tool analyzes both import cycles between files and React hooks dependency arrays to identify potential infinite re-render loops that can crash your app or cause performance issues.

## ✨ Features

- 🔍 **Import Cycle Detection**: Finds circular imports between files
- 🎣 **React Hooks Analysis**: Detects infinite re-render risks in useEffect, useCallback, useMemo
- 🚨 **Severity Levels**: High severity for guaranteed infinite loops, medium for potential issues  
- 💡 **Actionable Solutions**: Clear fix suggestions for every issue found
- 📍 **Precise Location**: Exact file and line number for each problem
- 🎨 **Beautiful Output**: Clean, readable formatting with color coding
- 📊 **JSON Output**: Machine-readable format for CI/CD integration
- ⚡ **Fast Analysis**: Efficiently processes large codebases
- 🎯 **Zero Config**: Works out of the box with sensible defaults

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

### 🔄 Import Circular Dependencies
Detects circular imports between files that can cause module loading issues:
```typescript
// file1.ts
import { utilityB } from './file2';
export const utilityA = () => utilityB();

// file2.ts  
import { utilityA } from './file1'; // 🔴 Circular import
export const utilityB = () => utilityA();
```

### 🎣 React Hooks Dependency Issues
Identifies infinite re-render risks in React hooks:

```typescript
// 🚨 HIGH SEVERITY: State setter dependency
const [isLoading, setIsLoading] = useState(false);

const problematicFunction = useCallback(async () => {
  setIsLoading(true);
  await fetchData();
  setIsLoading(false);
}, [isLoading]); // 🔴 Depends on isLoading but modifies it - infinite loop!

// ✅ FIXED: Remove the dependency or use functional update
const fixedFunction = useCallback(async () => {
  setIsLoading(true);
  await fetchData();
  setIsLoading(false);
}, []); // No dependencies needed

// ⚠️ MEDIUM SEVERITY: Potential unnecessary dependency
const [data, setData] = useState(null);

useEffect(() => {
  if (data) {
    console.log('Data updated:', data); // Only reads data, doesn't modify
  }
}, [data]); // ⚠️ Conservative warning - this is usually fine
```

## Common Issues Fixed

### 🔥 Infinite Re-render Loops
The most dangerous pattern that causes apps to freeze:
```typescript
// 🔴 BROKEN: Infinite loop
const [count, setCount] = useState(0);
const increment = useCallback(() => {
  setCount(count + 1);
}, [count]); // count changes → increment recreated → count changes → ...

// ✅ FIXED: Stable dependency
const increment = useCallback(() => {
  setCount(prev => prev + 1);
}, []); // No dependencies = stable function
```

### 🔄 Function Recreation Chains  
Functions that depend on each other causing unnecessary re-renders:
```typescript
// 🔴 BROKEN: Functions recreate each other
const functionA = useCallback(() => {
  functionB();
}, [functionB]);

const functionB = useCallback(() => {
  functionA();
}, [functionA]); // Circular dependency

// ✅ FIXED: Break the chain
const functionA = useCallback(() => {
  // Direct implementation
}, []);

const functionB = useCallback(() => {
  functionA(); // functionA is now stable
}, []);
```

## Real-world Example

This tool was created to solve a real issue where enabling React's `exhaustive-deps` ESLint rule caused infinite loops:

```typescript
// Before: This worked but had missing dependencies
const updateLocationMode = useCallback(async () => {
  setIsLoading(true);
  await api.updateLocation();
  setIsLoading(false);
}, []); // ❌ ESLint: missing dependency 'isLoading'

// After ESLint fix: Infinite loop! 
const updateLocationMode = useCallback(async () => {
  setIsLoading(true);   // Modifies isLoading
  await api.updateLocation();
  setIsLoading(false);
}, [isLoading]); // 🔴 Now depends on isLoading - INFINITE LOOP!

// Terminal output: 
// LOG [UpdateLocationTrackingMode] Shared locations: 0, Required mode: passive, Currently active: true
// LOG [UpdateLocationTrackingMode] Shared locations: 0, Required mode: passive, Currently active: true
// LOG [UpdateLocationTrackingMode] Shared locations: 0, Required mode: passive, Currently active: true
// (repeats forever...)
```

**Our tool detects this and suggests the fix:**
```
🚨 Infinite re-render risk (high severity)

📍 Location: SignalContext.tsx:45
🎣 Hook: useCallback (function: updateLocationMode)  
⚠️  Problem: Depends on 'isLoading' but may modify it
💡 Solution: Remove 'isLoading' from dependencies or use stable references
```

**The correct fix:**
```typescript
// ✅ FIXED: No dependency needed since we use functional updates
const updateLocationMode = useCallback(async () => {
  setIsLoading(true);   // Direct call, no dependency needed
  await api.updateLocation();
  setIsLoading(false);
}, []); // Empty deps - stable function
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

✓ No import circular dependencies found
✓ No cross-file import cycles found

❌ Found 2 React hooks dependency issues:

1. 🚨  Infinite re-render risk (high severity)

    📍 Location:
       src/components/UserProfile.tsx:45

    🎣 Hook:
       useCallback (function: updateUser)

    ⚠️  Problem:
       Depends on 'userData' but may modify it
       userData → setUserData

    💡 Solution:
       Remove 'userData' from dependencies or use stable references


2. ⚠️  Infinite re-render risk (medium severity)

    📍 Location:
       src/hooks/useDataSync.ts:78

    🎣 Hook:
       useEffect

    ⚠️  Problem:
       Depends on 'data' but may modify it
       data → setData

    💡 Solution:
       Review if 'data' dependency is necessary


Summary:
Files analyzed: 23
Hooks analyzed: 67
Issues found: 2
  Import cycles: 0
  Hooks issues: 2
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

## Development

### Running Tests

```bash
# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Run tests in watch mode
npm run test:watch
```

### Building

```bash
# Build the project
npm run build

# Build in watch mode
npm run dev
```

## License

MIT