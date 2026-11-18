import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allocateSpecDir } from '../spec-number-lock';

describe('allocateSpecDir', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'spec-lock-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('gives concurrent callers distinct, consecutive ids and existing dirs', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => allocateSpecDir({ path: root }, `task ${i}`))
    );
    const ids = results.map((r) => r.specId);
    expect(new Set(ids).size).toBe(5);
    expect(new Set(results.map((r) => r.specDir)).size).toBe(5);
    for (const r of results) expect(existsSync(r.specDir)).toBe(true);
    const nums = ids.map((id) => parseInt(id.split('-')[0], 10)).sort((a, b) => a - b);
    expect(nums).toEqual([1, 2, 3, 4, 5]);
  });

  it('counts specs that only exist in a task worktree', async () => {
    mkdirSync(
      path.join(root, '.auto-claude', 'worktrees', 'tasks', 'foo', '.auto-claude', 'specs', '007-x'),
      { recursive: true }
    );
    const { specId } = await allocateSpecDir({ path: root }, 'next thing');
    expect(specId).toMatch(/^008-/);
  });

  it('starts at 001 when there is no specs dir', async () => {
    const { specId, specDir } = await allocateSpecDir({ path: root }, 'first');
    expect(specId).toBe('001-first');
    expect(existsSync(specDir)).toBe(true);
  });

  it('handles four-digit spec numbers', async () => {
    mkdirSync(path.join(root, '.auto-claude', 'specs', '1000-foo'), { recursive: true });
    const { specId } = await allocateSpecDir({ path: root }, 'bar');
    expect(specId).toBe('1001-bar');
  });

  it('releases the lock file afterwards', async () => {
    await allocateSpecDir({ path: root }, 'one');
    expect(existsSync(path.join(root, '.auto-claude', '.locks', 'spec-numbering.lock'))).toBe(false);
    const { specId } = await allocateSpecDir({ path: root }, 'two');
    expect(specId).toBe('002-two');
  });
});
