import { detectCircularDependencies } from '../src/detector';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('JSX Prop Memoization Detection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcd-jsx-memo-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Memoized components should trigger RLD-405', () => {
    it('should detect unstable function passed to local memo-wrapped component', async () => {
      const testFile = path.join(tempDir, 'LocalMemoComponent.tsx');
      fs.writeFileSync(
        testFile,
        `
        import React, { memo, useState } from 'react';

        // Memoized child component
        const MemoButton = memo(function Button({ onClick }: { onClick: () => void }) {
          return <button onClick={onClick}>Click</button>;
        });

        function Parent() {
          const [count, setCount] = useState(0);

          // Unstable function - recreated every render
          const handleClick = () => {
            setCount(c => c + 1);
          };

          // This defeats the purpose of memo!
          return <MemoButton onClick={handleClick} />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const jsxPropIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-405'
      );
      expect(jsxPropIssues.length).toBeGreaterThan(0);
      expect(jsxPropIssues[0].explanation).toMatch(/memoized/i);
      expect(jsxPropIssues[0].problematicDependency).toBe('handleClick');
    });

    it('should detect unstable object passed to local memo-wrapped component', async () => {
      const testFile = path.join(tempDir, 'LocalMemoObject.tsx');
      fs.writeFileSync(
        testFile,
        `
        import React, { memo, useState } from 'react';

        const MemoCard = memo(function Card({ style }: { style: object }) {
          return <div style={style}>Card</div>;
        });

        function Parent() {
          const [count, setCount] = useState(0);

          // Unstable object - recreated every render
          const cardStyle = { color: 'red', padding: 10 };

          return <MemoCard style={cardStyle} />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const jsxPropIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-405'
      );
      expect(jsxPropIssues.length).toBeGreaterThan(0);
      expect(jsxPropIssues[0].problematicDependency).toBe('cardStyle');
    });

    it('should detect unstable array passed to local memo-wrapped component', async () => {
      const testFile = path.join(tempDir, 'LocalMemoArray.tsx');
      fs.writeFileSync(
        testFile,
        `
        import React, { memo, useState } from 'react';

        const MemoList = memo(function List({ items }: { items: string[] }) {
          return <ul>{items.map(i => <li key={i}>{i}</li>)}</ul>;
        });

        function Parent() {
          const [count, setCount] = useState(0);

          // Unstable array - recreated every render
          const listItems = ['a', 'b', 'c'];

          return <MemoList items={listItems} />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const jsxPropIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-405'
      );
      expect(jsxPropIssues.length).toBeGreaterThan(0);
      expect(jsxPropIssues[0].problematicDependency).toBe('listItems');
    });

    it('should detect unstable prop to React.memo wrapped component', async () => {
      const testFile = path.join(tempDir, 'ReactMemoComponent.tsx');
      fs.writeFileSync(
        testFile,
        `
        import React, { useState } from 'react';

        // Using React.memo instead of just memo
        const MemoButton = React.memo(function Button({ onClick }: { onClick: () => void }) {
          return <button onClick={onClick}>Click</button>;
        });

        function Parent() {
          const [count, setCount] = useState(0);

          const handleClick = () => {
            setCount(c => c + 1);
          };

          return <MemoButton onClick={handleClick} />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const jsxPropIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-405'
      );
      expect(jsxPropIssues.length).toBeGreaterThan(0);
    });
  });

  describe('Non-memoized components should NOT trigger RLD-405', () => {
    it('should NOT flag unstable function passed to non-memoized component', async () => {
      const testFile = path.join(tempDir, 'NonMemoComponent.tsx');
      fs.writeFileSync(
        testFile,
        `
        import React, { useState } from 'react';

        // Non-memoized child component
        function Button({ onClick }: { onClick: () => void }) {
          return <button onClick={onClick}>Click</button>;
        }

        function Parent() {
          const [count, setCount] = useState(0);

          // Unstable function - but child is not memoized, so no perf impact
          const handleClick = () => {
            setCount(c => c + 1);
          };

          return <Button onClick={handleClick} />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const jsxPropIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-405'
      );
      expect(jsxPropIssues).toHaveLength(0);
    });

    it('should NOT flag unstable object passed to non-memoized component', async () => {
      const testFile = path.join(tempDir, 'NonMemoObject.tsx');
      fs.writeFileSync(
        testFile,
        `
        import React, { useState } from 'react';

        function Card({ style }: { style: object }) {
          return <div style={style}>Card</div>;
        }

        function Parent() {
          const [count, setCount] = useState(0);

          const cardStyle = { color: 'red', padding: 10 };

          return <Card style={cardStyle} />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const jsxPropIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-405'
      );
      expect(jsxPropIssues).toHaveLength(0);
    });

    it('should NOT flag unstable props passed to HTML elements', async () => {
      const testFile = path.join(tempDir, 'HtmlElement.tsx');
      fs.writeFileSync(
        testFile,
        `
        import React, { useState } from 'react';

        function Parent() {
          const [count, setCount] = useState(0);

          const handleClick = () => setCount(c => c + 1);
          const style = { color: 'red' };

          // HTML elements don't use React.memo, so no warning
          return <button onClick={handleClick} style={style}>Click</button>;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const jsxPropIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-405'
      );
      expect(jsxPropIssues).toHaveLength(0);
    });

    it('should NOT flag unstable props to arrow function components', async () => {
      const testFile = path.join(tempDir, 'ArrowComponent.tsx');
      fs.writeFileSync(
        testFile,
        `
        import React, { useState } from 'react';

        // Arrow function component (not memoized)
        const Button = ({ onClick }: { onClick: () => void }) => {
          return <button onClick={onClick}>Click</button>;
        };

        function Parent() {
          const [count, setCount] = useState(0);

          const handleClick = () => setCount(c => c + 1);

          return <Button onClick={handleClick} />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const jsxPropIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-405'
      );
      expect(jsxPropIssues).toHaveLength(0);
    });
  });

  describe('Cross-file memoization detection', () => {
    it('should detect unstable prop passed to imported memoized component', async () => {
      // Create the memoized component file
      const childFile = path.join(tempDir, 'MemoChild.tsx');
      fs.writeFileSync(
        childFile,
        `
        import React, { memo } from 'react';

        interface Props {
          onClick: () => void;
        }

        export const MemoChild = memo(function Child({ onClick }: Props) {
          return <button onClick={onClick}>Click</button>;
        });
      `
      );

      // Create the parent file that imports it
      const parentFile = path.join(tempDir, 'Parent.tsx');
      fs.writeFileSync(
        parentFile,
        `
        import React, { useState } from 'react';
        import { MemoChild } from './MemoChild';

        function Parent() {
          const [count, setCount] = useState(0);

          const handleClick = () => setCount(c => c + 1);

          return <MemoChild onClick={handleClick} />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const jsxPropIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-405'
      );
      expect(jsxPropIssues.length).toBeGreaterThan(0);
      expect(jsxPropIssues[0].file).toContain('Parent.tsx');
      expect(jsxPropIssues[0].problematicDependency).toBe('handleClick');
    });

    it('should detect unstable prop passed to default-exported memoized component', async () => {
      // Create the memoized component with default export
      const childFile = path.join(tempDir, 'MemoButton.tsx');
      fs.writeFileSync(
        childFile,
        `
        import React, { memo } from 'react';

        interface Props {
          onClick: () => void;
        }

        const Button = memo(function Button({ onClick }: Props) {
          return <button onClick={onClick}>Click</button>;
        });

        export default Button;
      `
      );

      // Create the parent file that imports it
      const parentFile = path.join(tempDir, 'ParentDefault.tsx');
      fs.writeFileSync(
        parentFile,
        `
        import React, { useState } from 'react';
        import MemoButton from './MemoButton';

        function Parent() {
          const [count, setCount] = useState(0);

          const handleClick = () => setCount(c => c + 1);

          return <MemoButton onClick={handleClick} />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const jsxPropIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-405'
      );
      expect(jsxPropIssues.length).toBeGreaterThan(0);
      expect(jsxPropIssues[0].file).toContain('ParentDefault.tsx');
    });

    it('should NOT flag unstable prop passed to imported non-memoized component', async () => {
      // Create the non-memoized component file
      const childFile = path.join(tempDir, 'RegularChild.tsx');
      fs.writeFileSync(
        childFile,
        `
        import React from 'react';

        interface Props {
          onClick: () => void;
        }

        export function RegularChild({ onClick }: Props) {
          return <button onClick={onClick}>Click</button>;
        }
      `
      );

      // Create the parent file that imports it
      const parentFile = path.join(tempDir, 'ParentRegular.tsx');
      fs.writeFileSync(
        parentFile,
        `
        import React, { useState } from 'react';
        import { RegularChild } from './RegularChild';

        function Parent() {
          const [count, setCount] = useState(0);

          const handleClick = () => setCount(c => c + 1);

          return <RegularChild onClick={handleClick} />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const jsxPropIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-405'
      );
      expect(jsxPropIssues).toHaveLength(0);
    });

    it('should detect unstable prop passed to memoized component via namespace import', async () => {
      // Create the memoized component file with named export
      const componentsFile = path.join(tempDir, 'components.tsx');
      fs.writeFileSync(
        componentsFile,
        `
        import React, { memo } from 'react';

        interface ButtonProps {
          onClick: () => void;
        }

        export const MemoButton = memo(function Button({ onClick }: ButtonProps) {
          return <button onClick={onClick}>Click</button>;
        });

        export const RegularButton = ({ onClick }: ButtonProps) => (
          <button onClick={onClick}>Click</button>
        );
      `
      );

      // Create the parent file that uses namespace import
      const parentFile = path.join(tempDir, 'ParentNamespace.tsx');
      fs.writeFileSync(
        parentFile,
        `
        import React, { useState } from 'react';
        import * as Components from './components';

        function Parent() {
          const [count, setCount] = useState(0);

          const handleClick = () => setCount(c => c + 1);

          // This should warn - MemoButton is memoized
          return <Components.MemoButton onClick={handleClick} />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const jsxPropIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-405'
      );
      expect(jsxPropIssues.length).toBeGreaterThan(0);
      expect(jsxPropIssues[0].file).toContain('ParentNamespace.tsx');
      expect(jsxPropIssues[0].problematicDependency).toBe('handleClick');
    });

    it('should NOT flag unstable prop to non-memoized component via namespace import', async () => {
      // Create the component file with named exports
      const componentsFile = path.join(tempDir, 'componentsNonMemo.tsx');
      fs.writeFileSync(
        componentsFile,
        `
        import React from 'react';

        interface ButtonProps {
          onClick: () => void;
        }

        // Non-memoized component
        export const RegularButton = ({ onClick }: ButtonProps) => (
          <button onClick={onClick}>Click</button>
        );
      `
      );

      // Create the parent file that uses namespace import
      const parentFile = path.join(tempDir, 'ParentNamespaceNonMemo.tsx');
      fs.writeFileSync(
        parentFile,
        `
        import React, { useState } from 'react';
        import * as Components from './componentsNonMemo';

        function Parent() {
          const [count, setCount] = useState(0);

          const handleClick = () => setCount(c => c + 1);

          // This should NOT warn - RegularButton is not memoized
          return <Components.RegularButton onClick={handleClick} />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const jsxPropIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-405'
      );
      expect(jsxPropIssues).toHaveLength(0);
    });

    it('should detect unstable prop passed to aliased import of memoized component', async () => {
      // Create the memoized component file
      const childFile = path.join(tempDir, 'MemoButton.tsx');
      fs.writeFileSync(
        childFile,
        `
        import React, { memo } from 'react';

        interface Props {
          onClick: () => void;
        }

        export const MemoButton = memo(function Button({ onClick }: Props) {
          return <button onClick={onClick}>Click</button>;
        });
      `
      );

      // Create the parent file that imports with an alias
      const parentFile = path.join(tempDir, 'ParentAliased.tsx');
      fs.writeFileSync(
        parentFile,
        `
        import React, { useState } from 'react';
        import { MemoButton as MyButton } from './MemoButton';

        function Parent() {
          const [count, setCount] = useState(0);

          const handleClick = () => setCount(c => c + 1);

          // Should warn - MyButton is an alias for memoized MemoButton
          return <MyButton onClick={handleClick} />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const jsxPropIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-405'
      );
      expect(jsxPropIssues.length).toBeGreaterThan(0);
      expect(jsxPropIssues[0].file).toContain('ParentAliased.tsx');
      expect(jsxPropIssues[0].problematicDependency).toBe('handleClick');
    });

    it('should NOT flag unstable prop passed to aliased import of non-memoized component', async () => {
      // Create the non-memoized component file
      const childFile = path.join(tempDir, 'RegularButton.tsx');
      fs.writeFileSync(
        childFile,
        `
        import React from 'react';

        interface Props {
          onClick: () => void;
        }

        export const RegularButton = ({ onClick }: Props) => (
          <button onClick={onClick}>Click</button>
        );
      `
      );

      // Create the parent file that imports with an alias
      const parentFile = path.join(tempDir, 'ParentAliasedNonMemo.tsx');
      fs.writeFileSync(
        parentFile,
        `
        import React, { useState } from 'react';
        import { RegularButton as MyButton } from './RegularButton';

        function Parent() {
          const [count, setCount] = useState(0);

          const handleClick = () => setCount(c => c + 1);

          // Should NOT warn - MyButton is an alias for non-memoized RegularButton
          return <MyButton onClick={handleClick} />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const jsxPropIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-405'
      );
      expect(jsxPropIssues).toHaveLength(0);
    });
  });

  describe('Context.Provider should always warn (RLD-404)', () => {
    it('should still flag unstable value in Context.Provider', async () => {
      const testFile = path.join(tempDir, 'ContextProvider.tsx');
      fs.writeFileSync(
        testFile,
        `
        import React, { createContext, useState } from 'react';

        const MyContext = createContext<{ value: number } | null>(null);

        function Provider({ children }: { children: React.ReactNode }) {
          const [count, setCount] = useState(0);

          // Unstable value object - causes all consumers to re-render
          const contextValue = { value: count };

          return (
            <MyContext.Provider value={contextValue}>
              {children}
            </MyContext.Provider>
          );
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const contextIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-404'
      );
      expect(contextIssues.length).toBeGreaterThan(0);
      expect(contextIssues[0].explanation).toMatch(/context/i);
    });
  });

  describe('Safe patterns with memoized components', () => {
    it('should NOT flag useCallback-wrapped function passed to memoized component', async () => {
      const testFile = path.join(tempDir, 'MemoWithCallback.tsx');
      fs.writeFileSync(
        testFile,
        `
        import React, { memo, useState, useCallback } from 'react';

        const MemoButton = memo(function Button({ onClick }: { onClick: () => void }) {
          return <button onClick={onClick}>Click</button>;
        });

        function Parent() {
          const [count, setCount] = useState(0);

          // Stable function - wrapped with useCallback
          const handleClick = useCallback(() => {
            setCount(c => c + 1);
          }, []);

          return <MemoButton onClick={handleClick} />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const jsxPropIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-405'
      );
      expect(jsxPropIssues).toHaveLength(0);
    });

    it('should NOT flag useMemo-wrapped object passed to memoized component', async () => {
      const testFile = path.join(tempDir, 'MemoWithMemo.tsx');
      fs.writeFileSync(
        testFile,
        `
        import React, { memo, useState, useMemo } from 'react';

        const MemoCard = memo(function Card({ style }: { style: object }) {
          return <div style={style}>Card</div>;
        });

        function Parent() {
          const [count, setCount] = useState(0);

          // Stable object - wrapped with useMemo
          const cardStyle = useMemo(() => ({
            color: 'red',
            padding: 10,
          }), []);

          return <MemoCard style={cardStyle} />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const jsxPropIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-405'
      );
      expect(jsxPropIssues).toHaveLength(0);
    });

    it('should NOT flag primitive props passed to memoized component', async () => {
      const testFile = path.join(tempDir, 'MemoPrimitives.tsx');
      fs.writeFileSync(
        testFile,
        `
        import React, { memo, useState } from 'react';

        const MemoLabel = memo(function Label({ text, count }: { text: string; count: number }) {
          return <span>{text}: {count}</span>;
        });

        function Parent() {
          const [count, setCount] = useState(0);
          const text = "Count";

          // Primitives are stable by value
          return <MemoLabel text={text} count={count} />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const jsxPropIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-405'
      );
      expect(jsxPropIssues).toHaveLength(0);
    });
  });

  describe('Memo detection patterns', () => {
    it('should detect memo with inline function component', async () => {
      const testFile = path.join(tempDir, 'InlineMemo.tsx');
      fs.writeFileSync(
        testFile,
        `
        import React, { memo, useState } from 'react';

        // Memo with inline arrow function
        const MemoButton = memo(({ onClick }: { onClick: () => void }) => (
          <button onClick={onClick}>Click</button>
        ));

        function Parent() {
          const [count, setCount] = useState(0);

          const handleClick = () => setCount(c => c + 1);

          return <MemoButton onClick={handleClick} />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const jsxPropIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-405'
      );
      expect(jsxPropIssues.length).toBeGreaterThan(0);
    });

    it('should detect export default memo(Component)', async () => {
      // Create the memoized component with direct export default memo
      const childFile = path.join(tempDir, 'DirectExportMemo.tsx');
      fs.writeFileSync(
        childFile,
        `
        import React, { memo } from 'react';

        interface Props {
          onClick: () => void;
        }

        function Button({ onClick }: Props) {
          return <button onClick={onClick}>Click</button>;
        }

        export default memo(Button);
      `
      );

      // Create the parent file
      const parentFile = path.join(tempDir, 'ParentDirectExport.tsx');
      fs.writeFileSync(
        parentFile,
        `
        import React, { useState } from 'react';
        import Button from './DirectExportMemo';

        function Parent() {
          const [count, setCount] = useState(0);

          const handleClick = () => setCount(c => c + 1);

          return <Button onClick={handleClick} />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const jsxPropIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-405'
      );
      expect(jsxPropIssues.length).toBeGreaterThan(0);
      expect(jsxPropIssues[0].file).toContain('ParentDirectExport.tsx');
    });

    it('should detect re-exported memo component', async () => {
      // Create the memoized component
      const childFile = path.join(tempDir, 'ReexportMemo.tsx');
      fs.writeFileSync(
        childFile,
        `
        import React, { memo } from 'react';

        interface Props {
          onClick: () => void;
        }

        const InternalButton = memo(function Button({ onClick }: Props) {
          return <button onClick={onClick}>Click</button>;
        });

        // Re-export with different name
        export { InternalButton as MemoButton };
      `
      );

      // Create the parent file
      const parentFile = path.join(tempDir, 'ParentReexport.tsx');
      fs.writeFileSync(
        parentFile,
        `
        import React, { useState } from 'react';
        import { MemoButton } from './ReexportMemo';

        function Parent() {
          const [count, setCount] = useState(0);

          const handleClick = () => setCount(c => c + 1);

          return <MemoButton onClick={handleClick} />;
        }
      `
      );

      const result = await detectCircularDependencies(tempDir, {
        pattern: '*.tsx',
        ignore: [],
      });

      const jsxPropIssues = result.intelligentHooksAnalysis.filter(
        (issue) => issue.errorCode === 'RLD-405'
      );
      expect(jsxPropIssues.length).toBeGreaterThan(0);
    });
  });
});
