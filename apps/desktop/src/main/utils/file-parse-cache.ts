/**
 * zeenha fork: cache of parsed file contents keyed by absolute path and
 * validated by mtimeMs + size, so repeated scans reuse unchanged spec files
 * instead of re-reading and re-parsing them.
 */
import { readFileSync, statSync } from 'fs';
import path from 'path';

interface CacheEntry {
  mtimeMs: number;
  size: number;
  value: unknown;
}

/**
 * Files modified within this window are never cached: two writes in the same
 * mtime tick with an unchanged size would otherwise be served stale. Files
 * being actively written by a running task are simply re-read.
 */
const RACY_WINDOW_MS = 2000;

/**
 * Parsed-file cache. Returned values are SHARED between callers and MUST be
 * treated as read-only; clone before mutating.
 */
export class FileParseCache {
  private readonly entries = new Map<string, CacheEntry>();
  readonly stats = { hits: 0, misses: 0 };

  /**
   * Returns the parsed contents of filePath, or undefined if it does not exist.
   * Other fs errors propagate. A parse failure value (e.g. null) is cached; a
   * parse that throws is not cached and the error is rethrown.
   */
  read<T>(filePath: string, parse: (raw: string) => T): T | undefined {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.entries.delete(filePath);
        return undefined;
      }
      throw error;
    }

    const cached = this.entries.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      this.stats.hits++;
      return cached.value as T;
    }

    this.stats.misses++;
    const value = parse(readFileSync(filePath, 'utf-8'));
    if (Date.now() - st.mtimeMs > RACY_WINDOW_MS) {
      this.entries.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, value });
    } else {
      this.entries.delete(filePath);
    }
    return value;
  }

  invalidate(filePath: string): void {
    this.entries.delete(filePath);
  }

  /** Drops entries under scopeDir that are not in keptPaths. */
  retainOnly(scopeDir: string, keptPaths: Set<string>): void {
    for (const key of [...this.entries.keys()]) {
      if (this.isUnder(scopeDir, key) && !keptPaths.has(key)) this.entries.delete(key);
    }
  }

  /** Drops every entry under scopeDir. */
  evictScope(scopeDir: string): void {
    for (const key of [...this.entries.keys()]) {
      if (this.isUnder(scopeDir, key)) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  private isUnder(scopeDir: string, filePath: string): boolean {
    const prefix = scopeDir.endsWith(path.sep) ? scopeDir : scopeDir + path.sep;
    return filePath.startsWith(prefix);
  }
}
