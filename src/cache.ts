import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { HookInfo, ExportInfo } from './parser';

/**
 * Serializable import info for caching (ImportInfo has a Map which isn't JSON-serializable)
 */
export interface CacheableImportInfo {
  source: string;
  imports: string[];
  /** importedNames as array of [localName, importedName] tuples */
  importedNames: [string, string][];
  isDefaultImport: boolean;
  isNamespaceImport: boolean;
  line: number;
}

/**
 * Serializable subset of ParsedFile for caching
 * Note: AST and Map<> are not cached since they're not JSON-serializable
 */
export interface CacheableParsedData {
  hooks: HookInfo[];
  imports: CacheableImportInfo[];
  exports: ExportInfo[];
  functions: string[];
  contexts: string[];
  localMemoizedComponents: string[];
  /** Variables stored as array of [key, values[]] tuples for JSON serialization */
  variables: [string, string[]][];
}

/**
 * Cache entry for a parsed file
 */
interface CacheEntry {
  /** Hash of the file content when it was parsed */
  contentHash: string;
  /** Modification time of the file when it was cached */
  mtime: number;
  /** The cached data (serializable) */
  data: CacheableParsedData;
}

/**
 * Cache file structure
 */
interface CacheFile {
  version: string;
  entries: Record<string, CacheEntry>;
}

const CACHE_VERSION = '1.0.0';
const CACHE_DIR = 'node_modules/.cache/rld';
const CACHE_FILE = 'ast-cache.json';

/**
 * AST Cache for storing parsed file data to speed up repeated runs
 */
export class AstCache {
  private cache: Map<string, CacheEntry> = new Map();
  private cacheDir: string;
  private cacheFile: string;
  private dirty = false;

  constructor(projectRoot: string) {
    this.cacheDir = path.join(projectRoot, CACHE_DIR);
    this.cacheFile = path.join(this.cacheDir, CACHE_FILE);
    this.load();
  }

  /**
   * Get cached data for a file if it's still valid
   */
  get(filePath: string): CacheableParsedData | null {
    const entry = this.cache.get(filePath);
    if (!entry) {
      return null;
    }

    try {
      const stats = fs.statSync(filePath);
      const mtime = stats.mtimeMs;

      // Fast path: check if mtime matches
      if (entry.mtime === mtime) {
        return entry.data;
      }

      // Slow path: mtime changed, check content hash
      const content = fs.readFileSync(filePath, 'utf-8');
      const contentHash = this.hashContent(content);

      if (entry.contentHash === contentHash) {
        // Content hasn't actually changed, update mtime and return cached data
        entry.mtime = mtime;
        this.dirty = true;
        return entry.data;
      }

      // Content changed, invalidate cache
      this.cache.delete(filePath);
      this.dirty = true;
      return null;
    } catch {
      // File doesn't exist or can't be read
      this.cache.delete(filePath);
      this.dirty = true;
      return null;
    }
  }

  /**
   * Store data for a file
   */
  set(filePath: string, data: CacheableParsedData): void {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const stats = fs.statSync(filePath);

      const entry: CacheEntry = {
        contentHash: this.hashContent(content),
        mtime: stats.mtimeMs,
        data,
      };

      this.cache.set(filePath, entry);
      this.dirty = true;
    } catch {
      // Can't cache if we can't read the file
    }
  }

  /**
   * Save cache to disk
   */
  save(): void {
    if (!this.dirty) {
      return;
    }

    try {
      // Ensure cache directory exists
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }

      const cacheFile: CacheFile = {
        version: CACHE_VERSION,
        entries: Object.fromEntries(this.cache),
      };

      fs.writeFileSync(this.cacheFile, JSON.stringify(cacheFile), 'utf-8');
      this.dirty = false;
    } catch {
      // Silently fail - caching is an optimization, not required
    }
  }

  /**
   * Load cache from disk
   */
  private load(): void {
    try {
      if (!fs.existsSync(this.cacheFile)) {
        return;
      }

      const content = fs.readFileSync(this.cacheFile, 'utf-8');
      const cacheFile: CacheFile = JSON.parse(content);

      // Invalidate cache if version changed
      if (cacheFile.version !== CACHE_VERSION) {
        return;
      }

      this.cache = new Map(Object.entries(cacheFile.entries));
    } catch {
      // Silently fail - we'll rebuild the cache
    }
  }

  /**
   * Clear all cached data
   */
  clear(): void {
    this.cache.clear();
    this.dirty = true;

    try {
      if (fs.existsSync(this.cacheFile)) {
        fs.unlinkSync(this.cacheFile);
      }
    } catch {
      // Silently fail
    }
  }

  /**
   * Get the number of cached entries
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Hash file content for comparison
   */
  private hashContent(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
  }
}
