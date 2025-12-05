import React, { useState, useEffect, useCallback } from 'react';

interface DataType {
  value: number;
  processed?: boolean;
}

function CleanExample() {
  const [count, setCount] = useState(0);
  const [data, setData] = useState<DataType | null>(null);

  const fetchData = useCallback(() => {
    console.log('Fetching data...');
    setData({ value: count });
  }, [count]);

  const handleIncrement = useCallback(() => {
    setCount((prev) => prev + 1);
  }, []);

  useEffect(() => {
    console.log('Effect running', data);
    if (data && data.value < 10) {
      handleIncrement();
    }
  }, [data, handleIncrement]);

  const processedData = React.useMemo(() => {
    return data ? { ...data, processed: true } : null;
  }, [data]);

  return (
    <div>
      <h1>Count: {count}</h1>
      <button onClick={handleIncrement}>Increment</button>
      <pre>{JSON.stringify(processedData, null, 2)}</pre>
    </div>
  );
}

export default CleanExample;
