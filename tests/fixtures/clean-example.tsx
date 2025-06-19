import React, { useState, useEffect, useCallback, useMemo } from 'react';

// This file contains NO circular dependencies - should be clean

function CleanComponent() {
  const [count, setCount] = useState(0);
  const [data, setData] = useState<any>(null);
  
  // Clean dependencies - no cycles
  const fetchData = useCallback(async () => {
    console.log('Fetching data...');
    const response = await fetch('/api/data');
    const result = await response.json();
    setData(result);
  }, []); // No dependencies
  
  const processData = useCallback((rawData: any) => {
    console.log('Processing data...');
    return rawData ? { ...rawData, processed: true } : null;
  }, []); // No dependencies
  
  const memoizedValue = useMemo(() => {
    return count * 2;
  }, [count]); // Only depends on count
  
  const handleIncrement = useCallback(() => {
    setCount(prev => prev + 1);
  }, []); // Uses functional update, no dependencies
  
  useEffect(() => {
    fetchData();
  }, []); // Only runs once
  
  useEffect(() => {
    if (data) {
      console.log('Data updated:', data);
    }
  }, [data]); // Only depends on data
  
  return (
    <div>
      <h1>Clean Component</h1>
      <p>Count: {count}</p>
      <p>Memoized Value: {memoizedValue}</p>
      <button onClick={handleIncrement}>Increment</button>
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </div>
  );
}

export default CleanComponent;