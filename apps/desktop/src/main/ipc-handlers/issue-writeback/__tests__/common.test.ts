import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildOutcomeComment, cleanTitle, readMetadata } from '../common';

describe('readMetadata', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'wb-common-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads valid metadata', () => {
    writeFileSync(path.join(root, 'task_metadata.json'), JSON.stringify({ sourceType: 'github' }));
    expect(readMetadata([root])).toEqual({ sourceType: 'github' });
  });

  it('skips malformed files and falls through to the next dir', () => {
    const bad = path.join(root, 'bad');
    const good = path.join(root, 'good');
    mkdirSync(bad);
    mkdirSync(good);
    writeFileSync(path.join(bad, 'task_metadata.json'), '{nope');
    writeFileSync(path.join(good, 'task_metadata.json'), JSON.stringify({ a: 1 }));
    expect(readMetadata([bad, good])).toEqual({ a: 1 });
    expect(readMetadata([bad])).toBeNull();
  });

  it('returns null when missing', () => {
    expect(readMetadata([path.join(root, 'nope')])).toBeNull();
  });
});

describe('cleanTitle', () => {
  it('strips control characters', () => {
    expect(cleanTitle('a\u0000b\nc')).toBe('a b c');
  });
  it('truncates to 200 chars', () => {
    const out = cleanTitle('x'.repeat(500));
    expect(out).toHaveLength(200);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('buildOutcomeComment', () => {
  it('drops http PR urls', () => {
    expect(buildOutcomeComment('failed', 'T', 'http://example.com/pr/1')).toBe(
      'Aperant: task failed.\nTask: T'
    );
  });
  it('keeps https PR urls', () => {
    expect(buildOutcomeComment('review_ready', 'T', 'https://github.com/o/r/pull/1')).toBe(
      'Aperant: task is ready for review.\nTask: T\nPull request: https://github.com/o/r/pull/1'
    );
  });
});
