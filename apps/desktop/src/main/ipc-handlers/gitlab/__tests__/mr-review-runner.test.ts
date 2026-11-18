/**
 * zeenha fork: GitLab MR review flow (normal + follow-up) behaviour tests.
 * Pins the shared behaviour before the two review paths are merged (task 151).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface EngineRun {
  context: unknown;
  signal: AbortSignal;
  resolve: (r: unknown) => void;
  reject: (e: unknown) => void;
}

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  listeners: new Map<string, (...a: unknown[]) => unknown>(),
  runs: [] as Array<{
    context: unknown;
    signal: AbortSignal;
    resolve: (r: unknown) => void;
    reject: (e: unknown) => void;
  }>,
  sent: [] as Array<{ channel: string; args: unknown[] }>,
  mkdir: vi.fn(),
  write: vi.fn(),
  cleanup: vi.fn(async () => undefined),
  mcpClose: vi.fn(async () => undefined)
}));

vi.mock('electron', () => ({
  ipcMain: {
    on: (c: string, fn: (...a: unknown[]) => unknown) => h.listeners.set(c, fn),
    handle: (c: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(c, fn)
  }
}));
vi.mock('../../github/utils/project-middleware', () => ({
  withProjectOrNull: async (id: string, fn: (p: unknown) => Promise<unknown>) =>
    id === 'p1' ? fn({ id: 'p1', path: '/proj' }) : null
}));
vi.mock('../utils', () => ({
  getGitLabConfig: async () => ({ token: 't', instanceUrl: 'https://gitlab.example', project: 'grp/repo' }),
  encodeProjectPath: (p: string) => encodeURIComponent(p),
  gitlabFetch: async (_t: string, _u: string, url: string, opts?: { method?: string }) => {
    if (url === '/user') return { id: 7, username: 'me' };
    if (opts?.method === 'PUT') return {};
    if (url.endsWith('/changes')) {
      return { changes: [{ new_path: 'a.ts', old_path: 'a.ts', diff: '+x\n-y' }] };
    }
    return {
      iid: 1,
      title: 't',
      description: 'd',
      author: { username: 'a' },
      source_branch: 's',
      target_branch: 'main'
    };
  }
}));
vi.mock('../../../settings-utils', () => ({ readSettingsFile: () => ({}) }));
vi.mock('../../../ai/runners/github/pr-review-checkout', () => ({
  prepareMRReviewCheckout: async () => ({ kind: 'pr-head', sha: 'a'.repeat(40), dir: '/proj/wt', cleanup: h.cleanup })
}));
vi.mock('../../../ai/runners/github/pr-review-mcp', () => ({
  createPRReviewMcpSession: () => ({ close: h.mcpClose })
}));
vi.mock('../../../mcp-approval-store', () => ({ getApprovals: () => ({}) }));
vi.mock('../../../ai/runners/gitlab/mr-review-engine', () => ({
  MRReviewEngine: class {
    runReview(context: unknown, signal: AbortSignal) {
      return new Promise((resolve, reject) => {
        h.runs.push({ context, signal, resolve, reject });
        signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('The operation was aborted raw'), { name: 'AbortError' }))
        );
      });
    }
  }
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    mkdirSync: h.mkdir,
    writeFileSync: h.write,
    default: { ...actual, mkdirSync: h.mkdir, writeFileSync: h.write }
  };
});
vi.mock('../../github/utils/ipc-communicator', () => ({
  createIPCCommunicators: (_w: unknown, channels: Record<string, string>) => ({
    sendProgress: (d: unknown) => h.sent.push({ channel: channels.progress, args: [d] }),
    sendError: (d: unknown) => h.sent.push({ channel: channels.error, args: [d] }),
    sendComplete: (d: unknown) => h.sent.push({ channel: channels.complete, args: [d] })
  })
}));

import { IPC_CHANNELS } from '../../../../shared/constants';
import { registerMRReviewHandlers } from '../mr';

const win = {} as never;
const okResult = (verdict = 'ready_to_merge') => ({ findings: [], summary: 's', verdict });

const startReview = (iid = 1) => h.listeners.get(IPC_CHANNELS.GITLAB_MR_REVIEW)!({}, 'p1', iid) as Promise<void>;
const startFollowup = (iid = 1) =>
  h.listeners.get(IPC_CHANNELS.GITLAB_MR_FOLLOWUP_REVIEW)!({}, 'p1', iid) as Promise<void>;
const cancel = (iid = 1) => h.handlers.get(IPC_CHANNELS.GITLAB_MR_REVIEW_CANCEL)!({}, 'p1', iid);
const errors = () =>
  h.sent
    .filter((s) => s.channel === IPC_CHANNELS.GITLAB_MR_REVIEW_ERROR)
    .map((s) => (s.args[0] as { error: string }).error);
const savedData = () => JSON.parse(h.write.mock.calls.at(-1)![1] as string);
const run = (i: number): EngineRun => h.runs[i];

beforeEach(() => {
  vi.clearAllMocks();
  h.sent.length = 0;
  h.runs.length = 0;
  h.listeners.clear();
  h.handlers.clear();
  registerMRReviewHandlers(() => win);
});

describe('GitLab MR review flow', () => {
  // flip to it() when the paths are merged (task 151 phase 4)
  it('ignores a second review for the same MR while one is running, and cancel aborts the first', async () => {
    const first = startReview(1);
    await vi.waitFor(() => expect(h.runs).toHaveLength(1));
    const second = startReview(1);
    // let the second start progress past its async fetches
    for (let i = 0; i < 50; i++) await Promise.resolve();
    const launched = h.runs.length;
    const cancelled = await cancel(1);
    const firstAborted = run(0).signal.aborted;
    // settle every launched run so a failing assertion never leaks a running review
    for (const r of h.runs) r.reject(Object.assign(new Error('cleanup'), { name: 'AbortError' }));
    await Promise.all([first, second]);

    expect(launched).toBe(1);
    expect(cancelled).toBe(true);
    expect(firstAborted).toBe(true);
  });

  it('ignores a second follow-up review while one is running', async () => {
    const first = startFollowup(1);
    await vi.waitFor(() => expect(h.runs).toHaveLength(1));
    await startFollowup(1);
    expect(h.runs).toHaveLength(1);

    run(0).resolve(okResult());
    await first;
  });

  // flip to it() when the paths are merged (task 151 phase 4)
  it('reports "Review cancelled" when a follow-up is cancelled', async () => {
    const first = startFollowup(1);
    await vi.waitFor(() => expect(h.runs).toHaveLength(1));
    expect(await cancel(1)).toBe(true);
    await first;

    const errs = errors();
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('Review cancelled');
    expect(errs[0]).not.toContain('aborted raw');
  });

  it('reports "Review cancelled" when a normal review is cancelled', async () => {
    const first = startReview(1);
    await vi.waitFor(() => expect(h.runs).toHaveLength(1));
    expect(await cancel(1)).toBe(true);
    await first;

    const errs = errors();
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('Review cancelled');
    expect(errs[0]).not.toContain('aborted raw');
  });

  it('saves a follow-up result with isFollowupReview true and maps verdicts', async () => {
    const first = startFollowup(1);
    await vi.waitFor(() => expect(h.runs).toHaveLength(1));
    run(0).resolve(okResult('ready_to_merge'));
    await first;
    expect(savedData().is_followup_review).toBe(true);
    expect(savedData().overall_status).toBe('approve');
    expect(h.sent.some((s) => s.channel === IPC_CHANNELS.GITLAB_MR_REVIEW_COMPLETE)).toBe(true);

    const second = startFollowup(2);
    await vi.waitFor(() => expect(h.runs).toHaveLength(2));
    run(1).resolve(okResult('blocked'));
    await second;
    expect(savedData().overall_status).toBe('request_changes');
  });

  it('saves a normal review result without isFollowupReview and maps verdicts', async () => {
    const first = startReview(1);
    await vi.waitFor(() => expect(h.runs).toHaveLength(1));
    run(0).resolve(okResult('ready_to_merge'));
    await first;
    expect(savedData().is_followup_review).toBeFalsy();
    expect(savedData().overall_status).toBe('approve');
    expect(h.sent.some((s) => s.channel === IPC_CHANNELS.GITLAB_MR_REVIEW_COMPLETE)).toBe(true);

    const second = startReview(2);
    await vi.waitFor(() => expect(h.runs).toHaveLength(2));
    run(1).resolve(okResult('blocked'));
    await second;
    expect(savedData().overall_status).toBe('request_changes');
  });

  it('allows the same MR to be started again after a review finishes', async () => {
    const first = startReview(1);
    await vi.waitFor(() => expect(h.runs).toHaveLength(1));
    run(0).resolve(okResult());
    await first;

    const second = startReview(1);
    await vi.waitFor(() => expect(h.runs).toHaveLength(2));
    run(1).resolve(okResult());
    await second;
  });

  it('allows the same MR to be started again after a review is cancelled', async () => {
    const first = startReview(1);
    await vi.waitFor(() => expect(h.runs).toHaveLength(1));
    expect(await cancel(1)).toBe(true);
    await first;

    const second = startFollowup(1);
    await vi.waitFor(() => expect(h.runs).toHaveLength(2));
    run(1).resolve(okResult());
    await second;
  });
});
