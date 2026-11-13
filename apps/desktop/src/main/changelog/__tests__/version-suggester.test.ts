/**
 * zeenha fork: the version suggester must never put commit subjects on a
 * command line or run them through a shell.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

function makeChild() {
  const child = new EventEmitter() as any;
  child.pid = 1;
  child.kill = vi.fn();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  return child;
}

let currentChild = makeChild();
const mockSpawn = vi.fn((..._args: unknown[]) => currentChild);

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: mockSpawn };
});

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/test-userdata'),
    getAppPath: vi.fn(() => '/tmp'),
    getVersion: vi.fn(() => '0.1.0'),
    isPackaged: false
  }
}));

vi.mock('../../env-utils', () => ({
  getAugmentedEnv: vi.fn(() => ({ PATH: '/usr/bin' }))
}));

vi.mock('../../platform', () => ({
  isWindows: vi.fn(() => false)
}));

vi.mock('../../rate-limit-detector', () => ({
  getBestAvailableProfileEnv: vi.fn(() => ({ env: {}, wasSwapped: false, profileName: 'default' }))
}));

const commits = [
  { hash: 'abc1234', fullHash: 'abc1234'.padEnd(40, '0'), subject: 'fix" & echo pwned & "', author: 'a', authorEmail: 'a@b.c', date: '2025-01-01T00:00:00Z' },
  { hash: 'def5678', fullHash: 'def5678'.padEnd(40, '0'), subject: '%PATH%', author: 'a', authorEmail: 'a@b.c', date: '2025-01-02T00:00:00Z' }
] as any[];

async function makeSuggester() {
  const { VersionSuggester } = await import('../version-suggester');
  return new VersionSuggester('', '/usr/local/bin/claude', '/tmp/auto-build', false);
}

describe('VersionSuggester - command injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentChild = makeChild();
  });

  it('delivers hostile commit subjects on stdin only, without a shell', async () => {
    const suggester = await makeSuggester();
    const promise = suggester.suggestVersionBump(commits, '1.2.3');
    currentChild.stdout.emit('data', Buffer.from('{"bumpType":"minor","reason":"feature"}'));
    currentChild.emit('exit', 0);
    await promise;

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [file, args, options] = mockSpawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(options.shell).not.toBe(true);
    expect(file).not.toMatch(/python/i);
    for (const arg of [file, ...args]) {
      expect(arg).not.toContain('pwned');
      expect(arg).not.toContain('%PATH%');
    }
    const written = currentChild.stdin.write.mock.calls[0][0] as string;
    expect(written).toContain('fix" & echo pwned & "');
    expect(written).toContain('%PATH%');
    expect(currentChild.stdin.end).toHaveBeenCalled();
  });

  it('resolves to the parsed bump from a JSON response', async () => {
    const suggester = await makeSuggester();
    const promise = suggester.suggestVersionBump(commits, '1.2.3');
    currentChild.stdout.emit('data', Buffer.from('{"bumpType":"minor","reason":"feature"}'));
    currentChild.emit('exit', 0);
    await expect(promise).resolves.toEqual({ version: '1.3.0', reason: 'feature', bumpType: 'minor' });
  });

  it('falls back to a patch bump on spawn error', async () => {
    const suggester = await makeSuggester();
    const promise = suggester.suggestVersionBump(commits, '1.2.3');
    currentChild.emit('error', new Error('ENOENT'));
    await expect(promise).resolves.toMatchObject({ version: '1.2.4', bumpType: 'patch' });
  });

  it('falls back to a patch bump on non-zero exit', async () => {
    const suggester = await makeSuggester();
    const promise = suggester.suggestVersionBump(commits, '1.2.3');
    currentChild.emit('exit', 1);
    await expect(promise).resolves.toMatchObject({ version: '1.2.4', bumpType: 'patch' });
  });
});
