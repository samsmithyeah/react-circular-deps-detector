import React, { useRef, useState, useEffect } from 'react';

// SAFE: Ref mutation with state value in effect (standard usePrevious/useLatest pattern)
// Having ref in deps is unnecessary (refs are stable) but NOT harmful
function RefMutationWithStateDep() {
  const [count, setCount] = useState(0);
  const countRef = useRef(count);

  // This effect stores state in ref - this is the standard usePrevious/useLatest pattern
  // Ref mutations inside effects are SAFE - they don't cause infinite loops
  // Note: countRef in deps is unnecessary since refs are stable, but it's not a bug
  useEffect(() => {
    countRef.current = count; // Mutates ref with state value - SAFE in effects
    console.log('Count changed:', countRef.current);
  }, [count, countRef]); // countRef in deps is unnecessary but harmless

  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>Increment</button>
    </div>
  );
}

// SAFE: Ref mutation without depending on the ref
function SafeRefMutation() {
  const [count, setCount] = useState(0);
  const countRef = useRef(count);

  // This is a common and safe pattern - storing latest value in ref
  useEffect(() => {
    countRef.current = count;
  }, [count]); // Only depends on count, not ref

  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>Increment</button>
    </div>
  );
}

// SAFE: Ref mutation with non-state value
function RefMutationWithNonState() {
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
  }, []); // Empty deps, no state

  return <div>Timer running</div>;
}

export { RefMutationWithStateDep, SafeRefMutation, RefMutationWithNonState };
