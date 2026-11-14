/**
 * zeenha fork: Bitbucket review runner and handlers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  listeners: new Map<string, (...a: unknown[]) => unknown>(),
  orchestratorConfigs: [] as Array<Record<string, unknown>>,
  review: vi.fn(),
  checkout: vi.fn(),
  mcpClose: vi.fn(async () => undefined),
  cleanup: vi.fn(async () => undefined),
  save: vi.fn(),
  sent: [] as Array<{ channel: string; args: unknown[] }>
}));

vi.mock('electron', () => ({
  ipcMain: {
    on: (c: string, fn: (...a: unknown[]) => unknown) => h.listeners.set(c, fn),
    handle: (c: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(c, fn)
  }
}));
vi.mock('../../../project-store', () => ({
  projectStore: { getProject: (id: string) => (id === 'p1' ? { id: 'p1', path: '/proj' } : undefined) }
}));
vi.mock('../../github/utils/project-middleware', () => ({
  withProjectOrNull: async (id: string, fn: (p: unknown) => Promise<unknown>) =>
    id === 'p1' ? fn({ id: 'p1', path: '/proj' }) : null
}));
vi.mock('../utils', () => ({
  getBitbucketConfig: async () => ({ username: 'u', token: 't', repository: 'ws/repo' })
}));
vi.mock('../review-context', () => ({
  fetchBitbucketPRContext: async () => ({
    context: { changedFiles: [], commits: [], baseBranch: 'main' },
    headSha: 'a'.repeat(40),
    sourceBranch: 'feature'
  })
}));
vi.mock('../review-results', () => ({
  saveBitbucketReviewResult: h.save,
  getBitbucketReviewResult: vi.fn(() => null)
}));
vi.mock('../../github/pr/review-logs', () => ({
  PRLogCollector: class {
    processLine = vi.fn();
    finalize = vi.fn();
  },
  loadPRLogsIfChanged: vi.fn(() => 'unchanged')
}));
vi.mock('../../github/pr/review-results', () => ({
  getGitHubPRSettings: () => ({ model: 'sonnet', thinkingLevel: 'medium' })
}));
vi.mock('../../../ai/runners/github/parallel-orchestrator', () => ({
  ParallelOrchestratorReviewer: class {
    constructor(config: Record<string, unknown>) {
      h.orchestratorConfigs.push(config);
    }
    review = h.review;
  }
}));
vi.mock('../../../ai/runners/github/pr-review-checkout', () => ({
  prepareBitbucketReviewCheckout: h.checkout,
  checkoutNoteFor: () => 'NOTE'
}));
vi.mock('../../../ai/runners/github/pr-review-mcp', () => ({
  createPRReviewMcpSession: () => ({ close: h.mcpClose })
}));
vi.mock('../../../mcp-approval-store', () => ({ getApprovals: () => ({}) }));
vi.mock('../../../sentry', () => ({ safeBreadcrumb: vi.fn(), safeCaptureException: vi.fn() }));
vi.mock('../../shared/ipc-communicator', () => ({
  createIPCCommunicators: (_w: unknown, channels: Record<string, string>) => ({
    sendProgress: (d: unknown) => h.sent.push({ channel: channels.progress, args: [d] }),
    sendError: (d: unknown) => h.sent.push({ channel: channels.error, args: [d] }),
    sendComplete: (d: unknown) => h.sent.push({ channel: channels.complete, args: [d] })
  })
}));

import { IPC_CHANNELS } from '../../../../shared/constants';
import { registerBitbucketReviewHandlers } from '../review-handlers';
import { runBitbucketPRReview, runningBitbucketReviews } from '../review-runner';

const project = { id: 'p1', path: '/proj' } as never;
const win = {} as never;
const okResult = { findings: [], summary: 's', verdict: 'ready_to_merge', agentsInvoked: ['a'] };
const headCheckout = () => ({ kind: 'pr-head', dir: '/proj/.auto-claude/pr-review/bb-1', sha: 'a'.repeat(40), cleanup: h.cleanup });

beforeEach(() => {
  vi.clearAllMocks();
  h.sent.length = 0;
  h.orchestratorConfigs.length = 0;
  runningBitbucketReviews.clear();
  h.review.mockResolvedValue(okResult);
  h.checkout.mockResolvedValue(headCheckout());
});

describe('runBitbucketPRReview', () => {
  it('saves the review and uses reviewDir for a pr-head checkout', async () => {
    const result = await runBitbucketPRReview(project, 1, win);
    expect(result.overallStatus).toBe('approve');
    expect(result.reviewedCommitSha).toBe('a'.repeat(40));
    expect(h.save).toHaveBeenCalledWith(project, 1, result);
    expect(h.orchestratorConfigs[0].reviewDir).toBe('/proj/.auto-claude/pr-review/bb-1');
    expect(h.cleanup).toHaveBeenCalled();
    expect(h.mcpClose).toHaveBeenCalled();
    expect(runningBitbucketReviews.size).toBe(0);
  });

  it('omits reviewDir for a base fallback and has nothing to clean up', async () => {
    h.checkout.mockResolvedValue({ kind: 'base', reason: 'fork' });
    await runBitbucketPRReview(project, 1, win);
    expect(h.orchestratorConfigs[0].reviewDir).toBeUndefined();
    expect(h.cleanup).not.toHaveBeenCalled();
    expect(h.mcpClose).toHaveBeenCalled();
  });

  it('cleans up when the review fails', async () => {
    h.review.mockRejectedValue(new Error('boom'));
    await expect(runBitbucketPRReview(project, 1, win)).rejects.toThrow('boom');
    expect(h.cleanup).toHaveBeenCalled();
    expect(h.mcpClose).toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    expect(runningBitbucketReviews.size).toBe(0);
  });

  it('cleans up and reports cancellation when aborted', async () => {
    h.review.mockImplementation(async () => {
      runningBitbucketReviews.get('p1:1')?.abort();
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });
    await expect(runBitbucketPRReview(project, 1, win)).rejects.toThrow('Review cancelled');
    expect(h.cleanup).toHaveBeenCalled();
    expect(h.mcpClose).toHaveBeenCalled();
    expect(runningBitbucketReviews.size).toBe(0);
  });
});

describe('Bitbucket review handlers', () => {
  const start = (id: unknown) => h.listeners.get(IPC_CHANNELS.BITBUCKET_PR_REVIEW)!({}, 'p1', id);

  beforeEach(() => {
    h.listeners.clear();
    h.handlers.clear();
    registerBitbucketReviewHandlers(() => win);
  });

  it('rejects invalid ids without starting a review', async () => {
    await start(-3);
    await start(1.5);
    expect(h.review).not.toHaveBeenCalled();
    expect(h.sent.filter((s) => s.channel === IPC_CHANNELS.BITBUCKET_PR_REVIEW_ERROR)).toHaveLength(2);
  });

  it('runs a review and sends complete', async () => {
    await start(2);
    const channels = h.sent.map((s) => s.channel);
    expect(channels).toContain(IPC_CHANNELS.BITBUCKET_PR_REVIEW_COMPLETE);
    expect(h.review).toHaveBeenCalledTimes(1);
  });

  it('does not start a second orchestrator while one is running, and cancel aborts it', async () => {
    let release!: () => void;
    h.review.mockImplementation(
      (_c: unknown, signal: AbortSignal) =>
        new Promise((_res, rej) => {
          release = () => rej(Object.assign(new Error('x'), { name: 'AbortError' }));
          signal.addEventListener('abort', release);
        })
    );
    const first = start(3);
    await vi.waitFor(() => expect(h.review).toHaveBeenCalled());
    await start(3);
    expect(h.review).toHaveBeenCalledTimes(1);

    const cancel = h.handlers.get(IPC_CHANNELS.BITBUCKET_PR_REVIEW_CANCEL)!;
    expect(await cancel({}, 'p1', 3)).toBe(true);
    expect(await cancel({}, 'p1', 3)).toBe(false);
    await first;
    expect(h.cleanup).toHaveBeenCalled();
  });
});
