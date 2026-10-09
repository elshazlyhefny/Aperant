/**
 * zeenha fork: Create PR's push and gh calls.
 *
 * - The task branch is pushed with --force-with-lease, so a branch rebased for
 *   the merge queue can be pushed again (a plain push is rejected as a
 *   non-fast-forward).
 * - Nothing but the task's own `auto-claude/*` branch is ever pushed.
 * - Every call is async, bounded by a timeout, and runs with prompts disabled
 *   and the augmented PATH, so a credential prompt cannot freeze the app.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Call {
  command: string;
  args: string[];
  options: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv };
}

type Outcome = { stdout?: string; stderr?: string; error?: { killed?: boolean; message?: string } };

const state = vi.hoisted(() => ({
  calls: [] as Call[],
  respond: (_call: Call): Outcome => ({ stdout: '' }),
}));

vi.mock('node:child_process', () => ({
  execFile: (
    command: string,
    args: string[],
    options: Call['options'],
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const call = { command, args, options };
    state.calls.push(call);
    const outcome = state.respond(call);
    setImmediate(() => {
      if (outcome.error) {
        const err = Object.assign(new Error(outcome.error.message ?? 'Command failed'), {
          killed: outcome.error.killed ?? false,
        });
        callback(err, outcome.stdout ?? '', outcome.stderr ?? '');
      } else {
        callback(null, outcome.stdout ?? '', outcome.stderr ?? '');
      }
    });
    return { stdin: { end: vi.fn() } };
  },
}));

vi.mock('../../../../env-utils', () => ({
  getAugmentedEnv: () => ({ PATH: '/augmented/bin:/usr/bin', HOME: '/home/u' }),
}));
vi.mock('../../../client/factory', () => ({
  createSimpleClient: vi.fn(async () => ({ model: {}, systemPrompt: '' })),
}));
vi.mock('ai', () => ({ generateText: vi.fn(async () => ({ text: '## Summary\n- body' })) }));

import { createPR, GH_TIMEOUT_MS, NO_CHANGES_MESSAGE, PUSH_TIMEOUT_MS } from '../pr-creator';

const PR_URL = 'https://github.com/o/r/pull/7';

function config(overrides: Partial<Parameters<typeof createPR>[0]> = {}) {
  return {
    projectDir: '/proj',
    worktreePath: '/proj/.auto-claude/worktrees/tasks/001-x',
    specId: '001-x',
    branchName: 'auto-claude/001-x',
    baseBranch: 'main',
    title: 'auto-claude: 001-x',
    ghPath: 'gh',
    gitPath: 'git',
    ...overrides,
  };
}

const pushCalls = () => state.calls.filter((c) => c.command === 'git' && c.args[0] === 'push');
const createCalls = () => state.calls.filter((c) => c.command === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create');

beforeEach(() => {
  state.calls = [];
  state.respond = (call) => (call.command === 'gh' && call.args[1] === 'create' ? { stdout: `${PR_URL}\n` } : { stdout: '' });
});

describe('createPR push', () => {
  it('pushes only the task branch, with --force-with-lease and an explicit refspec', async () => {
    const result = await createPR(config());
    expect(result).toEqual({ success: true, prUrl: PR_URL, alreadyExists: false });
    expect(pushCalls()).toHaveLength(1);
    expect(pushCalls()[0].args).toEqual([
      'push',
      '--force-with-lease',
      '--set-upstream',
      'origin',
      'refs/heads/auto-claude/001-x:refs/heads/auto-claude/001-x',
    ]);
    expect(pushCalls()[0].options.cwd).toBe('/proj/.auto-claude/worktrees/tasks/001-x');
    expect(pushCalls()[0].options.timeout).toBe(PUSH_TIMEOUT_MS);
  });

  it.each([
    ['main'],
    ['auto-claude/002-other'],
    ['feature/x'],
    ['auto-claude/../main'],
  ])('refuses %s before running anything', async (branchName) => {
    const result = await createPR(config({ branchName }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Refusing to push');
    expect(state.calls).toHaveLength(0);
  });

  it('reports a rejected push and does not create the PR', async () => {
    state.respond = (call) =>
      call.args[0] === 'push'
        ? { error: { message: 'Command failed' }, stderr: ' ! [rejected] (stale info)' }
        : { stdout: '' };
    const result = await createPR(config());
    expect(result).toEqual({ success: false, error: 'Failed to push branch:  ! [rejected] (stale info)' });
    expect(createCalls()).toHaveLength(0);
  });

  it('turns a push timeout into a clear error', async () => {
    // stderr holds what git printed before it was killed: the timeout message must win.
    state.respond = (call) =>
      call.args[0] === 'push' ? { error: { killed: true }, stderr: "Username for 'https://github.com': " } : { stdout: '' };
    const result = await createPR(config());
    expect(result.success).toBe(false);
    expect(result.error).toContain('git push timed out after 120s');
    expect(result.error).toContain('credentials');
    expect(createCalls()).toHaveLength(0);
  });
});

describe('createPR environment', () => {
  it('runs every git and gh call with prompts disabled and the augmented PATH', async () => {
    await createPR(config());
    expect(state.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of state.calls) {
      expect(call.options.env?.GIT_TERMINAL_PROMPT).toBe('0');
      expect(call.options.env?.GH_PROMPT_DISABLED).toBe('1');
      expect(call.options.env?.PATH).toBe('/augmented/bin:/usr/bin');
      expect(call.options.timeout).toBeGreaterThan(0);
    }
    expect(createCalls()[0].options.timeout).toBe(GH_TIMEOUT_MS);
  });
});

describe('createPR gh pr create', () => {
  it('treats "already exists" as success and looks the PR up', async () => {
    state.respond = (call) => {
      if (call.args[1] === 'create') return { error: {}, stderr: 'a pull request for branch already exists' };
      if (call.args[1] === 'view') return { stdout: `${PR_URL}\n` };
      return { stdout: '' };
    };
    const result = await createPR(config());
    expect(result).toEqual({ success: true, prUrl: PR_URL, alreadyExists: true });
  });

  it('retries a network error and then succeeds', async () => {
    let attempts = 0;
    state.respond = (call) => {
      if (call.args[1] === 'create') {
        attempts++;
        return attempts === 1 ? { error: {}, stderr: 'connection reset' } : { stdout: PR_URL };
      }
      return { stdout: '' };
    };
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const pending = createPR(config());
      await vi.waitFor(() => expect(attempts).toBe(1));
      await vi.advanceTimersByTimeAsync(2000);
      expect(await pending).toEqual({ success: true, prUrl: PR_URL, alreadyExists: false });
    } finally {
      vi.useRealTimers();
    }
    expect(createCalls()).toHaveLength(2);
  });

  it('reports a gh timeout clearly and does not retry it', async () => {
    // A killed gh whose output looks like a network error must still not be retried.
    state.respond = (call) =>
      call.args[1] === 'create' ? { error: { killed: true }, stderr: 'connection timeout' } : { stdout: '' };
    const result = await createPR(config());
    expect(result.success).toBe(false);
    expect(result.error).toContain('gh pr create timed out after 60s');
    expect(createCalls()).toHaveLength(1);
  });
});

describe('createPR for a task that changed no code (zeenha fork)', () => {
  const revList = (answer: Outcome) => {
    const base = state.respond;
    state.respond = (call) => (call.command === 'git' && call.args[0] === 'rev-list' ? answer : base(call));
  };

  it('stops before pushing and says there is nothing to propose', async () => {
    revList({ stdout: '0\n' });
    const result = await createPR(config());
    expect(result).toEqual({ success: false, noChanges: true, error: NO_CHANGES_MESSAGE });
    expect(pushCalls()).toHaveLength(0);
    expect(createCalls()).toHaveLength(0);
    const check = state.calls.find((c) => c.args[0] === 'rev-list');
    expect(check?.args).toEqual(['rev-list', '--count', 'origin/main..HEAD']);
  });

  it('pushes and opens the PR when the branch has commits', async () => {
    revList({ stdout: '2\n' });
    const result = await createPR(config());
    expect(result.success).toBe(true);
    expect(pushCalls()).toHaveLength(1);
  });

  it('proceeds as before when the count cannot be read', async () => {
    revList({ error: { message: 'unknown revision' } });
    const result = await createPR(config());
    expect(result.success).toBe(true);
    expect(pushCalls()).toHaveLength(1);
  });
});

describe('createPR commits work the coder left uncommitted (zeenha fork)', () => {
  const answer = (pick: (call: Call) => Outcome | undefined) => {
    const base = state.respond;
    state.respond = (call) => pick(call) ?? base(call);
  };
  const gitCalls = (verb: string) => state.calls.filter((c) => c.command === 'git' && c.args[0] === verb);

  it('commits pending changes (excluding .auto-claude) before counting and pushing', async () => {
    answer((call) => (call.args[0] === 'status' ? { stdout: ' M docs/RUNBOOK.md\n' } : call.args[0] === 'rev-list' ? { stdout: '1\n' } : undefined));

    const result = await createPR(config({ title: 'Fix one typo in docs/RUNBOOK.md' }));

    expect(result.success).toBe(true);
    expect(gitCalls('add')[0].args).toEqual(['add', '-A', '--', '.', ':(exclude).auto-claude']);
    expect(gitCalls('commit')[0].args).toEqual(['commit', '-m', 'Fix one typo in docs/RUNBOOK.md']);
    const order = state.calls.map((c) => c.args[0]);
    expect(order.indexOf('commit')).toBeLessThan(order.indexOf('rev-list'));
    expect(order.indexOf('commit')).toBeLessThan(order.indexOf('push'));
  });

  it('does not commit when the worktree is clean', async () => {
    answer((call) => (call.args[0] === 'rev-list' ? { stdout: '1\n' } : undefined));
    await createPR(config());
    expect(gitCalls('commit')).toHaveLength(0);
  });

  it('stops without pushing when the commit fails', async () => {
    answer((call) =>
      call.args[0] === 'status' ? { stdout: ' M a.ts\n' } : call.args[0] === 'commit' ? { error: { message: 'hook failed' }, stderr: 'lint failed' } : undefined,
    );
    const result = await createPR(config());
    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not commit');
    expect(pushCalls()).toHaveLength(0);
  });
});

