import React, { useState, useEffect, useCallback } from 'react';

interface DataType {
  value: number;
  processed?: boolean;
}

function CircularExample() {
  const [count, setCount] = useState(0);
  const [data, setData] = useState<DataType | null>(null);

  const fetchData = useCallback(() => {
    console.log('Fetching data...');
    setData({ value: count });
  }, [count, data]);

  const handleIncrement = useCallback(() => {
    setCount(count + 1);
    fetchData();
  }, [count, fetchData]);

  useEffect(() => {
    console.log('Effect running', data);
    if (data && data.value < 10) {
      handleIncrement();
    }
  }, [data, handleIncrement]);

  const processedData = React.useMemo(() => {
    return data ? { ...data, processed: true } : null;
  }, [data, processedData]);

  return (
    <div>
      <h1>Count: {count}</h1>
      <button onClick={handleIncrement}>Increment</button>
      <pre>{JSON.stringify(processedData, null, 2)}</pre>
    </div>
  );
}

export default CircularExample;
