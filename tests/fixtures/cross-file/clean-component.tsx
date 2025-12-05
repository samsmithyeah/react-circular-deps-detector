import React, { useState, useCallback } from 'react';
import { helperFunction } from './clean-utils';

// This component has NO circular dependencies - clean import chain

export const CleanComponent: React.FC = () => {
  const [value, setValue] = useState('');

  const handleChange = useCallback((newValue: string) => {
    const processed = helperFunction(newValue);
    setValue(processed);
  }, []);

  return (
    <div>
      <input value={value} onChange={(e) => handleChange(e.target.value)} />
    </div>
  );
};

export default CleanComponent;
