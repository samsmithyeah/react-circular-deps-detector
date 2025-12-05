import React, { useRef, useState, useEffect } from 'react';

// BAD: Ref mutation with state value in effect that depends on ref
// This can cause stale closure issues
function RefMutationWithStateDep() {
  const [count, setCount] = useState(0);
  const countRef = useRef(count);

  // This effect stores state in ref and depends on the ref
  // Can cause stale closure issues
  useEffect(() => {
    countRef.current = count; // Mutates ref with state value
    console.log('Count changed:', countRef.current);
  }, [count, countRef]); // Depends on both count and ref

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
