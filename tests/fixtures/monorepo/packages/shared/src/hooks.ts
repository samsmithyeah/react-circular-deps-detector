import { useState, useCallback } from 'react';

/**
 * A shared hook that returns stable values
 */
export function useSharedState(initialValue: number) {
  const [count, setCount] = useState(initialValue);

  const increment = useCallback(() => {
    setCount((c) => c + 1);
  }, []);

  const decrement = useCallback(() => {
    setCount((c) => c - 1);
  }, []);

  return { count, increment, decrement };
}

/**
 * A shared utility type
 */
export interface SharedConfig {
  readonly apiUrl: string;
  readonly timeout: number;
}
