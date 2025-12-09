import React, { useReducer, useEffect, useCallback } from 'react';

// Test cases for useReducer dispatch loop detection
// The dispatch function doesn't follow the setX naming pattern like useState setters

interface State {
  count: number;
  data: string | null;
  loading: boolean;
}

type Action =
  | { type: 'increment' }
  | { type: 'decrement' }
  | { type: 'setData'; payload: string }
  | { type: 'setLoading'; payload: boolean }
  | { type: 'reset' };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'increment':
      return { ...state, count: state.count + 1 };
    case 'decrement':
      return { ...state, count: state.count - 1 };
    case 'setData':
      return { ...state, data: action.payload };
    case 'setLoading':
      return { ...state, loading: action.payload };
    case 'reset':
      return { count: 0, data: null, loading: false };
    default:
      return state;
  }
}

// Pattern 1: CONFIRMED infinite loop - dispatch modifies entire state object
export const UseReducerInfiniteLoop: React.FC = () => {
  const [state1, dispatch1] = useReducer(reducer, { count: 0, data: null, loading: false });

  // This SHOULD be detected: dispatch modifies state, effect depends on state
  useEffect(() => {
    dispatch1({ type: 'increment' });
  }, [state1]);

  return <div>Count: {state1.count}</div>;
};

// Pattern 2: CONFIRMED infinite loop - different action type, still modifies state
export const UseReducerSetData: React.FC = () => {
  const [state2, dispatch2] = useReducer(reducer, { count: 0, data: null, loading: false });

  // Different dispatch action but still modifies the state object
  useEffect(() => {
    dispatch2({ type: 'setData', payload: 'new data' });
  }, [state2]);

  return <div>Data: {state2.data}</div>;
};

// Pattern 3: Safe pattern - dispatch with guard
export const UseReducerWithGuard: React.FC = () => {
  const [state3, dispatch3] = useReducer(reducer, { count: 0, data: null, loading: false });

  // Safe because of the guard condition
  useEffect(() => {
    if (state3.count < 10) {
      dispatch3({ type: 'increment' });
    }
  }, [state3]);

  return <div>Count: {state3.count}</div>;
};

// Pattern 4: Safe pattern - dispatch without state in deps
export const UseReducerNoDeps: React.FC = () => {
  const [state4, dispatch4] = useReducer(reducer, { count: 0, data: null, loading: false });

  // Safe - empty dependency array means effect runs once
  useEffect(() => {
    dispatch4({ type: 'increment' });
  }, []);

  return <div>Count: {state4.count}</div>;
};

// Pattern 5: Custom named dispatch (renamed from 'dispatch' to 'send')
// This SHOULD be detected because extractStateInfo tracks the second element
// of the useReducer tuple regardless of its name
export const UseReducerRenamedDispatch: React.FC = () => {
  const [state5, send] = useReducer(reducer, { count: 0, data: null, loading: false });

  // Should be detected - 'send' is tracked as the dispatch function for 'state5'
  useEffect(() => {
    send({ type: 'increment' });
  }, [state5]);

  return <div>Count: {state5.count}</div>;
};

// Pattern 6: useCallback that wraps dispatch - creates indirect loop
export const UseReducerInCallback: React.FC = () => {
  const [state6, dispatch6] = useReducer(reducer, { count: 0, data: null, loading: false });

  // This callback wraps dispatch and depends on state
  const loadData = useCallback(() => {
    dispatch6({ type: 'setData', payload: 'loaded' });
  }, [state6]);

  // When effect calls loadData and depends on it, indirect loop potential
  useEffect(() => {
    loadData();
  }, [loadData]);

  return <div>Data: {state6.data}</div>;
};

// Pattern 7: Safe - useCallback with dispatch, no state deps
export const UseReducerSafeCallback: React.FC = () => {
  const [state7, dispatch7] = useReducer(reducer, { count: 0, data: null, loading: false });

  // dispatch is stable (same reference across renders)
  // No state dependencies means callback is stable
  const increment = useCallback(() => {
    dispatch7({ type: 'increment' });
  }, []);

  // Effect depends on stable callback - runs once
  useEffect(() => {
    increment();
  }, [increment]);

  return <div>Count: {state7.count}</div>;
};

// Pattern 8: Async IIFE with dispatch - common real-world pattern
export const UseReducerAsyncIIFE: React.FC = () => {
  const [state8, dispatch8] = useReducer(reducer, { count: 0, data: null, loading: false });

  // IIFE async pattern - should still detect the dispatch
  useEffect(() => {
    (async () => {
      dispatch8({ type: 'setLoading', payload: true });
    })();
  }, [state8]);

  return <div>Loading: {state8.loading ? 'Yes' : 'No'}</div>;
};

// ============================================================================
// ADVANCED PATTERNS - These are now fully implemented and detected!
// ============================================================================

// Pattern 9: Member expression dependency (e.g., state.count instead of state)
// NOW DETECTED: extractRootIdentifier() in hook-analyzer.ts handles MemberExpressions
// by extracting the root identifier (state.count -> state)
export const UseReducerMemberExpressionDep: React.FC = () => {
  const [state9, dispatch9] = useReducer(reducer, { count: 0, data: null, loading: false });

  // NOW DETECTED: dependency [state9.count] is parsed to extract root 'state9'
  useEffect(() => {
    dispatch9({ type: 'increment' });
  }, [state9.count]); // MemberExpression - root identifier 'state9' is extracted

  return <div>Count: {state9.count}</div>;
};

// Pattern 10: Cleanup function with dispatch
// NOW DETECTED: cleanupFunctionNodes tracking in effect-analyzer.ts detects this
export const UseReducerCleanupLoop: React.FC = () => {
  const [state10, dispatch10] = useReducer(reducer, { count: 0, data: null, loading: false });

  // The cleanup function dispatches, which modifies state, triggering re-render
  // which causes effect to re-run, which causes cleanup to run again
  useEffect(() => {
    return () => {
      dispatch10({ type: 'increment' });
    };
  }, [state10]);

  return <div>Count: {state10.count}</div>;
};

// Pattern 11: Dispatch in nested local function
// NOW DETECTED: buildLocalFunctionSetterMap() traces outerFn -> innerFn -> dispatch chains
export const UseReducerNestedFunction: React.FC = () => {
  const [state11, dispatch11] = useReducer(reducer, { count: 0, data: null, loading: false });

  const outerFn = () => {
    const innerFn = () => {
      dispatch11({ type: 'increment' });
    };
    innerFn();
  };

  // NOW DETECTED: transitive setter call through outerFn -> innerFn -> dispatch11
  useEffect(() => {
    outerFn();
  }, [state11]);

  return <div>Count: {state11.count}</div>;
};
