/**
 * zeenha fork: the finalizer pushes a PR follow-up only after a fresh QA approval.
 */
import os from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Task } from '../../../../shared/types';
import type { FastForwardPushResult } from '../../../ai/runners/github/pr-creator';
import { finalizePRFollowUp, type PRFollowUpFinalizerDeps, type PRFollowUpOutcome } from '../pr-followup-finalizer';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: () => os.tmpdir(), isPackaged: false, on: vi.fn() },
}));
vi.mock('../../../task-state-manager', () => ({ taskStateManager: {} }));
vi.mock('../../../ai/runners/github/pr-creator', () => ({ pushBranchFastForward: vi.fn() }));
vi.mock('../../github/utils', () => ({ getGitHubConfig: vi.fn() }));
vi.mock('../../github/pr/task-feedback', () => ({ fetchPRFeedback: vi.fn() }));
vi.mock('../worktree-pr', () => ({ updateTaskStatusAfterPRCreation: vi.fn() }));
vi.mock('../../../worktree-paths', () => ({ findTaskWorktree: vi.fn() }));
vi.mock('../../../cli-tool-manager', () => ({ getToolPath: (t: string) => t }));
vi.mock('../../../utils/git-isolation', () => ({ getIsolatedGitEnv: () => ({}) }));

const WT = '/wt';
const BRANCH = 'auto-claude/001-x';
const REF = `refs/heads/${BRANCH}`;
const REVIEWED_SHA = 'a'.repeat(40);
const LOCAL_SHA = 'b'.repeat(40);
const MOVED_SHA = 'c'.repeat(40);
const PUSH_URL = 'https://github.com/o/r.git';
const STALE_GUIDANCE =
  'Your local commits are kept in the worktree. Refresh the PR feedback, review the new revision, then send feedback again or push by hand. Nothing was pushed.';
const SPEC_DIR = `${WT}/.auto-claude/specs/001-x`;
const MARKER = `${SPEC_DIR}/PR_FOLLOWUP.json`;
const PLAN = `${SPEC_DIR}/implementation_plan.json`;
const project = { id: 'p1', path: '/proj', autoBuildPath: '.auto-claude' } as Project;
const task = { id: 't1', specId: '001-x', status: 'done', metadata: { prUrl: 'https://github.com/o/r/pull/7' } } as unknown as Task;

interface Setup {
  marker?: Record<string, unknown> | null;
  signoff?: unknown;
  branch?: string;
  head?: string;
  porcelain?: string;
  prState?: string;
  prHeadRef?: string;
  prHeadSha?: string;
  prLookupFails?: boolean;
  currentPushUrl?: string | null;
  remoteSha?: string;
  lsRemoteOutput?: string | null;
  resolvedReviewedSha?: string | null;
  pushResult?: FastForwardPushResult;
  ancestor?: boolean;
}

function setup(o: Setup = {}) {
  const files = new Map<string, string>();
  const marker =
    o.marker === null
      ? null
      : {
          version: 2,
          prUrl: 'https://github.com/o/r/pull/7',
          prNumber: 7,
          branch: BRANCH,
          headShaAtStart: REVIEWED_SHA,
          reviewedHeadSha: REVIEWED_SHA,
          pushRemote: { name: 'origin', url: PUSH_URL },
          qaSignoffBefore: JSON.stringify({ status: 'rejected' }),
          status: 'running',
          ...(o.marker ?? {}),
        };
  if (marker) files.set(MARKER, JSON.stringify(marker));
  files.set(PLAN, JSON.stringify({ qa_signoff: 'signoff' in o ? o.signoff : { status: 'approved', at: 'new' } }));

  const push = vi.fn(async (): Promise<FastForwardPushResult> => o.pushResult ?? { ok: true });
  const markDone = vi.fn();
  const persist = vi.fn(async () => {});
  const notify = vi.fn();
  const git = vi.fn(async (args: string[], _cwd: string) => {
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return `${o.branch ?? BRANCH}\n`;
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      if (o.resolvedReviewedSha === null) throw new Error('unknown revision');
      return `${o.resolvedReviewedSha ?? REVIEWED_SHA}\n`;
    }
    if (args[0] === 'rev-parse') return `${o.head ?? LOCAL_SHA}\n`;
    if (args[0] === 'merge-base') {
      if (o.ancestor === false) throw new Error('not ancestor');
      return '';
    }
    if (args[0] === 'status') return o.porcelain ?? ' M .auto-claude/specs/x\n';
    if (args[0] === 'remote') {
      if (o.currentPushUrl === null) throw new Error('no push URL');
      return `${o.currentPushUrl ?? PUSH_URL}\n`;
    }
    if (args[0] === 'ls-remote') {
      if (o.lsRemoteOutput === null) throw new Error('remote unavailable');
      return o.lsRemoteOutput ?? `${o.remoteSha ?? REVIEWED_SHA}\t${REF}\n`;
    }
    throw new Error(`Unexpected git command: ${args.join(' ')}`);
  });
  const deps: PRFollowUpFinalizerDeps = {
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, c) => void files.set(p, c),
    git,
    pushFastForward: push,
    findWorktree: () => WT,
    getPRState: async () => {
      if (o.prLookupFails) throw new Error('PR unavailable');
      return { state: o.prState ?? 'open', headRef: o.prHeadRef ?? BRANCH, headSha: o.prHeadSha ?? REVIEWED_SHA };
    },
    persistPRDone: persist,
    markDone,
    notify,
  };
  const markerStatus = () => (JSON.parse(files.get(MARKER) ?? 'null') as { status?: string; reason?: string } | null);
  return { deps, git, push, markDone, persist, notify, markerStatus, files };
}

const run = (s: ReturnType<typeof setup>, exitCode: number | null = 0) =>
  finalizePRFollowUp({ taskId: 't1', exitCode, project, task, deps: s.deps });

function expectStale(s: ReturnType<typeof setup>, out: PRFollowUpOutcome | null, reason: string) {
  expect(out).toEqual({ status: 'stale', reason: `${reason} ${STALE_GUIDANCE}`, headSha: LOCAL_SHA });
  expect(s.markerStatus()).toMatchObject({ status: 'stale', reason: out?.reason, headShaAfter: LOCAL_SHA });
  expect(s.notify).toHaveBeenCalledExactlyOnceWith('t1', out);
  expect(s.persist).not.toHaveBeenCalled();
  expect(s.markDone).not.toHaveBeenCalled();
}

describe('finalizePRFollowUp', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does nothing without a marker', async () => {
    const s = setup({ marker: null });
    expect(await run(s)).toBeNull();
    expect(s.push).not.toHaveBeenCalled();
    expect(s.notify).not.toHaveBeenCalled();
  });

  it('does nothing when the marker is not running', async () => {
    const s = setup({ marker: { status: 'pushed' } });
    expect(await run(s)).toBeNull();
    expect(s.push).not.toHaveBeenCalled();
  });

  it('does not push when QA rejected', async () => {
    const s = setup({ signoff: { status: 'rejected', at: 'new' } });
    const out = await run(s);
    expect(out?.status).toBe('failed');
    expect(s.push).not.toHaveBeenCalled();
    expect(s.markDone).not.toHaveBeenCalled();
    expect(s.markerStatus()?.status).toBe('failed');
  });

  it('does not push on a non-zero exit', async () => {
    const s = setup();
    expect((await run(s, 1))?.status).toBe('failed');
    expect(s.push).not.toHaveBeenCalled();
  });

  it('does not push on a stale signoff', async () => {
    const s = setup({ signoff: { status: 'rejected' } });
    s.files.set(MARKER, JSON.stringify({ ...JSON.parse(s.files.get(MARKER) as string), qaSignoffBefore: JSON.stringify({ status: 'rejected' }) }));
    expect((await run(s))?.status).toBe('failed');
    const stale = setup({ signoff: { status: 'approved' } });
    stale.files.set(MARKER, JSON.stringify({ ...JSON.parse(stale.files.get(MARKER) as string), qaSignoffBefore: JSON.stringify({ status: 'approved' }) }));
    expect((await run(stale))?.status).toBe('failed');
    expect(stale.push).not.toHaveBeenCalled();
  });

  it('pushes exactly once and restores the PR-open status when approved with a new commit', async () => {
    const s = setup();
    const out = await run(s);
    expect(out).toEqual({ status: 'pushed', headSha: LOCAL_SHA });
    expect(s.push).toHaveBeenCalledTimes(1);
    expect(s.git).toHaveBeenCalledWith(['remote', 'get-url', '--push', 'origin'], WT);
    expect(s.git).toHaveBeenCalledWith(['ls-remote', 'origin', REF], WT);
    expect(s.push).toHaveBeenCalledWith(WT, BRANCH, REVIEWED_SHA);
    expect(s.persist).toHaveBeenCalledWith(SPEC_DIR, WT, 'https://github.com/o/r/pull/7', '.auto-claude', '001-x');
    expect(s.markDone).toHaveBeenCalledWith('t1', task, project);
    expect(s.markerStatus()?.status).toBe('pushed');
    expect(s.notify).toHaveBeenCalledTimes(1);
  });

  it('does not push when approved but there is no new commit', async () => {
    const s = setup({ head: REVIEWED_SHA, marker: { reviewedHeadSha: REVIEWED_SHA.slice(0, 12) } });
    expect((await run(s))?.status).toBe('no_changes');
    expect(s.push).not.toHaveBeenCalled();
    expect(s.markerStatus()?.status).toBe('no_changes');
  });

  it.each(['closed', 'merged'])('does not push when the PR is %s', async (prState) => {
    const s = setup({ prState });
    expect((await run(s))?.status).toBe('failed');
    expect(s.push).not.toHaveBeenCalled();
  });

  it('does not push when the PR head ref differs', async () => {
    const s = setup({ prHeadRef: 'other' });
    expect((await run(s))?.status).toBe('failed');
    expect(s.push).not.toHaveBeenCalled();
  });

  it('does not push with uncommitted work, but ignores .auto-claude files', async () => {
    const dirty = setup({ porcelain: ' M src/a.ts\n' });
    expect((await run(dirty))?.status).toBe('failed');
    expect(dirty.push).not.toHaveBeenCalled();
    const clean = setup({ porcelain: '?? .auto-claude/specs/001-x/notes.md\n' });
    expect((await run(clean))?.status).toBe('pushed');
  });

  it('refuses a wrong branch name', async () => {
    const s = setup({ branch: 'main' });
    expect((await run(s))?.status).toBe('failed');
    expect(s.push).not.toHaveBeenCalled();
  });

  it('refuses a head that does not descend from the reviewed revision', async () => {
    const s = setup({ ancestor: false });
    expectStale(s, await run(s), 'Local history does not fast-forward from the reviewed revision.');
    expect(s.push).not.toHaveBeenCalled();
  });

  it('refuses a reviewed revision that cannot be resolved locally', async () => {
    const s = setup({ resolvedReviewedSha: null });
    expectStale(s, await run(s), 'The reviewed revision could not be verified in the worktree.');
    expect(s.push).not.toHaveBeenCalled();
  });

  it('refuses to push when the PR head changed', async () => {
    const s = setup({ prHeadSha: MOVED_SHA });
    expectStale(s, await run(s), 'The pull request revision changed from aaaaaaa to ccccccc.');
    expect(s.push).not.toHaveBeenCalled();
  });

  it.each([{ prHeadSha: '' }, { prLookupFails: true }])('refuses an unverifiable PR head (%o)', async (options) => {
    const s = setup(options);
    expectStale(s, await run(s), "Could not verify the pull request's current revision.");
    expect(s.push).not.toHaveBeenCalled();
  });

  it.each([
    { currentPushUrl: 'https://example.com/other.git' },
    { currentPushUrl: null },
    { marker: { pushRemote: undefined } },
  ])('refuses a changed or unverified push destination (%o)', async (options) => {
    const s = setup(options);
    expectStale(s, await run(s), 'The push destination of the worktree changed (or was not recorded).');
    expect(s.push).not.toHaveBeenCalled();
  });

  it.each([
    { remoteSha: MOVED_SHA }, // Ancestry succeeds, but a moved tip is stale even if a fast-forward is possible.
    { lsRemoteOutput: null },
    { lsRemoteOutput: '' },
    { remoteSha: REVIEWED_SHA.slice(0, 12) },
    { lsRemoteOutput: `${REVIEWED_SHA}\trefs/heads/other\n` },
  ])('refuses a changed or unverified remote branch tip (%o)', async (options) => {
    const s = setup(options);
    expectStale(s, await run(s), 'The branch on the remote is no longer at the reviewed revision.');
    expect(s.push).not.toHaveBeenCalled();
  });

  it('reports a stale push if the remote moves after verification, without editing local history', async () => {
    const s = setup({ pushResult: { ok: false, stale: true, error: 'rejected: stale info' } });
    expectStale(s, await run(s), 'The branch no longer allows a fast-forward push from the reviewed revision.');
    expect(s.push).toHaveBeenCalledExactlyOnceWith(WT, BRANCH, REVIEWED_SHA);
    expect(s.git.mock.calls.map(([args]) => args[0])).toEqual([
      'rev-parse', 'rev-parse', 'rev-parse', 'merge-base', 'status', 'remote', 'ls-remote',
    ]);
  });

  it('uses headShaAtStart when reviewedHeadSha is missing', async () => {
    const s = setup({ marker: { version: undefined, reviewedHeadSha: undefined } });
    expect((await run(s))?.status).toBe('pushed');
    expect(s.git).toHaveBeenCalledWith(['rev-parse', '--verify', `${REVIEWED_SHA}^{commit}`], WT);
    expect(s.push).toHaveBeenCalledExactlyOnceWith(WT, BRANCH, REVIEWED_SHA);
  });

  it('expands a short reviewed revision and uses the full remote SHA as the lease', async () => {
    const short = REVIEWED_SHA.slice(0, 12);
    const s = setup({ marker: { headShaAtStart: MOVED_SHA, reviewedHeadSha: short }, prHeadSha: short });
    expect((await run(s))?.status).toBe('pushed');
    expect(s.git).toHaveBeenCalledWith(['rev-parse', '--verify', `${short}^{commit}`], WT);
    expect(s.git).toHaveBeenCalledWith(['merge-base', '--is-ancestor', REVIEWED_SHA, 'HEAD'], WT);
    expect(s.push).toHaveBeenCalledExactlyOnceWith(WT, BRANCH, REVIEWED_SHA);
  });

  it('records push_failed and leaves the task alone when the push fails', async () => {
    const s = setup({ pushResult: { ok: false, stale: false, error: 'authentication failed' } });
    const out = await run(s);
    expect(out?.status).toBe('push_failed');
    expect(s.markerStatus()).toMatchObject({ status: 'push_failed', reason: 'authentication failed' });
    expect(s.markDone).not.toHaveBeenCalled();
    expect(s.persist).not.toHaveBeenCalled();
  });
});
