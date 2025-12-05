import { loadConfig, severityLevel, confidenceLevel, DEFAULT_CONFIG } from '../src/config';
import * as path from 'path';
import * as fs from 'fs';

describe('Config', () => {
  const fixturesPath = path.join(__dirname, 'fixtures');
  const configFixturePath = path.join(fixturesPath, 'config-test');

  beforeAll(() => {
    // Create config test fixture directory
    if (!fs.existsSync(configFixturePath)) {
      fs.mkdirSync(configFixturePath, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up config files
    const configFiles = ['rld.config.json', '.rldrc.json', 'rld.config.js'];
    for (const file of configFiles) {
      const filePath = path.join(configFixturePath, file);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    if (fs.existsSync(configFixturePath)) {
      fs.rmdirSync(configFixturePath);
    }
  });

  describe('loadConfig', () => {
    it('should return default config when no config file exists', () => {
      const config = loadConfig('/tmp/non-existent-path');
      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it('should load JSON config file', () => {
      const configPath = path.join(configFixturePath, 'rld.config.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          stableHooks: ['useCustomHook'],
          minSeverity: 'medium',
        })
      );

      const config = loadConfig(configFixturePath);

      expect(config.stableHooks).toContain('useCustomHook');
      expect(config.minSeverity).toBe('medium');
      // Should still have defaults for unspecified options
      expect(config.includePotentialIssues).toBe(true);

      fs.unlinkSync(configPath);
    });

    it('should load .rldrc.json config file', () => {
      const configPath = path.join(configFixturePath, '.rldrc.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          unstableHooks: ['useUnstableThing'],
          includePotentialIssues: false,
        })
      );

      const config = loadConfig(configFixturePath);

      expect(config.unstableHooks).toContain('useUnstableThing');
      expect(config.includePotentialIssues).toBe(false);

      fs.unlinkSync(configPath);
    });

    it('should merge arrays from config with defaults', () => {
      const configPath = path.join(configFixturePath, 'rld.config.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          ignore: ['custom-ignore-pattern'],
        })
      );

      const config = loadConfig(configFixturePath);

      expect(config.ignore).toContain('custom-ignore-pattern');

      fs.unlinkSync(configPath);
    });

    it('should handle invalid config gracefully', () => {
      const configPath = path.join(configFixturePath, 'rld.config.json');
      fs.writeFileSync(configPath, 'invalid json {{{');

      // Should not throw, should return default config
      const config = loadConfig(configFixturePath);
      expect(config).toEqual(DEFAULT_CONFIG);

      fs.unlinkSync(configPath);
    });
  });

  describe('severityLevel', () => {
    it('should return correct numeric values', () => {
      expect(severityLevel('high')).toBe(3);
      expect(severityLevel('medium')).toBe(2);
      expect(severityLevel('low')).toBe(1);
    });

    it('should allow comparison', () => {
      expect(severityLevel('high')).toBeGreaterThan(severityLevel('medium'));
      expect(severityLevel('medium')).toBeGreaterThan(severityLevel('low'));
    });
  });

  describe('confidenceLevel', () => {
    it('should return correct numeric values', () => {
      expect(confidenceLevel('high')).toBe(3);
      expect(confidenceLevel('medium')).toBe(2);
      expect(confidenceLevel('low')).toBe(1);
    });

    it('should allow comparison', () => {
      expect(confidenceLevel('high')).toBeGreaterThan(confidenceLevel('medium'));
      expect(confidenceLevel('medium')).toBeGreaterThan(confidenceLevel('low'));
    });
  });

  describe('customFunctions config', () => {
    it('should merge custom functions', () => {
      const configPath = path.join(configFixturePath, 'rld.config.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          customFunctions: {
            myStableFunction: { stable: true },
            myDeferredFunction: { deferred: true },
          },
        })
      );

      const config = loadConfig(configFixturePath);

      expect(config.customFunctions.myStableFunction).toEqual({ stable: true });
      expect(config.customFunctions.myDeferredFunction).toEqual({ deferred: true });

      fs.unlinkSync(configPath);
    });
  });
});
