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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

import { generateText } from 'ai';
import { createPR, GH_TIMEOUT_MS, NO_CHANGES_MESSAGE, PUSH_TIMEOUT_MS, unfinishedTaskMessage } from '../pr-creator';

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
    expect(result).not.toHaveProperty('errorCode');
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
    expect(result.errorCode).toBe('BRANCH_REFUSED');
    expect(state.calls).toHaveLength(0);
  });

  it('reports a rejected push and does not create the PR', async () => {
    state.respond = (call) =>
      call.args[0] === 'push'
        ? { error: { message: 'Command failed' }, stderr: ' ! [rejected] (stale info)' }
        : { stdout: '' };
    const result = await createPR(config());
    expect(result).toEqual({
      success: false,
      errorCode: 'PUSH_FAILED',
      error: 'Failed to push branch:  ! [rejected] (stale info)',
    });
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
    expect(result.errorCode).toBe('PUSH_FAILED');
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
    expect(result).not.toHaveProperty('errorCode');
  });

  it('reports GH_FAILED for a non-retryable gh error', async () => {
    state.respond = (call) =>
      call.args[1] === 'create' ? { error: {}, stderr: 'GraphQL: Resource not accessible' } : { stdout: '' };
    const result = await createPR(config());
    expect(result).toEqual({ success: false, errorCode: 'GH_FAILED', error: 'GraphQL: Resource not accessible' });
    expect(createCalls()).toHaveLength(1);
  });

  // The loop's last attempt returns GH_FAILED itself, so RETRIES_EXHAUSTED is
  // unreachable; a network error on every attempt ends as GH_FAILED.
  it('ends a persistent network error as GH_FAILED after 3 attempts', async () => {
    let attempts = 0;
    state.respond = (call) => {
      if (call.args[1] === 'create') {
        attempts++;
        return { error: {}, stderr: 'connection reset' };
      }
      return { stdout: '' };
    };
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const pending = createPR(config());
      await vi.waitFor(() => expect(attempts).toBe(1));
      await vi.advanceTimersByTimeAsync(2000);
      await vi.waitFor(() => expect(attempts).toBe(2));
      await vi.advanceTimersByTimeAsync(4000);
      const result = await pending;
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GH_FAILED');
    } finally {
      vi.useRealTimers();
    }
    expect(createCalls()).toHaveLength(3);
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
    expect(result.errorCode).toBe('GH_TIMEOUT');
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
    expect(result).toEqual({ success: false, noChanges: true, errorCode: 'NO_CHANGES', error: NO_CHANGES_MESSAGE });
    expect(pushCalls()).toHaveLength(0);
    expect(createCalls()).toHaveLength(0);
    const check = state.calls.find((c) => c.args[0] === 'rev-list');
    expect(check?.args).toEqual(['rev-list', '--count', 'origin/main..HEAD']);
  });

  // Task 095: stopped after 1 of 29 subtasks, then told to mark itself done.
  it('says to resume, not to mark done, when the plan has unfinished subtasks', async () => {
    revList({ stdout: '0\n' });
    const result = await createPR(config({ subtaskProgress: { completed: 1, total: 29 } }));
    expect(result).toEqual({
      success: false,
      noChanges: true,
      errorCode: 'NO_CHANGES',
      error: unfinishedTaskMessage(1, 29),
    });
    expect(result.error).toContain('stopped after 1 of 29 subtasks');
    expect(result.error).toContain('Resume the task');
    expect(result.error).not.toBe(NO_CHANGES_MESSAGE);
    expect(pushCalls()).toHaveLength(0);
  });

  it('keeps the mark-done advice when every subtask finished without code', async () => {
    revList({ stdout: '0\n' });
    const result = await createPR(config({ subtaskProgress: { completed: 4, total: 4 } }));
    expect(result.error).toBe(NO_CHANGES_MESSAGE);
    expect(result.errorCode).toBe('NO_CHANGES');
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
    answer((call) =>
      call.args[0] === 'status'
        ? { stdout: ' M docs/RUNBOOK.md\n?? .auto-claude/\n' }
        : call.args[0] === 'diff' && call.args[1] === '--cached'
          ? { stdout: 'docs/RUNBOOK.md\n' }
          : call.args[0] === 'rev-list'
            ? { stdout: '1\n' }
            : undefined,
    );

    const result = await createPR(config({ title: 'Fix one typo in docs/RUNBOOK.md' }));

    expect(result.success).toBe(true);
    expect(gitCalls('add')[0].args).toEqual(['add', '-A', '--', '.']);
    expect(gitCalls('reset')[0].args).toEqual(['reset', '-q', '--', '.auto-claude']);
    expect(gitCalls('commit')[0].args).toEqual(['commit', '-m', 'Fix one typo in docs/RUNBOOK.md']);
    const order = state.calls.map((c) => c.args[0]);
    expect(order.indexOf('commit')).toBeLessThan(order.indexOf('rev-list'));
    expect(order.indexOf('commit')).toBeLessThan(order.indexOf('push'));
  });

  it('does not commit when the worktree is clean, or only .auto-claude changed', async () => {
    answer((call) =>
      call.args[0] === 'status' ? { stdout: '?? .auto-claude/\n' } : call.args[0] === 'rev-list' ? { stdout: '1\n' } : undefined,
    );
    await createPR(config());
    expect(gitCalls('commit')).toHaveLength(0);
  });

  it('stops without pushing when the commit fails', async () => {
    answer((call) =>
      call.args[0] === 'status'
        ? { stdout: ' M a.ts\n' }
        : call.args[0] === 'diff' && call.args[1] === '--cached'
          ? { stdout: 'a.ts\n' }
          : call.args[0] === 'commit'
            ? { error: { message: 'hook failed' }, stderr: 'lint failed' }
            : undefined,
    );
    const result = await createPR(config());
    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not commit');
    expect(result.errorCode).toBe('COMMIT_FAILED');
    expect(pushCalls()).toHaveLength(0);
  });
});


describe('createPR suggests the title from the COMMITTED branch (zeenha fork)', () => {
  const generate = vi.mocked(generateText);
  const prompts: string[] = [];
  let committed = false;

  beforeEach(() => {
    prompts.length = 0;
    committed = false;
    generate.mockImplementation((async (args: { prompt: string }) => {
      prompts.push(args.prompt);
      return { text: args.prompt.includes('Write the pull request title') ? 'feat(shop): add View cart link' : '## Summary\n- body' };
    }) as unknown as typeof generateText);
    state.respond = (call) => {
      if (call.command === 'gh' && call.args[1] === 'create') return { stdout: `${PR_URL}\n` };
      if (call.args[0] === 'status') return { stdout: committed ? '' : ' M shop/cart.ts\n' };
      if (call.args[0] === 'diff' && call.args[1] === '--cached') return { stdout: 'shop/cart.ts\n' };
      if (call.args[0] === 'commit') {
        committed = true;
        return { stdout: '' };
      }
      if (call.args[0] === 'rev-list') return { stdout: '1\n' };
      // The work exists on the branch only once it has been committed.
      if (call.args[0] === 'log') return { stdout: committed ? 'abc1234 Add a View cart link\n' : '' };
      if (call.args[0] === 'diff' && call.args[1] === '--stat') return { stdout: committed ? ' shop/cart.ts | 4 ++++\n' : '' };
      return { stdout: '' };
    };
  });

  it('asks for the title after committing pending work, so the model sees the changes', async () => {
    const result = await createPR(config({ title: undefined, fallbackTitle: 'Add a View cart link', taskTitle: 'Add a View cart link' }));

    expect(result.success).toBe(true);
    const titlePrompt = prompts.find((p) => p.includes('Write the pull request title')) ?? '';
    expect(titlePrompt).toContain('abc1234 Add a View cart link');
    expect(titlePrompt).toContain('shop/cart.ts | 4');
    // The pending work is committed under the task title; the PR gets the AI title.
    expect(state.calls.find((c) => c.args[0] === 'commit')?.args).toEqual(['commit', '-m', 'Add a View cart link']);
    const create = createCalls()[0].args;
    expect(create[create.indexOf('--title') + 1]).toBe('feat(shop): add View cart link');
  });

  it('falls back to the task title when the suggestion is unusable', async () => {
    generate.mockImplementation((async () => ({ text: 'not a conventional title' })) as unknown as typeof generateText);
    await createPR(config({ title: undefined, fallbackTitle: 'Add a View cart link' }));
    const create = createCalls()[0].args;
    expect(create[create.indexOf('--title') + 1]).toBe('Add a View cart link');
  });

  it('caps a spec-length task title used as the fallback', async () => {
    generate.mockImplementation((async () => ({ text: 'not a conventional title' })) as unknown as typeof generateText);
    const long = `Add a View cart link: ${'the storefront header has no way back to the cart from a product page, '.repeat(4)}`;
    await createPR(config({ title: undefined, fallbackTitle: long }));
    const create = createCalls()[0].args;
    expect(create[create.indexOf('--title') + 1]).toBe('Add a View cart link');
  });

  it('never asks the model when a title was typed', async () => {
    await createPR(config({ title: 'My own title' }));
    expect(prompts.some((p) => p.includes('Write the pull request title'))).toBe(false);
    const create = createCalls()[0].args;
    expect(create[create.indexOf('--title') + 1]).toBe('My own title');
  });
});

describe('the PR body is written from the project conventions and the QA report', () => {
  it('gives the model the running/testing sections and the QA report, not a guess', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'pr-body-'));
    try {
      writeFileSync(join(worktree, 'CLAUDE.md'), '# Repo\n\n## Tenancy rules\nsecret sauce\n\n## Running things\n- **Docker only.** `docker compose exec app php artisan <cmd>`\n');
      mkdirSync(join(worktree, '.auto-claude', 'specs', '001-x'), { recursive: true });
      writeFileSync(join(worktree, '.auto-claude', 'specs', '001-x', 'qa_report.md'), 'Status: PASSED\nscripts/test-backend.sh --filter=ReminderSweepTest: 14 passed');
      const generate = vi.mocked(generateText);
      generate.mockClear();

      await createPR(config({ worktreePath: worktree }));

      const prompts = generate.mock.calls.map((c) => String((c[0] as { prompt?: string }).prompt));
      const body = prompts.find((p) => p.includes('Create a GitHub Pull Request description')) ?? '';
      expect(body).toContain('`docker compose exec app php artisan <cmd>`');
      expect(body).toContain('scripts/test-backend.sh --filter=ReminderSweepTest: 14 passed');
      expect(body).not.toContain('secret sauce');
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });
});
