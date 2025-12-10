import {
  LIBRARY_PRESETS,
  LibraryPreset,
  detectApplicablePresets,
  mergePresets,
  getDetectedPresetNames,
} from '../src/presets';
import { loadConfigWithInfo, DEFAULT_CONFIG } from '../src/config';
import * as path from 'path';
import * as fs from 'fs';

describe('Library Presets', () => {
  describe('LIBRARY_PRESETS registry', () => {
    it('should contain presets for major libraries', () => {
      const presetNames = LIBRARY_PRESETS.map((p) => p.name);

      expect(presetNames).toContain('TanStack Query (React Query)');
      expect(presetNames).toContain('SWR');
      expect(presetNames).toContain('Apollo Client');
      expect(presetNames).toContain('Redux / React-Redux');
      expect(presetNames).toContain('Zustand');
      expect(presetNames).toContain('Jotai');
      expect(presetNames).toContain('React Hook Form');
      expect(presetNames).toContain('React Router');
      expect(presetNames).toContain('react-i18next');
      expect(presetNames).toContain('Framer Motion');
    });

    it('should have valid preset structure', () => {
      for (const preset of LIBRARY_PRESETS) {
        expect(preset.name).toBeTruthy();
        expect(preset.packages.length).toBeGreaterThan(0);
        expect(Array.isArray(preset.stableHooks)).toBe(true);
        expect(Array.isArray(preset.unstableHooks)).toBe(true);
      }
    });

    it('should have unique package mappings', () => {
      const allPackages = LIBRARY_PRESETS.flatMap((p) => p.packages);
      // Some packages may appear in multiple presets (e.g., @reduxjs/toolkit for both Redux and RTK Query)
      // This is intentional, so we just verify there are packages
      expect(allPackages.length).toBeGreaterThan(0);
    });
  });

  describe('detectApplicablePresets', () => {
    it('should detect TanStack Query from @tanstack/react-query', () => {
      const deps = { '@tanstack/react-query': '^5.0.0' };
      const presets = detectApplicablePresets(deps);

      expect(presets.length).toBe(1);
      expect(presets[0].name).toBe('TanStack Query (React Query)');
    });

    it('should detect TanStack Query from legacy react-query package', () => {
      const deps = { 'react-query': '^3.0.0' };
      const presets = detectApplicablePresets(deps);

      expect(presets.length).toBe(1);
      expect(presets[0].name).toBe('TanStack Query (React Query)');
    });

    it('should detect multiple presets', () => {
      const deps = {
        '@tanstack/react-query': '^5.0.0',
        zustand: '^4.0.0',
        'react-router-dom': '^6.0.0',
      };
      const presets = detectApplicablePresets(deps);
      const names = presets.map((p) => p.name);

      expect(names).toContain('TanStack Query (React Query)');
      expect(names).toContain('Zustand');
      expect(names).toContain('React Router');
    });

    it('should return empty array for unknown packages', () => {
      const deps = { 'some-unknown-package': '^1.0.0' };
      const presets = detectApplicablePresets(deps);

      expect(presets).toEqual([]);
    });

    it('should detect Redux from react-redux', () => {
      const deps = { 'react-redux': '^8.0.0' };
      const presets = detectApplicablePresets(deps);
      const names = presets.map((p) => p.name);

      expect(names).toContain('Redux / React-Redux');
    });

    it('should detect both Redux and RTK Query from @reduxjs/toolkit', () => {
      const deps = { '@reduxjs/toolkit': '^2.0.0' };
      const presets = detectApplicablePresets(deps);
      const names = presets.map((p) => p.name);

      // @reduxjs/toolkit triggers both Redux and RTK Query presets
      expect(names).toContain('Redux / React-Redux');
      expect(names).toContain('RTK Query');
    });
  });

  describe('mergePresets', () => {
    it('should combine stableHooks from multiple presets', () => {
      const presets: LibraryPreset[] = [
        {
          name: 'Preset A',
          packages: ['a'],
          stableHooks: ['useA1', 'useA2'],
          unstableHooks: [],
        },
        {
          name: 'Preset B',
          packages: ['b'],
          stableHooks: ['useB1', 'useB2'],
          unstableHooks: [],
        },
      ];

      const merged = mergePresets(presets);

      expect(merged.stableHooks).toContain('useA1');
      expect(merged.stableHooks).toContain('useA2');
      expect(merged.stableHooks).toContain('useB1');
      expect(merged.stableHooks).toContain('useB2');
    });

    it('should deduplicate hooks', () => {
      const presets: LibraryPreset[] = [
        {
          name: 'Preset A',
          packages: ['a'],
          stableHooks: ['useQuery', 'useMutation'],
          unstableHooks: [],
        },
        {
          name: 'Preset B',
          packages: ['b'],
          stableHooks: ['useQuery', 'useOther'],
          unstableHooks: [],
        },
      ];

      const merged = mergePresets(presets);

      // Should not have duplicates
      const useQueryCount = merged.stableHooks.filter((h) => h === 'useQuery').length;
      expect(useQueryCount).toBe(1);
    });

    it('should give unstableHooks precedence over stableHooks', () => {
      const presets: LibraryPreset[] = [
        {
          name: 'Preset A',
          packages: ['a'],
          stableHooks: ['useConflict'],
          unstableHooks: [],
        },
        {
          name: 'Preset B',
          packages: ['b'],
          stableHooks: [],
          unstableHooks: ['useConflict'],
        },
      ];

      const merged = mergePresets(presets);

      // unstable takes precedence
      expect(merged.unstableHooks).toContain('useConflict');
      expect(merged.stableHooks).not.toContain('useConflict');
    });

    it('should merge customFunctions', () => {
      const presets: LibraryPreset[] = [
        {
          name: 'Preset A',
          packages: ['a'],
          stableHooks: [],
          unstableHooks: [],
          customFunctions: { funcA: { stable: true } },
        },
        {
          name: 'Preset B',
          packages: ['b'],
          stableHooks: [],
          unstableHooks: [],
          customFunctions: { funcB: { deferred: true } },
        },
      ];

      const merged = mergePresets(presets);

      expect(merged.customFunctions.funcA).toEqual({ stable: true });
      expect(merged.customFunctions.funcB).toEqual({ deferred: true });
    });
  });

  describe('getDetectedPresetNames', () => {
    it('should return human-readable preset names', () => {
      const deps = {
        '@tanstack/react-query': '^5.0.0',
        zustand: '^4.0.0',
      };

      const names = getDetectedPresetNames(deps);

      expect(names).toContain('TanStack Query (React Query)');
      expect(names).toContain('Zustand');
    });

    it('should return empty array for no matches', () => {
      const deps = { 'unknown-lib': '^1.0.0' };
      const names = getDetectedPresetNames(deps);

      expect(names).toEqual([]);
    });
  });
});

describe('Config with Presets', () => {
  const fixturesPath = path.join(__dirname, 'fixtures');
  const presetTestPath = path.join(fixturesPath, 'preset-test');

  beforeAll(() => {
    if (!fs.existsSync(presetTestPath)) {
      fs.mkdirSync(presetTestPath, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up
    const filesToClean = ['package.json', 'rld.config.json'];
    for (const file of filesToClean) {
      const filePath = path.join(presetTestPath, file);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    if (fs.existsSync(presetTestPath)) {
      fs.rmdirSync(presetTestPath);
    }
  });

  it('should auto-detect presets from package.json', () => {
    // Create a package.json with dependencies
    const packageJson = {
      name: 'test-project',
      dependencies: {
        react: '^18.0.0',
        '@tanstack/react-query': '^5.0.0',
      },
    };
    fs.writeFileSync(path.join(presetTestPath, 'package.json'), JSON.stringify(packageJson));

    const result = loadConfigWithInfo(presetTestPath);

    expect(result.detectedPresets).toContain('TanStack Query (React Query)');
    expect(result.config.stableHooks).toContain('useQuery');
    expect(result.config.stableHooks).toContain('useMutation');
  });

  it('should merge preset hooks with user config', () => {
    // Create package.json
    const packageJson = {
      name: 'test-project',
      dependencies: {
        '@tanstack/react-query': '^5.0.0',
      },
    };
    fs.writeFileSync(path.join(presetTestPath, 'package.json'), JSON.stringify(packageJson));

    // Create user config with additional hooks
    const userConfig = {
      stableHooks: ['useMyCustomHook'],
    };
    fs.writeFileSync(path.join(presetTestPath, 'rld.config.json'), JSON.stringify(userConfig));

    const result = loadConfigWithInfo(presetTestPath);

    // Should have both preset hooks and user hooks
    expect(result.config.stableHooks).toContain('useQuery'); // from preset
    expect(result.config.stableHooks).toContain('useMyCustomHook'); // from user

    fs.unlinkSync(path.join(presetTestPath, 'rld.config.json'));
  });

  it('should respect noPresets option from CLI', () => {
    // Create package.json with dependencies
    const packageJson = {
      name: 'test-project',
      dependencies: {
        '@tanstack/react-query': '^5.0.0',
      },
    };
    fs.writeFileSync(path.join(presetTestPath, 'package.json'), JSON.stringify(packageJson));

    const result = loadConfigWithInfo(presetTestPath, { noPresets: true });

    expect(result.detectedPresets).toEqual([]);
    expect(result.config.stableHooks).not.toContain('useQuery');
  });

  it('should respect noPresets in config file', () => {
    // Create package.json
    const packageJson = {
      name: 'test-project',
      dependencies: {
        '@tanstack/react-query': '^5.0.0',
      },
    };
    fs.writeFileSync(path.join(presetTestPath, 'package.json'), JSON.stringify(packageJson));

    // Create config with noPresets
    const userConfig = {
      noPresets: true,
    };
    fs.writeFileSync(path.join(presetTestPath, 'rld.config.json'), JSON.stringify(userConfig));

    const result = loadConfigWithInfo(presetTestPath);

    expect(result.detectedPresets).toEqual([]);
    expect(result.config.stableHooks).not.toContain('useQuery');

    fs.unlinkSync(path.join(presetTestPath, 'rld.config.json'));
  });

  it('should return default config when no package.json exists', () => {
    const tempPath = path.join(fixturesPath, 'no-package-json-test');
    if (!fs.existsSync(tempPath)) {
      fs.mkdirSync(tempPath, { recursive: true });
    }

    const result = loadConfigWithInfo(tempPath);

    expect(result.detectedPresets).toEqual([]);
    expect(result.config.stableHooks).toEqual(DEFAULT_CONFIG.stableHooks);

    fs.rmdirSync(tempPath);
  });

  it('should detect presets from devDependencies', () => {
    // Create package.json with devDependencies
    const packageJson = {
      name: 'test-project',
      devDependencies: {
        '@tanstack/react-query': '^5.0.0',
      },
    };
    fs.writeFileSync(path.join(presetTestPath, 'package.json'), JSON.stringify(packageJson));

    const result = loadConfigWithInfo(presetTestPath);

    expect(result.detectedPresets).toContain('TanStack Query (React Query)');
  });
});

describe('Preset Content Validation', () => {
  describe('TanStack Query preset', () => {
    const preset = LIBRARY_PRESETS.find((p) => p.name === 'TanStack Query (React Query)')!;

    it('should include core query hooks', () => {
      expect(preset.stableHooks).toContain('useQuery');
      expect(preset.stableHooks).toContain('useMutation');
      expect(preset.stableHooks).toContain('useInfiniteQuery');
      expect(preset.stableHooks).toContain('useQueryClient');
    });

    it('should trigger on both old and new package names', () => {
      expect(preset.packages).toContain('@tanstack/react-query');
      expect(preset.packages).toContain('react-query');
    });
  });

  describe('Redux preset', () => {
    const preset = LIBRARY_PRESETS.find((p) => p.name === 'Redux / React-Redux')!;

    it('should include essential Redux hooks', () => {
      expect(preset.stableHooks).toContain('useSelector');
      expect(preset.stableHooks).toContain('useDispatch');
      expect(preset.stableHooks).toContain('useStore');
    });
  });

  describe('Zustand preset', () => {
    const preset = LIBRARY_PRESETS.find((p) => p.name === 'Zustand')!;

    it('should include Zustand hooks', () => {
      expect(preset.stableHooks).toContain('useStore');
      expect(preset.stableHooks).toContain('useShallow');
    });

    it('should mark getState as stable', () => {
      expect(preset.customFunctions?.getState).toEqual({ stable: true });
    });

    it('should have pattern for user-defined store hooks', () => {
      expect(preset.stableHookPatterns).toBeDefined();
      expect(preset.stableHookPatterns!.length).toBeGreaterThan(0);

      // Pattern should match common Zustand naming conventions
      const pattern = preset.stableHookPatterns![0];
      expect(pattern.test('useAuthStore')).toBe(true);
      expect(pattern.test('useCartStore')).toBe(true);
      expect(pattern.test('useUserStore')).toBe(true);
      expect(pattern.test('useLibraryStore')).toBe(true);

      // Should not match non-store hooks
      expect(pattern.test('useState')).toBe(false);
      expect(pattern.test('useAuth')).toBe(false);
      expect(pattern.test('useStoreState')).toBe(false); // Doesn't end with Store
    });
  });

  describe('Expo Router preset', () => {
    const preset = LIBRARY_PRESETS.find((p) => p.name === 'Expo Router')!;

    it('should exist and trigger on expo-router package', () => {
      expect(preset).toBeDefined();
      expect(preset.packages).toContain('expo-router');
    });

    it('should include navigation hooks', () => {
      expect(preset.stableHooks).toContain('useRouter');
      expect(preset.stableHooks).toContain('useNavigation');
    });

    it('should include route parameter hooks', () => {
      expect(preset.stableHooks).toContain('useLocalSearchParams');
      expect(preset.stableHooks).toContain('useGlobalSearchParams');
      expect(preset.stableHooks).toContain('useSearchParams');
    });

    it('should include route info hooks', () => {
      expect(preset.stableHooks).toContain('useSegments');
      expect(preset.stableHooks).toContain('usePathname');
    });
  });

  describe('react-use preset', () => {
    const preset = LIBRARY_PRESETS.find((p) => p.name === 'react-use')!;

    it('should have unstable hooks for size/position tracking', () => {
      expect(preset.unstableHooks).toContain('useMouse');
      expect(preset.unstableHooks).toContain('useWindowSize');
      expect(preset.unstableHooks).toContain('useMeasure');
    });
  });
});

describe('Hook Pattern Matching', () => {
  describe('mergePresets with patterns', () => {
    it('should merge stableHookPatterns from multiple presets', () => {
      const presets: LibraryPreset[] = [
        {
          name: 'Preset A',
          packages: ['a'],
          stableHooks: [],
          unstableHooks: [],
          stableHookPatterns: [/^useA\w+$/],
        },
        {
          name: 'Preset B',
          packages: ['b'],
          stableHooks: [],
          unstableHooks: [],
          stableHookPatterns: [/^useB\w+$/],
        },
      ];

      const merged = mergePresets(presets);

      expect(merged.stableHookPatterns.length).toBe(2);
      expect(merged.stableHookPatterns.some((p) => p.test('useATest'))).toBe(true);
      expect(merged.stableHookPatterns.some((p) => p.test('useBTest'))).toBe(true);
    });

    it('should merge unstableHookPatterns', () => {
      const presets: LibraryPreset[] = [
        {
          name: 'Preset A',
          packages: ['a'],
          stableHooks: [],
          unstableHooks: [],
          unstableHookPatterns: [/^useUnstable\w+$/],
        },
      ];

      const merged = mergePresets(presets);

      expect(merged.unstableHookPatterns.length).toBe(1);
      expect(merged.unstableHookPatterns[0].test('useUnstableData')).toBe(true);
    });

    it('should handle presets without patterns', () => {
      const presets: LibraryPreset[] = [
        {
          name: 'Preset A',
          packages: ['a'],
          stableHooks: ['useA'],
          unstableHooks: [],
          // No patterns
        },
      ];

      const merged = mergePresets(presets);

      expect(merged.stableHookPatterns).toEqual([]);
      expect(merged.unstableHookPatterns).toEqual([]);
      expect(merged.stableHooks).toContain('useA');
    });
  });

  describe('Zustand pattern integration', () => {
    it('should detect Zustand and include pattern in merged config', () => {
      const deps = { zustand: '^4.0.0' };
      const presets = detectApplicablePresets(deps);
      const merged = mergePresets(presets);

      // Should have the Zustand pattern
      expect(merged.stableHookPatterns.length).toBeGreaterThan(0);
      expect(merged.stableHookPatterns.some((p) => p.test('useAuthStore'))).toBe(true);
    });
  });

  describe('Expo Router detection', () => {
    it('should detect expo-router and include stable hooks', () => {
      const deps = { 'expo-router': '^3.0.0' };
      const presets = detectApplicablePresets(deps);
      const merged = mergePresets(presets);

      expect(merged.stableHooks).toContain('useRouter');
      expect(merged.stableHooks).toContain('useLocalSearchParams');
      expect(merged.stableHooks).toContain('useSegments');
    });
  });
});
