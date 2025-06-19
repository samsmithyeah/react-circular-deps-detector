import React, { useState, useCallback, useEffect } from 'react';

// Test case for React hooks dependency loops
export const HooksDependencyLoopExample: React.FC = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [data, setData] = useState(null);
  const [backgroundActive, setBackgroundActive] = useState(false);

  // Pattern 1: useCallback that depends on state it modifies
  const problematicFunction = useCallback(async () => {
    setIsLoading(true); // Modifies state it depends on
    
    // Simulate async work
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    setIsLoading(false);
  }, [isLoading]); // Depends on isLoading but modifies it - LOOP!

  // Pattern 2: Indirect state mutation through other functions
  const startBackgroundTracking = useCallback(async () => {
    // This function modifies backgroundActive
    setBackgroundActive(true);
    return true;
  }, []);

  const updateTrackingMode = useCallback(async () => {
    // This function calls startBackgroundTracking which modifies backgroundActive
    const success = await startBackgroundTracking();
    console.log('Tracking updated:', success);
  }, [backgroundActive, startBackgroundTracking]); // Depends on backgroundActive but indirectly modifies it

  // Pattern 3: useEffect that depends on function creating loops
  useEffect(() => {
    updateTrackingMode(); // This creates an infinite loop
  }, [updateTrackingMode]); // Effect re-runs when function recreates

  // Pattern 4: More complex indirect loop
  const fetchData = useCallback(async () => {
    if (!data) {
      const result = await fetch('/api/data');
      setData(result); // Modifies data
    }
  }, [data]); // Depends on data but modifies it

  const processData = useCallback(() => {
    fetchData(); // Calls function that modifies state
  }, [fetchData]); // Depends on fetchData

  useEffect(() => {
    processData(); // Indirect loop: processData → fetchData → setData → data changes → fetchData recreates → processData recreates → effect runs
  }, [processData]);

  return (
    <div>
      <p>Loading: {isLoading ? 'Yes' : 'No'}</p>
      <p>Background Active: {backgroundActive ? 'Yes' : 'No'}</p>
      <p>Data: {data ? 'Loaded' : 'None'}</p>
    </div>
  );
};