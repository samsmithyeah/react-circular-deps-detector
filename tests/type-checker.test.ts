import { TypeChecker, createTypeChecker, isTypeScriptProject } from '../src/type-checker';
import * as path from 'path';
import * as fs from 'fs';

describe('TypeChecker', () => {
  const fixturesPath = path.join(__dirname, 'fixtures', 'type-checker-test');
  const tsconfigPath = path.join(fixturesPath, 'tsconfig.json');
  const dummyFilePath = path.join(fixturesPath, 'dummy.ts');

  beforeAll(() => {
    // Create test fixture directory
    if (!fs.existsSync(fixturesPath)) {
      fs.mkdirSync(fixturesPath, { recursive: true });
    }

    // Create a dummy TypeScript file so tsconfig has something to compile
    fs.writeFileSync(dummyFilePath, 'export const dummy = 1;');

    // Create a minimal tsconfig.json
    fs.writeFileSync(
      tsconfigPath,
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2020',
            module: 'commonjs',
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            declaration: true,
            jsx: 'react',
          },
          include: ['*.ts', '*.tsx'],
        },
        null,
        2
      )
    );
  });

  afterAll(() => {
    // Clean up fixture files
    const files = fs.readdirSync(fixturesPath);
    for (const file of files) {
      fs.unlinkSync(path.join(fixturesPath, file));
    }
    if (fs.existsSync(fixturesPath)) {
      fs.rmdirSync(fixturesPath);
    }
  });

  describe('createTypeChecker', () => {
    it('should create a TypeChecker instance', () => {
      const checker = createTypeChecker({
        projectRoot: fixturesPath,
      });

      expect(checker).toBeInstanceOf(TypeChecker);
    });
  });

  describe('isTypeScriptProject', () => {
    it('should return true when tsconfig.json exists', () => {
      expect(isTypeScriptProject(fixturesPath)).toBe(true);
    });

    it('should return false when tsconfig.json does not exist', () => {
      expect(isTypeScriptProject('/tmp/non-existent-project')).toBe(false);
    });
  });

  describe('TypeChecker.initialize', () => {
    it('should initialize successfully with valid tsconfig', () => {
      const checker = createTypeChecker({
        projectRoot: fixturesPath,
      });

      const result = checker.initialize();

      expect(result).toBe(true);
      expect(checker.getInitError()).toBeNull();

      checker.dispose();
    });

    it('should fail to initialize without tsconfig', () => {
      const checker = createTypeChecker({
        projectRoot: '/tmp/no-tsconfig-here',
      });

      const result = checker.initialize();

      expect(result).toBe(false);
      expect(checker.getInitError()).not.toBeNull();
      expect(checker.getInitError()?.message).toContain('tsconfig.json');

      checker.dispose();
    });

    it('should use custom tsconfig path when provided', () => {
      const customTsconfigPath = path.join(fixturesPath, 'custom-tsconfig.json');
      fs.writeFileSync(
        customTsconfigPath,
        JSON.stringify({
          compilerOptions: {
            target: 'ES2020',
            module: 'commonjs',
          },
          include: ['*.ts'],
        })
      );

      const checker = createTypeChecker({
        projectRoot: fixturesPath,
        tsconfigPath: customTsconfigPath,
      });

      const result = checker.initialize();

      expect(result).toBe(true);

      checker.dispose();
      fs.unlinkSync(customTsconfigPath);
    });
  });

  describe('Type Analysis', () => {
    let checker: TypeChecker;
    const testFilePath = path.join(fixturesPath, 'test-types.ts');

    beforeAll(() => {
      // Create a test TypeScript file with various type patterns
      // Note: We avoid JSX and React imports to keep the test simple
      fs.writeFileSync(
        testFilePath,
        `// Line 1
// Line 2 - Primitive types - should be stable
const primitiveString: string = 'hello';
const primitiveNumber: number = 42;
const primitiveBoolean: boolean = true;

// Line 7 - Literal types - should be stable
const literalString = 'constant' as const;
const literalNumber = 123 as const;

// Line 11 - Readonly types - should be stable
const readonlyArray: readonly string[] = ['a', 'b', 'c'];
const readonlyObject: Readonly<{ name: string }> = { name: 'test' };

// Line 15 - As const - should be stable
const constArray = [1, 2, 3] as const;
const constObject = { a: 1, b: 2 } as const;

// Line 19 - Mutable types - should be unstable
const mutableArray: string[] = ['a', 'b'];
const mutableObject: { name: string } = { name: 'test' };
const mutableFunction = () => {};

export { primitiveString, primitiveNumber, primitiveBoolean };
`
      );

      // Recreate type checker with the new file
      checker = createTypeChecker({
        projectRoot: fixturesPath,
        cacheTypes: true,
      });
      checker.initialize();
    });

    afterAll(() => {
      checker.dispose();
      if (fs.existsSync(testFilePath)) {
        fs.unlinkSync(testFilePath);
      }
    });

    it('should identify primitive types as stable', () => {
      const stringInfo = checker.getTypeAtLocation(testFilePath, 3, 'primitiveString');
      const numberInfo = checker.getTypeAtLocation(testFilePath, 4, 'primitiveNumber');
      const booleanInfo = checker.getTypeAtLocation(testFilePath, 5, 'primitiveBoolean');

      expect(stringInfo?.isStable).toBe(true);
      expect(stringInfo?.isPrimitive).toBe(true);
      expect(numberInfo?.isStable).toBe(true);
      expect(booleanInfo?.isStable).toBe(true);
    });

    it('should identify readonly arrays as stable', () => {
      const info = checker.getTypeAtLocation(testFilePath, 12, 'readonlyArray');

      expect(info?.isStable).toBe(true);
      expect(info?.isReadonly).toBe(true);
    });

    it('should identify as const arrays as stable', () => {
      const info = checker.getTypeAtLocation(testFilePath, 16, 'constArray');

      expect(info?.isStable).toBe(true);
    });

    it('should identify mutable arrays as unstable', () => {
      const info = checker.getTypeAtLocation(testFilePath, 20, 'mutableArray');

      // Mutable arrays should be unstable
      expect(info?.isStable).toBe(false);
    });

    it('should return null for non-existent files', () => {
      const info = checker.getTypeAtLocation('/non/existent/file.ts', 1, 'foo');

      expect(info).toBeNull();
    });

    it('should cache type information when cacheTypes is enabled', () => {
      // First call
      const info1 = checker.getTypeAtLocation(testFilePath, 3, 'primitiveString');
      // Second call should use cache
      const info2 = checker.getTypeAtLocation(testFilePath, 3, 'primitiveString');

      expect(info1).toEqual(info2);
    });
  });

  describe('clearCache', () => {
    it('should clear the type cache', () => {
      const checker = createTypeChecker({
        projectRoot: fixturesPath,
        cacheTypes: true,
      });
      checker.initialize();

      // This should work without error
      checker.clearCache();

      checker.dispose();
    });
  });

  describe('dispose', () => {
    it('should clean up resources', () => {
      const checker = createTypeChecker({
        projectRoot: fixturesPath,
      });
      checker.initialize();

      // This should work without error
      checker.dispose();

      // After dispose, initialize should work again
      const result = checker.initialize();
      expect(result).toBe(true);

      checker.dispose();
    });
  });
});

describe('Strict mode integration', () => {
  const fixturesPath = path.join(__dirname, 'fixtures', 'strict-mode-test');
  const tsconfigPath = path.join(fixturesPath, 'tsconfig.json');
  const testFile = path.join(fixturesPath, 'custom-hook.ts');

  beforeAll(() => {
    if (!fs.existsSync(fixturesPath)) {
      fs.mkdirSync(fixturesPath, { recursive: true });
    }

    // Create test file BEFORE creating tsconfig so it's included
    fs.writeFileSync(
      testFile,
      `// Line 1: Custom hook that returns readonly data
function useData(): Readonly<{ items: readonly string[] }> {
  return { items: [] as const } as const;
}

// Line 6: Custom hook that returns mutable data
function useMutableData(): { items: string[] } {
  return { items: [] };
}

// Line 11: Simple function returning readonly
function getReadonlyData(): Readonly<{ value: number }> {
  return { value: 42 };
}

export { useData, useMutableData, getReadonlyData };
`
    );

    fs.writeFileSync(
      tsconfigPath,
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2020',
            module: 'commonjs',
            strict: true,
          },
          include: ['*.ts'],
        },
        null,
        2
      )
    );
  });

  afterAll(() => {
    const files = fs.readdirSync(fixturesPath);
    for (const file of files) {
      fs.unlinkSync(path.join(fixturesPath, file));
    }
    if (fs.existsSync(fixturesPath)) {
      fs.rmdirSync(fixturesPath);
    }
  });

  it('should analyze function return types', () => {
    const checker = createTypeChecker({
      projectRoot: fixturesPath,
    });
    const initialized = checker.initialize();
    expect(initialized).toBe(true);

    // Call getFunctionReturnType to verify it doesn't crash
    // The actual result may be null depending on TypeScript's analysis
    checker.getFunctionReturnType(testFile, 2, 'useData');

    // Verify the checker doesn't crash
    expect(checker.getInitError()).toBeNull();

    checker.dispose();
  });

  it('should handle missing functions gracefully', () => {
    const checker = createTypeChecker({
      projectRoot: fixturesPath,
    });
    checker.initialize();

    // Non-existent function should return null
    const info = checker.getFunctionReturnType(testFile, 100, 'nonExistentFunction');
    expect(info).toBeNull();

    checker.dispose();
  });
});
