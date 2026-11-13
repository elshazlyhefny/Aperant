/**
 * zeenha fork: the changelog generator must never put user-controlled text
 * (commit subjects, authors) on a command line or run it through a shell.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { ChangelogGenerationRequest } from '../../../shared/types';

const mockWindows = vi.hoisted(() => ({ value: false }));

const hostileCommits = vi.hoisted(() => [
  { hash: 'abc1234', fullHash: 'abc1234'.padEnd(40, '0'), subject: 'fix" & echo pwned & "', author: 'a" | calc', authorEmail: 'a@b.c', date: '2025-01-01T00:00:00Z' },
  { hash: 'def5678', fullHash: 'def5678'.padEnd(40, '0'), subject: '%PATH%', author: 'a" | calc', authorEmail: 'a@b.c', date: '2025-01-02T00:00:00Z' }
]);

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
  isWindows: vi.fn(() => mockWindows.value)
}));

vi.mock('../../rate-limit-detector', () => ({
  detectRateLimit: vi.fn(() => ({ isRateLimited: false })),
  createSDKRateLimitInfo: vi.fn(),
  getBestAvailableProfileEnv: vi.fn(() => ({ env: {}, wasSwapped: false, profileName: 'default' }))
}));

vi.mock('../git-integration', () => ({
  getCommits: vi.fn(() => hostileCommits),
  getBranchDiffCommits: vi.fn(() => [])
}));

const request: ChangelogGenerationRequest = {
  projectId: 'p',
  sourceMode: 'git-history',
  gitHistory: { type: 'recent', count: 2 },
  version: '1.0.0',
  date: '2025-01-03T00:00:00Z',
  format: 'keep-a-changelog',
  audience: 'technical'
} as ChangelogGenerationRequest;

describe('ChangelogGenerator - command injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentChild = makeChild();
    mockWindows.value = false;
  });

  async function run(claudePath: string) {
    const { ChangelogGenerator } = await import('../generator');
    const { buildGitPrompt } = await import('../formatter');
    const generator = new ChangelogGenerator('', claudePath, '/tmp/auto-build', {}, false);
    await generator.generate('p', '/tmp/project', request);
    const expectedPrompt = buildGitPrompt(request, hostileCommits as any);
    generator.cancel('p');
    return expectedPrompt;
  }

  function assertSafe(expectedPrompt: string) {
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [file, args, options] = mockSpawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(options.shell).not.toBe(true);
    expect(file).not.toMatch(/python/i);
    for (const arg of [file, ...args]) {
      expect(arg).not.toContain('pwned');
      expect(arg).not.toContain('%PATH%');
      expect(arg).not.toContain('calc');
    }
    expect(currentChild.stdin.write).toHaveBeenCalledWith(expectedPrompt, 'utf-8');
    expect(currentChild.stdin.end).toHaveBeenCalled();
  }

  it('passes hostile commit text only via stdin with a POSIX claude path', async () => {
    const prompt = await run('/usr/local/bin/claude');
    assertSafe(prompt);
    expect(mockSpawn.mock.calls[0][0]).toBe('/usr/local/bin/claude');
  });

  it('passes hostile commit text only via stdin with a Windows claude.cmd path', async () => {
    mockWindows.value = true;
    const prompt = await run('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd');
    assertSafe(prompt);
    expect(mockSpawn.mock.calls[0][0]).toMatch(/cmd\.exe$/i);
  });
});
