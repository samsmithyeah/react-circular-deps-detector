import React, { useState, useEffect, useCallback, useMemo } from 'react';

// This file contains intentional circular dependencies for testing

function CircularDependencyExample() {
  const [count, setCount] = useState(0);

  // Simple circular dependency that should be detected
  const functionA = useCallback(() => {
    functionB();
  }, [functionB]);

  const functionB = useCallback(() => {
    functionA();
  }, [functionA]);

  return (
    <div>
      <h1>Circular Dependencies Test</h1>
      <p>Count: {count}</p>
      <button onClick={functionA}>Test Circular</button>
    </div>
  );
}

export default CircularDependencyExample;
