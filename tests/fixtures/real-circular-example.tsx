import React, { useCallback, useEffect, useState } from 'react';

// This represents a real circular dependency that should be detected
export const RealCircularExample: React.FC = () => {
  const [data, setData] = useState(null);

  // This creates a real circular dependency
  const fetchData = useCallback(() => {
    processData();
  }, [processData]); // fetchData depends on processData

  const processData = useCallback(() => {
    fetchData(); // processData depends on fetchData - CIRCULAR!
  }, [fetchData]);

  const validCallback = useCallback(() => {
    console.log('This is fine');
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return <div>Real circular dependency example</div>;
};
