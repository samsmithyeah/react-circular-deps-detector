import { detectCircularDependencies } from '../src/detector';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('False Positive Prevention', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcd-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Variable Name Collisions', () => {
    it('should not flag local variable names that match imported identifiers', async () => {
      const testFile = path.join(tempDir, 'test.tsx');
      fs.writeFileSync(
        testFile,
        `
        import React, { useCallback } from 'react';
        
        function Component() {
          const getSenderName = useCallback(async (senderId: string) => {
            const users = await fetchUsers();
            const user = users.find(u => u.id === senderId); // Local 'user' variable
            return user ? user.name : 'Unknown';
          }, []); // No circular dependency here
          
          return <div />;
        }
        
        async function fetchUsers() {
          return [];
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      expect(result.circularDependencies).toHaveLength(0);
    });

    it('should not flag React hooks as circular dependencies', async () => {
      const testFile = path.join(tempDir, 'test.tsx');
      fs.writeFileSync(
        testFile,
        `
        import React, { useState, useCallback } from 'react';
        
        function Component() {
          const [user, setUser] = useState(null);
          
          const handleSubmit = useCallback(() => {
            setUser(prev => ({ ...prev, submitted: true }));
          }, []); // setUser is from useState, not circular
          
          return <div />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      expect(result.circularDependencies).toHaveLength(0);
    });

    it('should not flag imported functions as circular dependencies', async () => {
      const testFile = path.join(tempDir, 'test.tsx');
      fs.writeFileSync(
        testFile,
        `
        import React, { useCallback } from 'react';
        import { getDocs, collection, query } from 'firebase/firestore';
        
        function Component() {
          const fetchData = useCallback(async () => {
            const querySnapshot = await getDocs(query(collection()));
            return querySnapshot.docs;
          }, []); // Firebase functions are imported, not circular
          
          return <div />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      expect(result.circularDependencies).toHaveLength(0);
    });
  });

  describe('Property Access Patterns', () => {
    it('should not flag property access as circular dependencies', async () => {
      const testFile = path.join(tempDir, 'test.tsx');
      fs.writeFileSync(
        testFile,
        `
        import React, { useCallback } from 'react';
        
        function Component() {
          const user = { id: '1', name: 'John' };
          
          const getName = useCallback(() => {
            return user.name; // Property access, not circular
          }, [user.name]); // Depending on property, not circular
          
          return <div />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      expect(result.circularDependencies).toHaveLength(0);
    });
  });

  describe('Constants and Primitives', () => {
    it('should not flag constants as circular dependencies', async () => {
      const testFile = path.join(tempDir, 'test.tsx');
      fs.writeFileSync(
        testFile,
        `
        import React, { useMemo } from 'react';
        
        const TIMEOUT = 5000;
        const API_URL = 'https://api.example.com';
        
        function Component() {
          const config = useMemo(() => {
            return {
              timeout: TIMEOUT,
              url: API_URL
            };
          }, [TIMEOUT, API_URL]); // Constants, not circular
          
          return <div />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      expect(result.circularDependencies).toHaveLength(0);
    });
  });

  describe('Context and Hook Patterns', () => {
    it('should not flag context values as circular dependencies', async () => {
      const testFile = path.join(tempDir, 'test.tsx');
      fs.writeFileSync(
        testFile,
        `
        import React, { useCallback, useContext } from 'react';
        
        const UserContext = React.createContext(null);
        
        function Component() {
          const { user } = useContext(UserContext);
          
          const handleUpdate = useCallback(() => {
            console.log('Updating user:', user);
          }, [user]); // Context value, not circular
          
          return <div />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      expect(result.circularDependencies).toHaveLength(0);
    });
  });

  describe('Non-React Files', () => {
    it('should skip files that are not React components', async () => {
      const testFile = path.join(tempDir, 'utils.ts');
      fs.writeFileSync(
        testFile,
        `
        // This is a utility file, not a React component
        export function processData(data: any) {
          return data.map((item: any) => ({ ...item, processed: true }));
        }
        
        export const CONSTANTS = {
          API_URL: 'https://api.example.com',
          TIMEOUT: 5000
        };
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.ts',
        ignore: [],
      });

      // Should analyze 0 files because it's not a React file
      expect(result.summary.filesAnalyzed).toBe(0);
      expect(result.circularDependencies).toHaveLength(0);
    });
  });

  describe('Large Files and Performance', () => {
    it('should skip very large files', async () => {
      const testFile = path.join(tempDir, 'large.tsx');
      // Create a large file that exceeds the 1MB limit
      const largeContent = 'import React from "react";\n' + 'console.log("test");\n'.repeat(50000);
      fs.writeFileSync(testFile, largeContent);

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      // Should skip the large file
      expect(result.summary.filesAnalyzed).toBe(0);
    });
  });
});
