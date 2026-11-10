/**
 * zeenha fork: the finalizer pushes a PR follow-up only after a fresh QA approval.
 */
import os from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Task } from '../../../../shared/types';
import { finalizePRFollowUp, type PRFollowUpFinalizerDeps } from '../pr-followup-finalizer';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: () => os.tmpdir(), isPackaged: false, on: vi.fn() },
}));
vi.mock('../../../task-state-manager', () => ({ taskStateManager: {} }));
vi.mock('../../../ai/runners/github/pr-creator', () => ({ pushBranch: vi.fn() }));
vi.mock('../../github/utils', () => ({ getGitHubConfig: vi.fn() }));
vi.mock('../../github/pr/task-feedback', () => ({ fetchPRFeedback: vi.fn() }));
vi.mock('../worktree-pr', () => ({ updateTaskStatusAfterPRCreation: vi.fn() }));
vi.mock('../../../worktree-paths', () => ({ findTaskWorktree: vi.fn() }));
vi.mock('../../../cli-tool-manager', () => ({ getToolPath: (t: string) => t }));
vi.mock('../../../utils/git-isolation', () => ({ getIsolatedGitEnv: () => ({}) }));

const WT = '/wt';
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
  pushError?: string;
  ancestor?: boolean;
}

function setup(o: Setup = {}) {
  const files = new Map<string, string>();
  const marker =
    o.marker === null
      ? null
      : {
          prUrl: 'https://github.com/o/r/pull/7',
          prNumber: 7,
          branch: 'auto-claude/001-x',
          headShaAtStart: 'aaa',
          qaSignoffBefore: JSON.stringify({ status: 'rejected' }),
          status: 'running',
          ...(o.marker ?? {}),
        };
  if (marker) files.set(MARKER, JSON.stringify(marker));
  files.set(PLAN, JSON.stringify({ qa_signoff: 'signoff' in o ? o.signoff : { status: 'approved', at: 'new' } }));

  const push = vi.fn(async () => o.pushError);
  const markDone = vi.fn();
  const persist = vi.fn(async () => {});
  const notify = vi.fn();
  const deps: PRFollowUpFinalizerDeps = {
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, c) => void files.set(p, c),
    git: async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return `${o.branch ?? 'auto-claude/001-x'}\n`;
      if (args[0] === 'rev-parse') return `${o.head ?? 'bbb'}\n`;
      if (args[0] === 'merge-base') {
        if (o.ancestor === false) throw new Error('not ancestor');
        return '';
      }
      if (args[0] === 'status') return o.porcelain ?? ' M .auto-claude/specs/x\n';
      return '';
    },
    pushBranch: push,
    findWorktree: () => WT,
    getPRState: async () => ({ state: o.prState ?? 'open', headRef: o.prHeadRef ?? 'auto-claude/001-x' }),
    persistPRDone: persist,
    markDone,
    notify,
  };
  const markerStatus = () => (JSON.parse(files.get(MARKER) ?? 'null') as { status?: string; reason?: string } | null);
  return { deps, push, markDone, persist, notify, markerStatus, files };
}

const run = (s: ReturnType<typeof setup>, exitCode: number | null = 0) =>
  finalizePRFollowUp({ taskId: 't1', exitCode, project, task, deps: s.deps });

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
    expect(out).toEqual({ status: 'pushed', headSha: 'bbb' });
    expect(s.push).toHaveBeenCalledTimes(1);
    expect(s.push).toHaveBeenCalledWith(WT, 'auto-claude/001-x');
    expect(s.persist).toHaveBeenCalledWith(SPEC_DIR, WT, 'https://github.com/o/r/pull/7', '.auto-claude', '001-x');
    expect(s.markDone).toHaveBeenCalledWith('t1', task, project);
    expect(s.markerStatus()?.status).toBe('pushed');
    expect(s.notify).toHaveBeenCalledTimes(1);
  });

  it('does not push when approved but there is no new commit', async () => {
    const s = setup({ head: 'aaa' });
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

  it('refuses a head that does not descend from the start sha', async () => {
    const s = setup({ ancestor: false });
    expect((await run(s))?.status).toBe('failed');
    expect(s.push).not.toHaveBeenCalled();
  });

  it('records push_failed and leaves the task alone when the push fails', async () => {
    const s = setup({ pushError: 'rejected: stale info' });
    const out = await run(s);
    expect(out?.status).toBe('push_failed');
    expect(s.markerStatus()).toMatchObject({ status: 'push_failed', reason: 'rejected: stale info' });
    expect(s.markDone).not.toHaveBeenCalled();
    expect(s.persist).not.toHaveBeenCalled();
  });
});
