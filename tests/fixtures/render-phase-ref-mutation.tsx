import React, { useRef, useState, useEffect, useCallback } from 'react';

// ============================================================================
// PROBLEMATIC PATTERNS - Should trigger RLD-600
// ============================================================================

// BUG: Render-phase ref mutation with state value (high severity)
function RenderPhaseRefWithState() {
  const [count, setCount] = useState(0);
  const countRef = useRef(0);

  // This is problematic - mutating ref during render
  countRef.current = count;

  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>Increment</button>
    </div>
  );
}

// BUG: Render-phase ref mutation without state (medium severity)
function RenderPhaseRefWithoutState() {
  const renderCountRef = useRef(0);

  // Mutating ref during render - tracks render count but violates concurrent mode
  renderCountRef.current += 1;

  return <div>Rendered {renderCountRef.current} times</div>;
}

// BUG: Render-phase ref mutation with derived value
function RenderPhaseRefWithDerived() {
  const [items, setItems] = useState<string[]>([]);
  const countRef = useRef(0);

  // Mutating ref with value derived from state
  countRef.current = items.length;

  return (
    <div>
      <p>Items: {countRef.current}</p>
      <button onClick={() => setItems([...items, 'new'])}>Add</button>
    </div>
  );
}

// BUG: Arrow function component with render-phase ref mutation
const ArrowComponentWithRefMutation = () => {
  const [value, setValue] = useState('');
  const prevRef = useRef('');

  // Render-phase ref mutation in arrow component
  prevRef.current = value;

  return <input value={value} onChange={(e) => setValue(e.target.value)} />;
};

// ============================================================================
// SAFE PATTERNS - Should NOT trigger RLD-600
// ============================================================================

// SAFE: Ref mutation inside useEffect
function SafeEffectRefMutation() {
  const [count, setCount] = useState(0);
  const countRef = useRef(0);

  useEffect(() => {
    countRef.current = count; // Safe - inside effect
  }, [count]);

  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>Increment</button>
    </div>
  );
}

// SAFE: Ref mutation inside useLayoutEffect
function SafeLayoutEffectRefMutation() {
  const [count] = useState(0);
  const countRef = useRef(0);

  React.useLayoutEffect(() => {
    countRef.current = count; // Safe - inside layout effect
  }, [count]);

  return <div>{count}</div>;
}

// SAFE: Ref mutation inside event handler
function SafeEventHandlerRefMutation() {
  const clickCountRef = useRef(0);

  const handleClick = () => {
    clickCountRef.current += 1; // Safe - inside event handler
    console.log('Clicked', clickCountRef.current, 'times');
  };

  return <button onClick={handleClick}>Click me</button>;
}

// SAFE: Ref mutation inside callback
function SafeCallbackRefMutation() {
  const [items, setItems] = useState<string[]>([]);
  const lastAddedRef = useRef('');

  const addItem = useCallback((item: string) => {
    lastAddedRef.current = item; // Safe - inside callback
    setItems((prev) => [...prev, item]);
  }, []);

  return (
    <div>
      <button onClick={() => addItem('item')}>Add</button>
    </div>
  );
}

// SAFE: Ref mutation inside nested function
function SafeNestedFunctionRefMutation() {
  const countRef = useRef(0);

  function updateRef(value: number) {
    countRef.current = value; // Safe - inside nested function
  }

  return <button onClick={() => updateRef(42)}>Update</button>;
}

// SAFE: Timer ref (no state involved)
function SafeTimerRef() {
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    timerRef.current = window.setInterval(() => {
      console.log('tick');
    }, 1000);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, []);

  return <div>Timer running</div>;
}

// SAFE: Ref used in JSX (reading, not mutating)
function SafeRefRead() {
  const inputRef = useRef<HTMLInputElement>(null);

  return <input ref={inputRef} />;
}

export {
  // Problematic
  RenderPhaseRefWithState,
  RenderPhaseRefWithoutState,
  RenderPhaseRefWithDerived,
  ArrowComponentWithRefMutation,
  // Safe
  SafeEffectRefMutation,
  SafeLayoutEffectRefMutation,
  SafeEventHandlerRefMutation,
  SafeCallbackRefMutation,
  SafeNestedFunctionRefMutation,
  SafeTimerRef,
  SafeRefRead,
};
