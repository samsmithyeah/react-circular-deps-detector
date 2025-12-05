import React, { useState, useCallback, useEffect, useMemo } from 'react';

interface DataType {
  [key: string]: unknown;
}

// Test fixture with proper hooks usage (should not trigger any warnings)
export const CleanHooksExample: React.FC = () => {
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<DataType | null>(null);

  // Clean pattern 1: useCallback that doesn't modify its dependencies
  const incrementCount = useCallback(() => {
    setCount((prev) => prev + 1); // Uses previous value, doesn't depend on count
  }, []); // No dependencies

  // Clean pattern 2: useCallback with stable dependencies
  const fetchData = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/data/${id}`);
      const result = await response.json();
      setData(result);
    } finally {
      setLoading(false);
    }
  }, []); // No dependencies

  // Clean pattern 3: useMemo with stable computation
  const computedValue = useMemo(() => {
    return count * 2 + 10;
  }, [count]); // Depends on count but doesn't modify it

  // Clean pattern 4: useEffect with proper dependencies (no state modification)
  useEffect(() => {
    if (count > 10) {
      console.log('Count is high:', count);
    }
  }, [count]); // Depends on count but doesn't modify it directly

  // Clean pattern 5: useCallback that modifies different state
  const toggleLoading = useCallback(() => {
    setLoading((prev) => !prev); // Modifies loading but doesn't depend on it
  }, []); // No dependencies

  // Clean pattern 6: useEffect that doesn't depend on functions it calls
  useEffect(() => {
    const timer = setTimeout(() => {
      toggleLoading();
    }, 1000);

    return () => clearTimeout(timer);
  }, []); // No dependencies on toggleLoading

  // Clean pattern 7: Derived state without direct dependency
  const status = useMemo(() => {
    return loading ? 'Loading...' : 'Ready';
  }, [loading]); // Clean dependency

  // Clean pattern 8: Event handlers with stable dependencies
  const handleClick = useCallback((newValue: number) => {
    setCount(newValue);
  }, []); // No dependencies needed

  return (
    <div>
      <p>Count: {count}</p>
      <p>Status: {status}</p>
      <p>Computed: {computedValue}</p>
      <button onClick={() => handleClick(count + 1)}>Increment</button>
      <button onClick={toggleLoading}>Toggle Loading</button>
    </div>
  );
};
