// @ts-nocheck - Type issues between ESLint and typescript-eslint
import { RuleTester } from 'eslint';
import noRenderPhaseSetState from '../src/rules/no-render-phase-setstate';
import noEffectLoop from '../src/rules/no-effect-loop';
import noUnstableDeps from '../src/rules/no-unstable-deps';
import noUnstableVariableDeps from '../src/rules/no-unstable-variable-deps';
import noMissingDepsArray from '../src/rules/no-missing-deps-array';
import noUnstableContextValue from '../src/rules/no-unstable-context-value';
import noUnstableJsxProps from '../src/rules/no-unstable-jsx-props';

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
      // useImperativeHandle with valid deps (3rd arg)
      `
        function Component(props, ref) {
          useImperativeHandle(ref, () => ({
            focus: () => {}
          }), [props.value]);
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
      // useImperativeHandle with inline object in deps (3rd arg)
      {
        code: `
          function Component(props, ref) {
            useImperativeHandle(ref, () => ({
              focus: () => {}
            }), [{ key: 'value' }]);
          }
        `,
        errors: [{ messageId: 'unstableObject' }],
      },
    ],
  });
});

describe('no-unstable-variable-deps', () => {
  ruleTester.run('no-unstable-variable-deps', noUnstableVariableDeps, {
    valid: [
      // Memoized object is stable
      `
        function Component() {
          const config = useMemo(() => ({ key: 'value' }), []);
          useEffect(() => {
            console.log(config);
          }, [config]);
        }
      `,
      // Memoized callback is stable
      `
        function Component() {
          const handler = useCallback(() => console.log('click'), []);
          useEffect(() => {
            document.addEventListener('click', handler);
          }, [handler]);
        }
      `,
      // State variables are stable
      `
        function Component() {
          const [count, setCount] = useState(0);
          useEffect(() => {
            console.log(count);
          }, [count]);
        }
      `,
      // Ref variables are stable
      `
        function Component() {
          const ref = useRef(null);
          useEffect(() => {
            console.log(ref.current);
          }, [ref]);
        }
      `,
      // Primitive values are stable
      `
        function Component() {
          const count = 5;
          useEffect(() => {
            console.log(count);
          }, [count]);
        }
      `,
      // Props are not tracked (external to component)
      `
        function Component({ config }) {
          useEffect(() => {
            console.log(config);
          }, [config]);
        }
      `,
      // useImperativeHandle with memoized value in deps (3rd arg)
      `
        function Component(props, ref) {
          const handler = useCallback(() => {}, []);
          useImperativeHandle(ref, () => ({
            doSomething: handler
          }), [handler]);
        }
      `,
    ],
    invalid: [
      // Object created in component
      {
        code: `
          function Component() {
            const config = { key: 'value' };
            useEffect(() => {
              console.log(config);
            }, [config]);
          }
        `,
        errors: [{ messageId: 'unstableObjectVariable' }],
      },
      // Array created in component
      {
        code: `
          function Component() {
            const items = [1, 2, 3];
            useEffect(() => {
              console.log(items);
            }, [items]);
          }
        `,
        errors: [{ messageId: 'unstableArrayVariable' }],
      },
      // Arrow function created in component
      {
        code: `
          function Component() {
            const handler = () => console.log('click');
            useEffect(() => {
              document.addEventListener('click', handler);
            }, [handler]);
          }
        `,
        errors: [{ messageId: 'unstableFunctionVariable' }],
      },
      // Function expression created in component
      {
        code: `
          function Component() {
            const handler = function() { console.log('click'); };
            useEffect(() => {
              document.addEventListener('click', handler);
            }, [handler]);
          }
        `,
        errors: [{ messageId: 'unstableFunctionVariable' }],
      },
      // Object in useCallback deps
      {
        code: `
          function Component() {
            const options = { method: 'GET' };
            const fetch = useCallback(() => {
              console.log(options);
            }, [options]);
          }
        `,
        errors: [{ messageId: 'unstableObjectVariable' }],
      },
      // Object in useMemo deps
      {
        code: `
          function Component() {
            const config = { key: 'value' };
            const result = useMemo(() => {
              return process(config);
            }, [config]);
          }
        `,
        errors: [{ messageId: 'unstableObjectVariable' }],
      },
      // Multiple unstable deps
      {
        code: `
          function Component() {
            const config = { key: 'value' };
            const items = [1, 2, 3];
            useEffect(() => {
              console.log(config, items);
            }, [config, items]);
          }
        `,
        errors: [{ messageId: 'unstableObjectVariable' }, { messageId: 'unstableArrayVariable' }],
      },
      // useImperativeHandle with unstable object in deps (3rd arg)
      {
        code: `
          function Component(props, ref) {
            const config = { key: 'value' };
            useImperativeHandle(ref, () => ({
              getConfig: () => config
            }), [config]);
          }
        `,
        errors: [{ messageId: 'unstableObjectVariable' }],
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

describe('no-unstable-context-value', () => {
  ruleTester.run('no-unstable-context-value', noUnstableContextValue, {
    valid: [
      // Memoized value is stable
      `
        function App() {
          const [user, setUser] = useState(null);
          const value = useMemo(() => ({ user, setUser }), [user]);
          return (
            <UserContext.Provider value={value}>
              <Child />
            </UserContext.Provider>
          );
        }
      `,
      // Primitive value is stable
      `
        function App() {
          const [count, setCount] = useState(0);
          return (
            <CountContext.Provider value={count}>
              <Child />
            </CountContext.Provider>
          );
        }
      `,
      // State value is stable
      `
        function App() {
          const [user, setUser] = useState(null);
          return (
            <UserContext.Provider value={user}>
              <Child />
            </UserContext.Provider>
          );
        }
      `,
      // Non-Provider JSX is not checked
      `
        function App() {
          return <Component value={{ foo: 'bar' }} />;
        }
      `,
    ],
    invalid: [
      // Inline object literal
      {
        code: `
          function App() {
            const [user, setUser] = useState(null);
            return (
              <UserContext.Provider value={{ user, setUser }}>
                <Child />
              </UserContext.Provider>
            );
          }
        `,
        errors: [{ messageId: 'unstableObjectValue' }],
      },
      // Inline array literal
      {
        code: `
          function App() {
            const [items] = useState([]);
            return (
              <ItemsContext.Provider value={[items, 'extra']}>
                <Child />
              </ItemsContext.Provider>
            );
          }
        `,
        errors: [{ messageId: 'unstableArrayValue' }],
      },
      // Inline function
      {
        code: `
          function App() {
            return (
              <CallbackContext.Provider value={() => console.log('click')}>
                <Child />
              </CallbackContext.Provider>
            );
          }
        `,
        errors: [{ messageId: 'unstableFunctionValue' }],
      },
      // Unstable variable
      {
        code: `
          function App() {
            const [user, setUser] = useState(null);
            const contextValue = { user, setUser };
            return (
              <UserContext.Provider value={contextValue}>
                <Child />
              </UserContext.Provider>
            );
          }
        `,
        errors: [{ messageId: 'unstableVariableValue' }],
      },
    ],
  });
});

describe('no-unstable-jsx-props', () => {
  ruleTester.run('no-unstable-jsx-props', noUnstableJsxProps, {
    valid: [
      // Memoized object is stable
      `
        function Parent() {
          const config = useMemo(() => ({ page: 1 }), []);
          return <Child config={config} />;
        }
      `,
      // Memoized callback is stable
      `
        function Parent() {
          const onClick = useCallback(() => console.log('clicked'), []);
          return <Child onClick={onClick} />;
        }
      `,
      // State values are stable
      `
        function Parent() {
          const [count, setCount] = useState(0);
          return <Child count={count} setCount={setCount} />;
        }
      `,
      // Primitive values are stable
      `
        function Parent() {
          return <Child name="test" count={5} />;
        }
      `,
      // Lowercase elements (DOM) are not checked by default
      `
        function Parent() {
          return <div style={{ color: 'red' }} />;
        }
      `,
      // Ignored props (key, ref, children)
      `
        function Parent() {
          return <Child key={{ id: 1 }} />;
        }
      `,
      // Callback props are not checked by default
      `
        function Parent() {
          return <Child onClick={() => console.log('clicked')} />;
        }
      `,
    ],
    invalid: [
      // Inline object literal
      {
        code: `
          function Parent() {
            return <Child config={{ page: 1 }} />;
          }
        `,
        errors: [{ messageId: 'unstableObjectProp' }],
      },
      // Inline array literal
      {
        code: `
          function Parent() {
            return <Child items={[1, 2, 3]} />;
          }
        `,
        errors: [{ messageId: 'unstableArrayProp' }],
      },
      // Unstable object variable
      {
        code: `
          function Parent() {
            const config = { page: 1 };
            return <Child config={config} />;
          }
        `,
        errors: [{ messageId: 'unstableVariableProp' }],
      },
      // Unstable array variable
      {
        code: `
          function Parent() {
            const items = [1, 2, 3];
            return <Child items={items} />;
          }
        `,
        errors: [{ messageId: 'unstableVariableProp' }],
      },
      // Unstable function variable (non-callback prop)
      {
        code: `
          function Parent() {
            const handler = () => console.log('clicked');
            return <Child handler={handler} />;
          }
        `,
        errors: [{ messageId: 'unstableVariableProp' }],
      },
      // Multiple unstable props
      {
        code: `
          function Parent() {
            const config = { page: 1 };
            const items = [1, 2, 3];
            return <Child config={config} items={items} />;
          }
        `,
        errors: [{ messageId: 'unstableVariableProp' }, { messageId: 'unstableVariableProp' }],
      },
    ],
  });
});

describe('no-unstable-jsx-props with checkCallbacks option', () => {
  ruleTester.run('no-unstable-jsx-props', noUnstableJsxProps, {
    valid: [],
    invalid: [
      // With checkCallbacks enabled, inline callbacks are flagged
      {
        code: `
          function Parent() {
            return <Child onClick={() => console.log('clicked')} />;
          }
        `,
        options: [{ checkCallbacks: true }],
        errors: [{ messageId: 'unstableFunctionProp' }],
      },
    ],
  });
});
