# eslint-plugin-react-loop-detector

ESLint plugin to detect infinite re-render risks in React hooks.

## Installation

```bash
npm install eslint-plugin-react-loop-detector --save-dev
```

## Usage

### Flat Config (ESLint 9+)

```javascript
// eslint.config.js
import reactLoopDetector from 'eslint-plugin-react-loop-detector';

export default [
  // Use the recommended config
  reactLoopDetector.configs.recommended,

  // Or configure manually
  {
    plugins: {
      'react-loop-detector': reactLoopDetector,
    },
    rules: {
      'react-loop-detector/no-render-phase-setstate': 'error',
      'react-loop-detector/no-effect-loop': 'error',
      'react-loop-detector/no-unstable-deps': 'warn',
      'react-loop-detector/no-missing-deps-array': 'error',
    },
  },
];
```

### Legacy Config (ESLint 8)

```json
{
  "plugins": ["react-loop-detector"],
  "rules": {
    "react-loop-detector/no-render-phase-setstate": "error",
    "react-loop-detector/no-effect-loop": "error",
    "react-loop-detector/no-unstable-deps": "warn",
    "react-loop-detector/no-missing-deps-array": "error"
  }
}
```

## Rules

### `no-render-phase-setstate`

Disallows calling setState during render, which causes infinite loops.

```jsx
// Bad - setState during render
function Component() {
  const [count, setCount] = useState(0);
  setCount(count + 1); // Error: setState during render
  return <div>{count}</div>;
}

// Good - setState in effect
function Component() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    setCount(1);
  }, []);
  return <div>{count}</div>;
}

// Good - setState in event handler
function Component() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(c => c + 1)}>{count}</button>;
}
```

### `no-effect-loop`

Detects useEffect patterns that cause infinite loops by modifying state that the effect depends on.

```jsx
// Bad - modifies dependency
function Component() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    setCount(count + 1); // Error: modifies count while depending on it
  }, [count]);
}

// Good - functional update
function Component() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    setCount(c => c + 1); // OK: functional update doesn't read count
  }, []);
}

// Good - guarded update
function Component() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (count < 10) {
      setCount(count + 1); // OK: guarded by condition
    }
  }, [count]);
}
```

#### Options

- `allowFunctionalUpdates` (default: `true`): Allow functional updates like `setCount(c => c + 1)`
- `detectGuards` (default: `true`): Consider guarded updates (inside `if` statements) as safe

### `no-unstable-deps`

Warns about unstable references in dependency arrays that will trigger effects on every render.

```jsx
// Bad - inline object
function Component() {
  useEffect(() => {
    // ...
  }, [{ key: 'value' }]); // Warning: creates new reference every render
}

// Bad - inline array
function Component() {
  useEffect(() => {
    // ...
  }, [[1, 2, 3]]); // Warning: creates new reference every render
}

// Bad - inline function
function Component() {
  useEffect(() => {
    // ...
  }, [() => {}]); // Warning: creates new reference every render
}

// Good - memoized value
function Component() {
  const config = useMemo(() => ({ key: 'value' }), []);
  useEffect(() => {
    // ...
  }, [config]); // OK: stable reference
}
```

### `no-missing-deps-array`

Requires a dependency array in useEffect when setState is called. Without a dependency array, the effect runs on every render, causing an infinite loop.

```jsx
// Bad - no deps array with setState
function Component() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    setCount(count + 1); // Error: guaranteed infinite loop
  });
}

// Good - with deps array
function Component() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    setCount(1);
  }, []); // OK: runs only once
}
```

#### Options

- `onlyWithSetState` (default: `true`): Only report when setState is called in the effect

## Configs

### `recommended`

Enables all rules with sensible defaults:
- `no-render-phase-setstate`: error
- `no-effect-loop`: error
- `no-unstable-deps`: warn
- `no-missing-deps-array`: error

### `strict`

Same as recommended but with `no-unstable-deps` as error.

## Relationship to react-circular-deps-detector

This ESLint plugin provides single-file static analysis that can be run during development. For cross-file circular dependency detection and runtime analysis, use the main `react-circular-deps-detector` package.

## License

MIT
