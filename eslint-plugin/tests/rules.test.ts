// @ts-nocheck - Type issues between ESLint and typescript-eslint
import { RuleTester } from 'eslint';
import noRenderPhaseSetState from '../src/rules/no-render-phase-setstate';
import noEffectLoop from '../src/rules/no-effect-loop';
import noUnstableDeps from '../src/rules/no-unstable-deps';
import noMissingDepsArray from '../src/rules/no-missing-deps-array';

// Configure rule tester with parser for TypeScript/JSX
const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    parserOptions: {
      ecmaFeatures: {
        jsx: true,
      },
    },
  },
});

describe('no-render-phase-setstate', () => {
  ruleTester.run('no-render-phase-setstate', noRenderPhaseSetState, {
    valid: [
      // setState in useEffect is safe
      `
        function Component() {
          const [count, setCount] = useState(0);
          useEffect(() => {
            setCount(1);
          }, []);
          return <div>{count}</div>;
        }
      `,
      // setState in event handler is safe
      `
        function Component() {
          const [count, setCount] = useState(0);
          const handleClick = () => {
            setCount(count + 1);
          };
          return <button onClick={handleClick}>{count}</button>;
        }
      `,
      // setState in callback is safe
      `
        function Component() {
          const [count, setCount] = useState(0);
          const increment = useCallback(() => {
            setCount(c => c + 1);
          }, []);
          return <button onClick={increment}>{count}</button>;
        }
      `,
    ],
    invalid: [
      // setState during render
      {
        code: `
          function Component() {
            const [count, setCount] = useState(0);
            setCount(count + 1);
            return <div>{count}</div>;
          }
        `,
        errors: [{ messageId: 'renderPhaseSetState' }],
      },
      // Arrow function component with setState during render
      {
        code: `
          const Component = () => {
            const [count, setCount] = useState(0);
            setCount(1);
            return <div>{count}</div>;
          };
        `,
        errors: [{ messageId: 'renderPhaseSetState' }],
      },
    ],
  });
});

describe('no-effect-loop', () => {
  ruleTester.run('no-effect-loop', noEffectLoop, {
    valid: [
      // Functional update is safe
      `
        function Component() {
          const [count, setCount] = useState(0);
          useEffect(() => {
            setCount(c => c + 1);
          }, [count]);
        }
      `,
      // Guarded update is safe
      `
        function Component() {
          const [count, setCount] = useState(0);
          useEffect(() => {
            if (count < 10) {
              setCount(count + 1);
            }
          }, [count]);
        }
      `,
      // Not modifying a dependency
      `
        function Component() {
          const [count, setCount] = useState(0);
          const [other, setOther] = useState(0);
          useEffect(() => {
            setOther(other + 1);
          }, [count]);
        }
      `,
    ],
    invalid: [
      // Direct setState on dependency
      {
        code: `
          function Component() {
            const [count, setCount] = useState(0);
            useEffect(() => {
              setCount(count + 1);
            }, [count]);
          }
        `,
        errors: [{ messageId: 'effectLoop' }],
      },
      // useLayoutEffect with loop
      {
        code: `
          function Component() {
            const [count, setCount] = useState(0);
            useLayoutEffect(() => {
              setCount(count + 1);
            }, [count]);
          }
        `,
        errors: [{ messageId: 'effectLoopLayout' }],
      },
    ],
  });
});

describe('no-unstable-deps', () => {
  ruleTester.run('no-unstable-deps', noUnstableDeps, {
    valid: [
      // Identifier in deps is fine
      `
        function Component() {
          const config = useMemo(() => ({ key: 'value' }), []);
          useEffect(() => {
            console.log(config);
          }, [config]);
        }
      `,
      // Stable function call in deps is fine
      `
        function Component() {
          useEffect(() => {
            console.log('effect');
          }, [Math.round(1.5)]);
        }
      `,
    ],
    invalid: [
      // Inline object literal
      {
        code: `
          function Component() {
            useEffect(() => {
              console.log('effect');
            }, [{ key: 'value' }]);
          }
        `,
        errors: [{ messageId: 'unstableObject' }],
      },
      // Inline array literal
      {
        code: `
          function Component() {
            useEffect(() => {
              console.log('effect');
            }, [[1, 2, 3]]);
          }
        `,
        errors: [{ messageId: 'unstableArray' }],
      },
      // Inline function
      {
        code: `
          function Component() {
            useEffect(() => {
              console.log('effect');
            }, [() => {}]);
          }
        `,
        errors: [{ messageId: 'unstableFunction' }],
      },
    ],
  });
});

describe('no-missing-deps-array', () => {
  ruleTester.run('no-missing-deps-array', noMissingDepsArray, {
    valid: [
      // Has dependency array
      `
        function Component() {
          const [count, setCount] = useState(0);
          useEffect(() => {
            setCount(1);
          }, []);
        }
      `,
      // No setState, so allowed by default
      `
        function Component() {
          useEffect(() => {
            console.log('effect');
          });
        }
      `,
    ],
    invalid: [
      // Missing deps with setState
      {
        code: `
          function Component() {
            const [count, setCount] = useState(0);
            useEffect(() => {
              setCount(count + 1);
            });
          }
        `,
        errors: [{ messageId: 'missingDepsArrayWithSetState' }],
      },
    ],
  });
});
