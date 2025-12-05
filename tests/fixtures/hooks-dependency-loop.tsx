import React, { useState, useCallback, useEffect } from 'react';

// Test case for React hooks dependency loops
export const HooksDependencyLoopExample: React.FC = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [data, setData] = useState(null);
  const [count, setCount] = useState(0);

  // Pattern 1: CONFIRMED infinite loop - useEffect directly modifies its own dependency
  useEffect(() => {
    setIsLoading(!isLoading); // Directly modifies isLoading in useEffect - CONFIRMED LOOP!
  }, [isLoading]);

  // Pattern 2: CONFIRMED infinite loop - useEffect modifies dependency unconditionally
  useEffect(() => {
    setCount(count + 1); // Always increments count - CONFIRMED LOOP!
  }, [count]);

  // Pattern 3: useCallback that depends on state it modifies (potential, not confirmed)
  // useCallback doesn't auto-execute, so this is only problematic if called from useEffect
  const problematicFunction = useCallback(async () => {
    setData({ value: 'new' }); // Modifies data
  }, [data]); // Depends on data but modifies it - potential issue

  // Pattern 4: Safe - useCallback with guard
  const safeFunction = useCallback(() => {
    if (!data) {
      setData({ value: 'initial' });
    }
  }, [data]); // Has guard, so it's safe

  return (
    <div>
      <p>Loading: {isLoading ? 'Yes' : 'No'}</p>
      <p>Count: {count}</p>
      <p>Data: {data ? 'Loaded' : 'None'}</p>
      <button onClick={problematicFunction}>Load</button>
      <button onClick={safeFunction}>Initialize</button>
    </div>
  );
};
