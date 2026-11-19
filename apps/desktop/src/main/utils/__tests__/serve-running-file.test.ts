import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getServeRunningPath, readServeRunningTaskIds } from '../serve-running-file';

describe('serve-running-file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'serve-running-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (content: string) => {
    const file = getServeRunningPath(dir);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };

  it('reads the task ids of a valid file', () => {
    write(JSON.stringify({ taskIds: ['001-a', '002-b'] }));
    expect(readServeRunningTaskIds(dir)).toEqual(['001-a', '002-b']);
  });

  it('returns [] when the file is missing', () => {
    expect(readServeRunningTaskIds(dir)).toEqual([]);
  });

  it('returns [] for corrupt JSON', () => {
    write('{not json');
    expect(readServeRunningTaskIds(dir)).toEqual([]);
  });

  it('returns [] when taskIds is not an array', () => {
    write(JSON.stringify({ taskIds: 'x' }));
    expect(readServeRunningTaskIds(dir)).toEqual([]);
  });

  it('keeps only string entries', () => {
    write(JSON.stringify({ taskIds: ['a', 1, null, 'b', {}] }));
    expect(readServeRunningTaskIds(dir)).toEqual(['a', 'b']);
  });
});
