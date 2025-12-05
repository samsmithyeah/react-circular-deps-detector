import React, { useCallback } from 'react';
import { useMyContext } from './context';
import { processData, validateInput } from './utils';

// This component creates a circular dependency:
// component.tsx → context.tsx → utils.tsx → component.tsx

export const MyComponent: React.FC = () => {
  const { updateData } = useMyContext();

  const handleSubmit = useCallback(
    (data: Record<string, unknown>) => {
      if (validateInput(data)) {
        const processed = processData(data);
        updateData(processed);
      }
    },
    [updateData]
  );

  return (
    <div>
      <button onClick={() => handleSubmit({ test: true })}>Submit</button>
    </div>
  );
};

export default MyComponent;
