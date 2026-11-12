import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../plan-file-utils', () => ({
  persistPlanStatus: vi.fn(),
  updateTaskMetadataPrUrl: vi.fn(),
}));

import {
  buildCreatePRArgs,
  isValidHttpsUrl,
  originMatchesInstance,
  parsePRJsonOutput,
  withRetry,
} from '../worktree-pr';

describe('originMatchesInstance', () => {
  const gl = 'https://gitlab.com';
  it('matches scp-style ssh', () => {
    expect(originMatchesInstance('git@gitlab.com:group/repo.git', gl)).toBe(true);
  });
  it('matches ssh:// with a port', () => {
    expect(originMatchesInstance('ssh://git@gitlab.com:2222/group/repo.git', gl)).toBe(true);
  });
  it('matches https with .git', () => {
    expect(originMatchesInstance('https://gitlab.com/group/repo.git', gl)).toBe(true);
  });
  it('rejects a different host', () => {
    expect(originMatchesInstance('git@github.com:o/r.git', gl)).toBe(false);
    expect(originMatchesInstance('https://github.com/o/r.git', gl)).toBe(false);
  });
  it('matches a self-hosted instance with a port in its URL', () => {
    expect(originMatchesInstance('git@git.corp.example.com:team/app.git', 'https://git.corp.example.com:8443')).toBe(true);
  });
  it('compares hosts case-insensitively', () => {
    expect(originMatchesInstance('git@GitLab.COM:g/r.git', gl)).toBe(true);
    expect(originMatchesInstance('https://gitlab.com/g/r.git', 'https://GITLAB.com')).toBe(true);
  });
  it('rejects garbage', () => {
    expect(originMatchesInstance('', gl)).toBe(false);
    expect(originMatchesInstance('git@gitlab.com:g/r.git', 'not a url')).toBe(false);
  });
});

describe('isValidHttpsUrl', () => {
  it('accepts https github.com URLs', () => {
    expect(isValidHttpsUrl('https://github.com/o/r/pull/1')).toBe(true);
  });
  it('accepts GitHub Enterprise hosts', () => {
    expect(isValidHttpsUrl('https://git.corp.example.com/o/r/pull/1')).toBe(true);
  });
  it('rejects http', () => {
    expect(isValidHttpsUrl('http://github.com/o/r/pull/1')).toBe(false);
  });
  it('rejects garbage', () => {
    expect(isValidHttpsUrl('not a url')).toBe(false);
    expect(isValidHttpsUrl('')).toBe(false);
  });
});

describe('parsePRJsonOutput', () => {
  it('parses snake_case fields', () => {
    const out = '{"success": true, "pr_url": "https://github.com/o/r/pull/1", "already_exists": true}';
    expect(parsePRJsonOutput(out)).toEqual({
      success: true,
      prUrl: 'https://github.com/o/r/pull/1',
      alreadyExists: true,
      error: undefined,
    });
  });
  it('parses camelCase fields', () => {
    const out = '{"success": false, "prUrl": "https://github.com/o/r/pull/2", "alreadyExists": false, "error": "boom"}';
    expect(parsePRJsonOutput(out)).toEqual({
      success: false,
      prUrl: 'https://github.com/o/r/pull/2',
      alreadyExists: false,
      error: 'boom',
    });
  });
  it('takes the last JSON object', () => {
    const out = 'log {"success": false, "error": "first"} more\n{"success": true}';
    expect(parsePRJsonOutput(out)?.success).toBe(true);
    expect(parsePRJsonOutput(out)?.error).toBeUndefined();
  });
  it('drops an invalid pr_url', () => {
    const result = parsePRJsonOutput('{"success": true, "pr_url": "http://insecure/x"}');
    expect(result?.prUrl).toBeUndefined();
  });
  it('returns null when there is no JSON', () => {
    expect(parsePRJsonOutput('no json here')).toBeNull();
  });
  it('defaults success to false when missing', () => {
    expect(parsePRJsonOutput('{"pr_url": "https://github.com/o/r/pull/1"}')?.success).toBe(false);
  });
});

describe('buildCreatePRArgs', () => {
  it('builds the base args', () => {
    expect(buildCreatePRArgs('run.py', '001-x', '/proj', undefined, undefined)).toEqual({
      args: ['run.py', '--spec', '001-x', '--project-dir', '/proj', '--create-pr'],
    });
  });
  it('rejects an invalid target branch', () => {
    const r = buildCreatePRArgs('run.py', 's', '/p', { targetBranch: 'bad branch;x' }, undefined);
    expect(r.args).toEqual([]);
    expect(r.validationError).toBe('Invalid target branch name');
  });
  it('rejects a title over 256 characters', () => {
    const r = buildCreatePRArgs('run.py', 's', '/p', { title: 'a'.repeat(257) }, undefined);
    expect(r.args).toEqual([]);
    expect(r.validationError).toContain('256');
  });
  it('rejects a title with non-printable characters', () => {
    const r = buildCreatePRArgs('run.py', 's', '/p', { title: 'bad\u0000title' }, undefined);
    expect(r.validationError).toBe('PR title contains invalid characters');
  });
  it('adds target, title, draft and base branch', () => {
    const r = buildCreatePRArgs(
      'run.py', 's', '/p',
      { targetBranch: 'main', title: 'My PR', draft: true },
      'develop'
    );
    expect(r.validationError).toBeUndefined();
    expect(r.args).toEqual(expect.arrayContaining(['--pr-target', 'main', '--pr-title', 'My PR', '--pr-draft', '--base-branch', 'develop']));
  });
  it('omits --pr-draft without draft', () => {
    expect(buildCreatePRArgs('run.py', 's', '/p', { draft: false }, undefined).args).not.toContain('--pr-draft');
  });
});

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries then succeeds', async () => {
    const op = vi.fn().mockRejectedValueOnce(new Error('a')).mockResolvedValue('ok');
    const onRetry = vi.fn();
    const p = withRetry(op, { maxRetries: 3, baseDelayMs: 10, onRetry });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('stops when shouldRetry is false', async () => {
    const err = new Error('fatal');
    const op = vi.fn().mockRejectedValue(err);
    await expect(withRetry(op, { maxRetries: 5, shouldRetry: () => false })).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('throws after maxRetries', async () => {
    const op = vi.fn().mockRejectedValue(new Error('nope'));
    const p = withRetry(op, { maxRetries: 3, baseDelayMs: 10 });
    const assertion = expect(p).rejects.toThrow('nope');
    await vi.runAllTimersAsync();
    await assertion;
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('clamps maxRetries to at least 1', async () => {
    const op = vi.fn().mockRejectedValue(new Error('x'));
    await expect(withRetry(op, { maxRetries: 0 })).rejects.toThrow('x');
    expect(op).toHaveBeenCalledTimes(1);
  });
});
