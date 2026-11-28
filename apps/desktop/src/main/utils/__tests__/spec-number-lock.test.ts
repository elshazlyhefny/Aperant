import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
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

  describe('hooks (zeenha fork)', () => {
    const lockFile = () => path.join(root, '.auto-claude', '.locks', 'spec-numbering.lock');
    const specs = () => {
      const dir = path.join(root, '.auto-claude', 'specs');
      return existsSync(dir) ? readdirSync(dir).sort() : [];
    };

    it('allocates nothing when beforeAllocate returns skip, and runs it under the lock', async () => {
      let heldDuringCheck = false;
      const result = await allocateSpecDir({ path: root }, 'dup', {
        beforeAllocate: () => {
          heldDuringCheck = existsSync(lockFile());
          return { skip: 'existing-id' };
        },
        afterCreate: () => {
          throw new Error('must not run');
        },
      });
      expect(result).toEqual({ skipped: 'existing-id' });
      expect(heldDuringCheck).toBe(true);
      expect(specs()).toEqual([]);
      expect(existsSync(lockFile())).toBe(false);
    });

    it('allocates as usual when beforeAllocate returns undefined and returns the afterCreate result', async () => {
      let heldDuringWrite = false;
      const result = await allocateSpecDir({ path: root }, 'new one', {
        beforeAllocate: () => undefined,
        afterCreate: ({ specId, specDir }) => {
          heldDuringWrite = existsSync(lockFile());
          writeFileSync(path.join(specDir, 'marker.json'), '{}');
          return `made ${specId}`;
        },
      });
      expect(result).toEqual({
        specId: '001-new-one',
        specDir: path.join(root, '.auto-claude', 'specs', '001-new-one'),
        created: 'made 001-new-one',
      });
      expect(heldDuringWrite).toBe(true);
      expect(existsSync(path.join(root, '.auto-claude', 'specs', '001-new-one', 'marker.json'))).toBe(true);
    });

    it('reads a title function after beforeAllocate', async () => {
      let title = '';
      const result = await allocateSpecDir({ path: root }, () => title, {
        beforeAllocate: () => {
          title = 'Learned Under Lock';
          return undefined;
        },
      });
      expect('specId' in result && result.specId).toBe('001-learned-under-lock');
    });

    it('propagates a beforeAllocate throw without creating a dir, and releases the lock', async () => {
      await expect(
        allocateSpecDir({ path: root }, 'x', {
          beforeAllocate: () => {
            throw new Error('not found');
          },
        })
      ).rejects.toThrow('not found');
      expect(specs()).toEqual([]);
      expect(existsSync(lockFile())).toBe(false);
    });

    it('serializes check-then-create: concurrent imports of one item create one spec', async () => {
      const created: string[] = [];
      const importOnce = () =>
        allocateSpecDir<string, string>({ path: root }, 'item', {
          beforeAllocate: () => (created.length > 0 ? { skip: created[0] } : undefined),
          afterCreate: async ({ specId }) => {
            await new Promise((r) => setTimeout(r, 5));
            created.push(specId);
            return specId;
          },
        });
      const results = await Promise.all([importOnce(), importOnce(), importOnce()]);
      expect(specs()).toEqual(['001-item']);
      expect(results.filter((r) => 'skipped' in r)).toHaveLength(2);
    });
  });
});
