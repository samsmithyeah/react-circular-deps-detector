import React, { useState, useEffect } from 'react';

// This component has an infinite loop - RLD-200
export function InfiniteLoopComponent() {
  const [count, setCount] = useState(0);

  // This will cause an infinite loop!
  useEffect(() => {
    setCount(count + 1);
  }, [count]);

  return <div>{count}</div>;
}

// This component has an unstable dependency - RLD-400
export function UnstableDepsComponent({ data }: { data: { id: number } }) {
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    // Unstable object literal in deps
    setResult(JSON.stringify(data));
  }, [{ id: data.id }]); // RLD-400: unstable object reference

  return <div>{result}</div>;
}

// This is safe - properly guarded
export function SafeComponent() {
  const [value, setValue] = useState('');

  useEffect(() => {
    if (!value) {
      setValue('default');
    }
  }, [value]);

  return <div>{value}</div>;
}
