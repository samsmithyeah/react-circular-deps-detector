import React, { useState, useCallback, useEffect, useMemo } from 'react';

interface DataType {
  count?: number;
  [key: string]: unknown;
}

// Test edge cases for hooks dependency analysis
export const EdgeCaseHooksExample: React.FC = () => {
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<DataType | null>(null);

  // Edge case 1: useState without array destructuring (should not crash)
  const state = useState(0);

  // Edge case 2: useCallback with no dependencies
  const noDepsCallback = useCallback(() => {
    setCount(1);
  }, []);

  // Edge case 3: useCallback with empty dependencies but uses state
  const emptyDepsButUsesState = useCallback(() => {
    setCount(count + 1); // Uses count but not in deps - different issue
  }, []);

  // Edge case 4: Complex dependency with property access
  const complexDependency = useCallback(() => {
    setData({ count });
  }, [data?.count]); // Property access in dependency

  // Edge case 5: Multiple state setters in one function
  const multipleSetters = useCallback(() => {
    setCount(1);
    setLoading(true);
    setData(null);
  }, [count, loading, data]); // Multiple dependencies and setters

  // Edge case 6: Conditional state setter
  const conditionalSetter = useCallback(() => {
    if (count > 0) {
      setCount(count - 1);
    }
  }, [count]);

  // Edge case 7: useMemo with state dependency and setter
  const memoWithSetter = useMemo(() => {
    if (loading) {
      setLoading(false); // Modifies state it depends on
    }
    return count * 2;
  }, [count, loading]);

  // Edge case 8: Nested function calls
  const helper = () => {
    setCount(0);
  };

  const nestedCalls = useCallback(() => {
    helper(); // Indirect state modification
  }, [count]);

  // Edge case 9: useEffect with function dependency that has suspicious name
  const updateData = useCallback(() => {
    setData({ updated: true });
  }, [data]);

  useEffect(() => {
    updateData(); // Should be flagged as potential loop
  }, [updateData]);

  // Edge case 10: useState with function initializer
  const [computed] = useState(() => count * 2);

  return (
    <div>
      <p>Count: {count}</p>
      <p>Loading: {loading ? 'Yes' : 'No'}</p>
      <p>Data: {JSON.stringify(data)}</p>
    </div>
  );
};
