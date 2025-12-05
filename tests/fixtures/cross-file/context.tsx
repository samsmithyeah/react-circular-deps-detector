import React, { createContext, useContext, useCallback, useState } from 'react';
import { transformData } from './utils';

// This context creates part of the circular dependency:
// context.tsx → utils.tsx → component.tsx → context.tsx

interface MyContextType {
  data: Record<string, unknown> | null;
  updateData: (newData: Record<string, unknown>) => void;
}

const MyContext = createContext<MyContextType | null>(null);

export const MyProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [data, setData] = useState<Record<string, unknown> | null>(null);

  const updateData = useCallback((newData: Record<string, unknown>) => {
    // Use utility function that creates circular dependency
    const transformed = transformData(newData);
    setData(transformed);
  }, []);

  return <MyContext.Provider value={{ data, updateData }}>{children}</MyContext.Provider>;
};

export const useMyContext = () => {
  const context = useContext(MyContext);
  if (!context) {
    throw new Error('useMyContext must be used within MyProvider');
  }
  return context;
};
