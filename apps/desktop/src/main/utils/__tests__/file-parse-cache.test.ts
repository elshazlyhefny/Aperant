import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileParseCache } from '../file-parse-cache';

const OLD = new Date(Date.now() - 60_000);

describe('FileParseCache', () => {
  let dir: string;
  let cache: FileParseCache;

  const write = (name: string, content: string, mtime: Date | null = OLD): string => {
    const p = path.join(dir, name);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
    if (mtime) utimesSync(p, mtime, mtime);
    return p;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'fpc-'));
    cache = new FileParseCache();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('hits when unchanged', () => {
    const p = write('a.json', '{"a":1}');
    expect(cache.read(p, JSON.parse)).toEqual({ a: 1 });
    expect(cache.read(p, JSON.parse)).toEqual({ a: 1 });
    expect(cache.stats).toEqual({ hits: 1, misses: 1 });
  });

  it('re-reads when size changes', () => {
    const p = write('a.json', '{"a":1}');
    cache.read(p, JSON.parse);
    write('a.json', '{"a":12}');
    expect(cache.read(p, JSON.parse)).toEqual({ a: 12 });
    expect(cache.stats.misses).toBe(2);
  });

  it('re-reads when mtime changes', () => {
    const p = write('a.json', '{"a":1}');
    cache.read(p, JSON.parse);
    write('a.json', '{"a":2}', new Date(OLD.getTime() + 5000));
    expect(cache.read(p, JSON.parse)).toEqual({ a: 2 });
    expect(cache.stats.misses).toBe(2);
  });

  it('returns undefined for a missing file', () => {
    expect(cache.read(path.join(dir, 'nope.json'), JSON.parse)).toBeUndefined();
  });

  it('caches a parse failure value', () => {
    const p = write('a.json', 'garbage');
    expect(cache.read(p, () => null)).toBeNull();
    expect(cache.read(p, () => null)).toBeNull();
    expect(cache.stats).toEqual({ hits: 1, misses: 1 });
  });

  it('does not cache a throwing parse', () => {
    const p = write('a.json', 'garbage');
    expect(() => cache.read(p, JSON.parse)).toThrow();
    expect(() => cache.read(p, JSON.parse)).toThrow();
    expect(cache.stats.hits).toBe(0);
    expect(cache.stats.misses).toBe(2);
  });

  it('does not cache a just-written file (racy-write guard)', () => {
    const p = write('a.json', '{"a":1}', null);
    cache.read(p, JSON.parse);
    cache.read(p, JSON.parse);
    expect(cache.stats).toEqual({ hits: 0, misses: 2 });
  });

  it('retainOnly drops entries under scope not kept', () => {
    const a = write('specs/a/x.json', '1');
    const b = write('specs/b/x.json', '2');
    const other = write('other/x.json', '3');
    for (const p of [a, b, other]) cache.read(p, JSON.parse);
    cache.retainOnly(path.join(dir, 'specs'), new Set([a]));
    cache.stats.hits = 0;
    cache.read(a, JSON.parse);
    cache.read(b, JSON.parse);
    cache.read(other, JSON.parse);
    expect(cache.stats.hits).toBe(2);
  });

  it('evictScope is prefix safe', () => {
    const a = write('specs/x.json', '1');
    const old = write('specs-old/x.json', '2');
    cache.read(a, JSON.parse);
    cache.read(old, JSON.parse);
    cache.evictScope(path.join(dir, 'specs'));
    cache.stats.hits = 0;
    cache.read(a, JSON.parse);
    cache.read(old, JSON.parse);
    expect(cache.stats.hits).toBe(1);
  });

  it('invalidate forces a re-read', () => {
    const p = write('a.json', '1');
    cache.read(p, JSON.parse);
    cache.invalidate(p);
    cache.read(p, JSON.parse);
    expect(cache.stats.misses).toBe(2);
  });
});
