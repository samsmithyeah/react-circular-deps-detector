import React, { createContext, useContext, useCallback, useState } from 'react';
import { transformData } from './utils';

// This context creates part of the circular dependency:
// context.tsx → utils.tsx → component.tsx → context.tsx

interface MyContextType {
  data: any;
  updateData: (newData: any) => void;
}

const MyContext = createContext<MyContextType | null>(null);

export const MyProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [data, setData] = useState(null);

  const updateData = useCallback((newData: any) => {
    // Use utility function that creates circular dependency
    const transformed = transformData(newData);
    setData(transformed);
  }, []);

  return (
    <MyContext.Provider value={{ data, updateData }}>
      {children}
    </MyContext.Provider>
  );
};

export const useMyContext = () => {
  const context = useContext(MyContext);
  if (!context) {
    throw new Error('useMyContext must be used within MyProvider');
  }
  return context;
};