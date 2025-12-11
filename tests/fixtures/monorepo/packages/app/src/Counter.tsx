import React, { useEffect } from 'react';
import { useSharedState } from '@test/shared';

/**
 * A component that uses a shared hook
 */
export function Counter() {
  const { count, increment, decrement } = useSharedState(0);

  // This would be flagged if count was in deps with unconditional update
  useEffect(() => {
    console.log('Count changed:', count);
  }, [count]);

  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={increment}>+</button>
      <button onClick={decrement}>-</button>
    </div>
  );
}
