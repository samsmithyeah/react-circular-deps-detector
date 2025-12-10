import { Diagnostic, DiagnosticSeverity, Position } from 'vscode-languageserver';
import { generateCodeActions } from './diagnostics-mapper';

describe('Quick Fix Code Actions', () => {
  const createDiagnostic = (
    errorCode: string,
    line: number,
    problematicDependency?: string
  ): Diagnostic => ({
    range: {
      start: Position.create(line, 0),
      end: Position.create(line, 100),
    },
    severity: DiagnosticSeverity.Warning,
    code: errorCode,
    source: 'react-loop-detector',
    message: 'Test message',
    data: {
      errorCode,
      problematicDependency,
      line: line + 1, // 1-indexed in data
    },
  });

  describe('RLD-400: Unstable object - Wrap in useMemo', () => {
    it('should create useMemo wrap action for object literal', () => {
      const documentText = `import { useEffect } from 'react';

function Component() {
  const config = { id: 1 };
  useEffect(() => {
    console.log(config);
  }, [config]);
}`;

      const diagnostic = createDiagnostic('RLD-400', 6, 'config');
      const actions = generateCodeActions(diagnostic, 'file:///test.tsx', documentText);

      const wrapAction = actions.find((a) => a.title.includes('useMemo'));
      expect(wrapAction).toBeDefined();
      expect(wrapAction?.title).toBe("Wrap 'config' in useMemo");
      expect(wrapAction?.isPreferred).toBe(true);

      // Check that the edit wraps with useMemo and parentheses for object
      const edits = wrapAction?.edit?.changes?.['file:///test.tsx'];
      expect(edits).toBeDefined();
      expect(edits?.length).toBeGreaterThanOrEqual(1);

      // Find the wrap edit (not the import edit)
      const wrapEdit = edits?.find((e) => e.newText.includes('useMemo'));
      expect(wrapEdit?.newText).toContain('useMemo(() => ({ id: 1 }), [])');
    });

    it('should add useMemo import if not present', () => {
      const documentText = `import { useEffect } from 'react';

function Component() {
  const config = { id: 1 };
  useEffect(() => {}, [config]);
}`;

      const diagnostic = createDiagnostic('RLD-400', 4, 'config');
      const actions = generateCodeActions(diagnostic, 'file:///test.tsx', documentText);

      const wrapAction = actions.find((a) => a.title.includes('useMemo'));
      const edits = wrapAction?.edit?.changes?.['file:///test.tsx'];

      // Should have an import edit
      const importEdit = edits?.find(
        (e) => e.newText.includes('useMemo') && e.newText.includes('}')
      );
      expect(importEdit).toBeDefined();
      expect(importEdit?.newText).toContain('useMemo');
    });

    it('should not add import if useMemo already imported', () => {
      const documentText = `import { useEffect, useMemo } from 'react';

function Component() {
  const config = { id: 1 };
  useEffect(() => {}, [config]);
}`;

      const diagnostic = createDiagnostic('RLD-400', 4, 'config');
      const actions = generateCodeActions(diagnostic, 'file:///test.tsx', documentText);

      const wrapAction = actions.find((a) => a.title.includes('useMemo'));
      const edits = wrapAction?.edit?.changes?.['file:///test.tsx'];

      // Should only have one edit (the wrap, no import)
      expect(edits?.length).toBe(1);
    });

    it('should handle multi-line object literals', () => {
      const documentText = `import { useEffect } from 'react';

function Component() {
  const config = {
    id: 1,
    name: 'test'
  };
  useEffect(() => {}, [config]);
}`;

      const diagnostic = createDiagnostic('RLD-400', 7, 'config');
      const actions = generateCodeActions(diagnostic, 'file:///test.tsx', documentText);

      const wrapAction = actions.find((a) => a.title.includes('useMemo'));
      expect(wrapAction).toBeDefined();
    });
  });

  describe('RLD-401: Unstable array - Wrap in useMemo', () => {
    it('should create useMemo wrap action for array literal', () => {
      const documentText = `import { useEffect } from 'react';

function Component() {
  const items = [1, 2, 3];
  useEffect(() => {}, [items]);
}`;

      const diagnostic = createDiagnostic('RLD-401', 4, 'items');
      const actions = generateCodeActions(diagnostic, 'file:///test.tsx', documentText);

      const wrapAction = actions.find((a) => a.title.includes('useMemo'));
      expect(wrapAction).toBeDefined();
      expect(wrapAction?.title).toBe("Wrap 'items' in useMemo");

      const edits = wrapAction?.edit?.changes?.['file:///test.tsx'];
      const wrapEdit = edits?.find((e) => e.newText.includes('useMemo'));
      expect(wrapEdit?.newText).toContain('useMemo(() => [1, 2, 3], [])');
    });
  });

  describe('RLD-402: Unstable function - Wrap in useCallback', () => {
    it('should create useCallback wrap action for arrow function', () => {
      const documentText = `import { useEffect } from 'react';

function Component() {
  const handleClick = () => { console.log('clicked'); };
  useEffect(() => {}, [handleClick]);
}`;

      const diagnostic = createDiagnostic('RLD-402', 4, 'handleClick');
      const actions = generateCodeActions(diagnostic, 'file:///test.tsx', documentText);

      const wrapAction = actions.find((a) => a.title.includes('useCallback'));
      expect(wrapAction).toBeDefined();
      expect(wrapAction?.title).toBe("Wrap 'handleClick' in useCallback");
      expect(wrapAction?.isPreferred).toBe(true);

      const edits = wrapAction?.edit?.changes?.['file:///test.tsx'];
      const wrapEdit = edits?.find((e) => e.newText.includes('useCallback'));
      expect(wrapEdit?.newText).toContain('useCallback');
      expect(wrapEdit?.newText).toContain(', [])');
    });

    it('should add useCallback import if not present', () => {
      const documentText = `import { useEffect } from 'react';

function Component() {
  const handleClick = () => {};
  useEffect(() => {}, [handleClick]);
}`;

      const diagnostic = createDiagnostic('RLD-402', 4, 'handleClick');
      const actions = generateCodeActions(diagnostic, 'file:///test.tsx', documentText);

      const wrapAction = actions.find((a) => a.title.includes('useCallback'));
      const edits = wrapAction?.edit?.changes?.['file:///test.tsx'];

      const importEdit = edits?.find((e) => e.newText.includes('useCallback'));
      expect(importEdit).toBeDefined();
    });

    it('should handle multi-line arrow functions', () => {
      const documentText = `import { useEffect } from 'react';

function Component() {
  const handleClick = () => {
    console.log('clicked');
    doSomething();
  };
  useEffect(() => {}, [handleClick]);
}`;

      const diagnostic = createDiagnostic('RLD-402', 7, 'handleClick');
      const actions = generateCodeActions(diagnostic, 'file:///test.tsx', documentText);

      const wrapAction = actions.find((a) => a.title.includes('useCallback'));
      expect(wrapAction).toBeDefined();
    });

    it('should handle arrow functions with parameters', () => {
      const documentText = `import { useEffect } from 'react';

function Component() {
  const handleClick = (e) => { console.log(e); };
  useEffect(() => {}, [handleClick]);
}`;

      const diagnostic = createDiagnostic('RLD-402', 4, 'handleClick');
      const actions = generateCodeActions(diagnostic, 'file:///test.tsx', documentText);

      const wrapAction = actions.find((a) => a.title.includes('useCallback'));
      expect(wrapAction).toBeDefined();

      const edits = wrapAction?.edit?.changes?.['file:///test.tsx'];
      const wrapEdit = edits?.find((e) => e.newText.includes('useCallback'));
      expect(wrapEdit?.newText).toContain('(e) =>');
    });
  });

  describe('RLD-500: Missing dependency array - Add empty deps', () => {
    it('should create add dependency array action', () => {
      const documentText = `import { useEffect } from 'react';

function Component() {
  useEffect(() => {
    console.log('effect');
  });
}`;

      const diagnostic = createDiagnostic('RLD-500', 3, undefined);
      const actions = generateCodeActions(diagnostic, 'file:///test.tsx', documentText);

      const addDepsAction = actions.find((a) => a.title.includes('dependency array'));
      expect(addDepsAction).toBeDefined();
      expect(addDepsAction?.title).toBe('Add empty dependency array');
      expect(addDepsAction?.isPreferred).toBe(true);

      const edits = addDepsAction?.edit?.changes?.['file:///test.tsx'];
      expect(edits).toBeDefined();
      expect(edits?.length).toBe(1);
      expect(edits?.[0].newText).toBe(', []');
    });

    it('should handle multi-line useEffect without deps', () => {
      const documentText = `import { useEffect } from 'react';

function Component() {
  useEffect(() => {
    console.log('line 1');
    console.log('line 2');
  });
}`;

      const diagnostic = createDiagnostic('RLD-500', 3, undefined);
      const actions = generateCodeActions(diagnostic, 'file:///test.tsx', documentText);

      const addDepsAction = actions.find((a) => a.title.includes('dependency array'));
      expect(addDepsAction).toBeDefined();
    });

    it('should handle useLayoutEffect without deps', () => {
      const documentText = `import { useLayoutEffect } from 'react';

function Component() {
  useLayoutEffect(() => {
    console.log('effect');
  });
}`;

      const diagnostic = createDiagnostic('RLD-500', 3, undefined);
      const actions = generateCodeActions(diagnostic, 'file:///test.tsx', documentText);

      const addDepsAction = actions.find((a) => a.title.includes('dependency array'));
      expect(addDepsAction).toBeDefined();
    });
  });

  describe('Ignore actions', () => {
    it('should always include ignore this line action', () => {
      const documentText = `import { useEffect } from 'react';

function Component() {
  const config = { id: 1 };
  useEffect(() => {}, [config]);
}`;

      const diagnostic = createDiagnostic('RLD-400', 4, 'config');
      const actions = generateCodeActions(diagnostic, 'file:///test.tsx', documentText);

      const ignoreAction = actions.find((a) => a.title.includes('Ignore this'));
      expect(ignoreAction).toBeDefined();
      expect(ignoreAction?.title).toBe('Ignore this RLD-400 issue');
    });

    it('should always include disable for file action', () => {
      const documentText = `import { useEffect } from 'react';

function Component() {
  const config = { id: 1 };
  useEffect(() => {}, [config]);
}`;

      const diagnostic = createDiagnostic('RLD-400', 4, 'config');
      const actions = generateCodeActions(diagnostic, 'file:///test.tsx', documentText);

      const disableAction = actions.find((a) => a.title.includes('Disable'));
      expect(disableAction).toBeDefined();
      expect(disableAction?.title).toBe('Disable RLD-400 for this file');
    });
  });

  describe('Import handling', () => {
    it('should add hook to existing React import with destructuring', () => {
      const documentText = `import { useState } from 'react';

function Component() {
  const config = { id: 1 };
  useEffect(() => {}, [config]);
}`;

      const diagnostic = createDiagnostic('RLD-400', 4, 'config');
      const actions = generateCodeActions(diagnostic, 'file:///test.tsx', documentText);

      const wrapAction = actions.find((a) => a.title.includes('useMemo'));
      const edits = wrapAction?.edit?.changes?.['file:///test.tsx'];

      // Check import edit extends existing import
      const importEdit = edits?.find(
        (e) => e.range.start.line === 0 && e.newText.includes('useMemo')
      );
      expect(importEdit).toBeDefined();
      expect(importEdit?.newText).toContain('useState');
      expect(importEdit?.newText).toContain('useMemo');
    });

    it('should handle import React, { ... } pattern', () => {
      const documentText = `import React, { useState } from 'react';

function Component() {
  const config = { id: 1 };
  useEffect(() => {}, [config]);
}`;

      const diagnostic = createDiagnostic('RLD-400', 4, 'config');
      const actions = generateCodeActions(diagnostic, 'file:///test.tsx', documentText);

      const wrapAction = actions.find((a) => a.title.includes('useMemo'));
      const edits = wrapAction?.edit?.changes?.['file:///test.tsx'];

      const importEdit = edits?.find(
        (e) => e.range.start.line === 0 && e.newText.includes('useMemo')
      );
      expect(importEdit).toBeDefined();
      expect(importEdit?.newText).toContain('React');
      expect(importEdit?.newText).toContain('useMemo');
    });

    it('should handle multi-line React import', () => {
      const documentText = `import {
  useState,
  useEffect
} from 'react';

function Component() {
  const config = { id: 1 };
  useEffect(() => {}, [config]);
}`;

      const diagnostic = createDiagnostic('RLD-400', 8, 'config');
      const actions = generateCodeActions(diagnostic, 'file:///test.tsx', documentText);

      const wrapAction = actions.find((a) => a.title.includes('useMemo'));
      const edits = wrapAction?.edit?.changes?.['file:///test.tsx'];

      // Should replace the multi-line import with single-line including useMemo
      // Look for an edit that contains 'import' and 'useMemo' (the import edit)
      const importEdit = edits?.find(
        (e) => e.newText.includes('import') && e.newText.includes('useMemo')
      );
      expect(importEdit).toBeDefined();
      expect(importEdit?.newText).toContain('useState');
      expect(importEdit?.newText).toContain('useEffect');
      expect(importEdit?.newText).toContain('useMemo');
      // Should replace lines 0-3 (the multi-line import)
      expect(importEdit?.range.start.line).toBe(0);
      expect(importEdit?.range.end.line).toBe(3);
    });
  });

  describe('Edge cases', () => {
    it('should not offer wrap if already wrapped in useMemo', () => {
      const documentText = `import { useEffect, useMemo } from 'react';

function Component() {
  const config = useMemo(() => ({ id: 1 }), []);
  useEffect(() => {}, [config]);
}`;

      const diagnostic = createDiagnostic('RLD-400', 4, 'config');
      const actions = generateCodeActions(diagnostic, 'file:///test.tsx', documentText);

      const wrapAction = actions.find((a) => a.title.includes('useMemo'));
      expect(wrapAction).toBeUndefined();
    });

    it('should return only ignore actions for unknown error codes', () => {
      const documentText = `import { useEffect } from 'react';

function Component() {
  useEffect(() => {});
}`;

      const diagnostic = createDiagnostic('RLD-999', 3, undefined);
      const actions = generateCodeActions(diagnostic, 'file:///test.tsx', documentText);

      // Should only have ignore actions
      expect(actions.every((a) => a.title.includes('Ignore') || a.title.includes('Disable'))).toBe(
        true
      );
    });

    it('should handle missing problematicDependency for wrap actions', () => {
      const documentText = `import { useEffect } from 'react';

function Component() {
  useEffect(() => {});
}`;

      const diagnostic = createDiagnostic('RLD-400', 3, undefined);
      const actions = generateCodeActions(diagnostic, 'file:///test.tsx', documentText);

      // Should not have wrap action without problematicDependency
      const wrapAction = actions.find((a) => a.title.includes('useMemo'));
      expect(wrapAction).toBeUndefined();
    });

    it('should handle objects with single-line comments', () => {
      const documentText = `import { useEffect } from 'react';

function Component() {
  const config = {
    id: 1, // This is a comment with { braces }
    name: 'test'
  };
  useEffect(() => {}, [config]);
}`;

      const diagnostic = createDiagnostic('RLD-400', 8, 'config');
      const actions = generateCodeActions(diagnostic, 'file:///test.tsx', documentText);

      const wrapAction = actions.find((a) => a.title.includes('useMemo'));
      expect(wrapAction).toBeDefined();
    });

    it('should handle objects with block comments', () => {
      const documentText = `import { useEffect } from 'react';

function Component() {
  const config = {
    /* This is a block comment
       with { braces } and multiple lines */
    id: 1
  };
  useEffect(() => {}, [config]);
}`;

      const diagnostic = createDiagnostic('RLD-400', 9, 'config');
      const actions = generateCodeActions(diagnostic, 'file:///test.tsx', documentText);

      const wrapAction = actions.find((a) => a.title.includes('useMemo'));
      expect(wrapAction).toBeDefined();
    });

    it('should handle functions with comments in useCallback wrap', () => {
      const documentText = `import { useEffect } from 'react';

function Component() {
  const handleClick = () => {
    // Do something { with braces }
    console.log('clicked');
  };
  useEffect(() => {}, [handleClick]);
}`;

      const diagnostic = createDiagnostic('RLD-402', 8, 'handleClick');
      const actions = generateCodeActions(diagnostic, 'file:///test.tsx', documentText);

      const wrapAction = actions.find((a) => a.title.includes('useCallback'));
      expect(wrapAction).toBeDefined();
    });

    it('should handle useEffect with strings containing parentheses', () => {
      const documentText = `import { useEffect } from 'react';

function Component() {
  useEffect(() => {
    console.log('A closing paren ) here');
    console.log("Another (paren) here");
  });
}`;

      const diagnostic = createDiagnostic('RLD-500', 3, undefined);
      const actions = generateCodeActions(diagnostic, 'file:///test.tsx', documentText);

      const addDepsAction = actions.find((a) => a.title.includes('dependency array'));
      expect(addDepsAction).toBeDefined();

      // Verify the edit position is correct (should be at the closing paren of useEffect)
      const edits = addDepsAction?.edit?.changes?.['file:///test.tsx'];
      expect(edits).toBeDefined();
      expect(edits?.length).toBe(1);
      expect(edits?.[0].newText).toBe(', []');
    });

    it('should handle useEffect with template literals containing parens', () => {
      const documentText = `import { useEffect } from 'react';

function Component() {
  useEffect(() => {
    const msg = \`template with (parens)\`;
    console.log(msg);
  });
}`;

      const diagnostic = createDiagnostic('RLD-500', 3, undefined);
      const actions = generateCodeActions(diagnostic, 'file:///test.tsx', documentText);

      const addDepsAction = actions.find((a) => a.title.includes('dependency array'));
      expect(addDepsAction).toBeDefined();
    });
  });
});
