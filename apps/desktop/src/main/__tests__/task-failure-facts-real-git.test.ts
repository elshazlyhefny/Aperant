/**
 * zeenha fork: the facts behind "failed before any work", against a real
 * repository and worktree, and the tasks read from disk (project-store),
 * including tasks persisted before the Failed column existed.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let TEST_DIR: string;
let USER_DATA_PATH: string;

vi.mock('electron', () => ({
  app: { getPath: vi.fn((name: string) => (name === 'userData' ? USER_DATA_PATH : TEST_DIR)) },
}));
vi.mock('../cli-tool-manager', () => ({ getToolPath: (tool: string) => tool }));

let repo: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim();

const SPEC = '025-failed-task';
const specDir = () => join(repo, '.auto-claude', 'specs', SPEC);
const worktree = () => join(repo, '.auto-claude', 'worktrees', 'tasks', SPEC);
const worktreeSpecDir = () => join(worktree(), '.auto-claude', 'specs', SPEC);

/** The persisted shape of the five real failed tasks (0/N subtasks, CODING_FAILED). */
function failedPlan(subtaskStatuses: string[] = ['pending', 'pending'], extra: Record<string, unknown> = {}) {
  return {
    feature: 'Failed task',
    workflow_type: 'development',
    status: 'human_review',
    planStatus: 'review',
    xstateState: 'error',
    executionPhase: 'failed',
    reviewReason: 'errors',
    phases: [{ name: 'P1', subtasks: subtaskStatuses.map((status, i) => ({ id: `1-${i}`, description: 'x', status })) }],
    final_acceptance: [],
    created_at: '2026-10-11T00:00:00Z',
    updated_at: '2026-10-11T00:00:00Z',
    spec_file: 'spec.md',
    ...extra,
  };
}

function writePlan(dir: string, plan: unknown) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'implementation_plan.json'), JSON.stringify(plan));
}

function writeLogs(dir: string, content: string) {
  mkdirSync(dir, { recursive: true });
  const phase = (status: string, entries: unknown[] = []) => ({ phase: 'x', status, started_at: null, completed_at: null, entries });
  writeFileSync(
    join(dir, 'task_logs.json'),
    JSON.stringify({
      spec_id: SPEC,
      created_at: '',
      updated_at: '',
      phases: {
        planning: phase('failed', [{ timestamp: '2026-10-11T01:00:00Z', type: 'phase_end', content, phase: 'planning' }]),
        coding: phase('pending'),
        validation: phase('pending'),
      },
    })
  );
}

function addWorktree() {
  mkdirSync(join(repo, '.auto-claude', 'worktrees', 'tasks'), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', `auto-claude/${SPEC}`, worktree());
}

async function loadTask() {
  const { ProjectStore } = await import('../project-store');
  const store = new ProjectStore();
  const project = store.addProject(repo);
  return store.getTasks(project.id).find((t) => t.specId === SPEC)!;
}

beforeEach(async () => {
  vi.resetModules();
  TEST_DIR = mkdtempSync(join(tmpdir(), 'failed-task-'));
  USER_DATA_PATH = join(TEST_DIR, 'userData');
  mkdirSync(join(USER_DATA_PATH, 'store'), { recursive: true });
  repo = join(TEST_DIR, 'project');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), '.auto-claude/\n');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  const { clearCodeChangesCache } = await import('../task-failure-facts');
  clearCodeChangesCache();
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('worktreeHasCodeChanges', () => {
  it('is false for a fresh task worktree', async () => {
    addWorktree();
    const { worktreeHasCodeChanges } = await import('../task-failure-facts');
    expect(worktreeHasCodeChanges(worktree())).toBe(false);
  });

  it('ignores Aperant\'s own .auto-claude files', async () => {
    addWorktree();
    writePlan(worktreeSpecDir(), failedPlan());
    const { worktreeHasCodeChanges } = await import('../task-failure-facts');
    expect(worktreeHasCodeChanges(worktree())).toBe(false);
  });

  it('is true for an uncommitted edit', async () => {
    addWorktree();
    writeFileSync(join(worktree(), 'a.txt'), 'two\n');
    const { worktreeHasCodeChanges } = await import('../task-failure-facts');
    expect(worktreeHasCodeChanges(worktree())).toBe(true);
  });

  it('is true for a commit on the task branch, whatever the base', async () => {
    addWorktree();
    writeFileSync(join(worktree(), 'b.txt'), 'new\n');
    git(worktree(), 'add', 'b.txt');
    git(worktree(), 'commit', '-qm', 'work');
    const { worktreeHasCodeChanges } = await import('../task-failure-facts');
    expect(worktreeHasCodeChanges(worktree())).toBe(true);
  });

  it('is null when git cannot answer', async () => {
    const { worktreeHasCodeChanges } = await import('../task-failure-facts');
    expect(worktreeHasCodeChanges(join(TEST_DIR, 'not-a-repo'))).toBeNull();
  });
});

describe('readFailureReason', () => {
  it('prefers the reason the state machine recorded on the plan', async () => {
    writePlan(specDir(), failedPlan(undefined, { failureReason: 'Plan validation failed' }));
    writeLogs(specDir(), 'Failed planning phase: something else');
    const { readFailureReason } = await import('../task-failure-facts');
    expect(readFailureReason([specDir()])).toBe('Plan validation failed');
  });

  it('falls back to the failed phase_end message', async () => {
    writePlan(specDir(), failedPlan());
    writeLogs(specDir(), 'Failed planning phase: Claude Code CLI: 429');
    const { readFailureReason } = await import('../task-failure-facts');
    expect(readFailureReason([specDir()])).toBe('Claude Code CLI: 429');
  });

  it('has none for the bare message logged before reasons were kept', async () => {
    writePlan(specDir(), failedPlan());
    writeLogs(specDir(), 'Failed planning phase');
    const { readFailureReason } = await import('../task-failure-facts');
    expect(readFailureReason([specDir()])).toBeUndefined();
  });
});

describe('project-store: a failed run read from disk', () => {
  it('shows a persisted no-work failure (status human_review, xstate error, 0/N) as Failed', async () => {
    writePlan(specDir(), failedPlan());
    addWorktree();
    writePlan(worktreeSpecDir(), failedPlan());
    writeLogs(worktreeSpecDir(), 'Failed planning phase');
    const task = await loadTask();
    expect(task.status).toBe('error');
    expect(task.reviewReason).toBeUndefined();
    expect(task.failureReason).toBeUndefined();
  });

  it('carries the recorded reason', async () => {
    writePlan(specDir(), failedPlan());
    writeLogs(specDir(), 'Failed coding phase: phases: array must have at least 1 item');
    const task = await loadTask();
    expect(task.status).toBe('error');
    expect(task.failureReason).toBe('phases: array must have at least 1 item');
  });

  it('keeps Human Review when a subtask was completed (e.g. QA max iterations)', async () => {
    writePlan(specDir(), failedPlan(['completed', 'pending']));
    const task = await loadTask();
    expect(task.status).toBe('human_review');
    expect(task.reviewReason).toBe('errors');
  });

  it('keeps Human Review when only the worktree plan shows a completed subtask', async () => {
    writePlan(specDir(), failedPlan());
    addWorktree();
    writePlan(worktreeSpecDir(), failedPlan(['completed', 'pending']));
    const task = await loadTask();
    expect(task.status).toBe('human_review');
  });

  it('keeps Human Review when the worktree holds a commit', async () => {
    writePlan(specDir(), failedPlan());
    addWorktree();
    writeFileSync(join(worktree(), 'b.txt'), 'new\n');
    git(worktree(), 'add', 'b.txt');
    git(worktree(), 'commit', '-qm', 'work');
    const task = await loadTask();
    expect(task.status).toBe('human_review');
    expect(task.reviewReason).toBe('errors');
  });

  it('keeps Human Review when the task ran without a worktree (changes cannot be told apart)', async () => {
    writePlan(specDir(), failedPlan());
    writeFileSync(join(specDir(), 'task_metadata.json'), JSON.stringify({ useWorktree: false }));
    const task = await loadTask();
    expect(task.status).toBe('human_review');
  });

  it('does not touch a real review', async () => {
    writePlan(specDir(), failedPlan(['completed'], { xstateState: 'human_review', executionPhase: 'complete', reviewReason: 'completed' }));
    const task = await loadTask();
    expect(task.status).toBe('human_review');
    expect(task.reviewReason).toBe('completed');
  });

  it('does not touch a task whose plan could not be parsed', async () => {
    mkdirSync(specDir(), { recursive: true });
    writeFileSync(join(specDir(), 'implementation_plan.json'), '{ not json');
    const task = await loadTask();
    expect(task.status).toBe('human_review');
    expect(task.reviewReason).toBe('errors');
  });
});

describe('Re-plan: resetPlanFiles', () => {
  it('empties the phases of every copy and keeps the rest', async () => {
    writePlan(specDir(), failedPlan());
    addWorktree();
    writePlan(worktreeSpecDir(), failedPlan());
    const { resetPlanFiles, canResetPlan } = await import('../ipc-handlers/task/reset-plan');
    expect(resetPlanFiles([specDir(), worktreeSpecDir()])).toEqual({ success: true, resetCount: 2 });
    for (const dir of [specDir(), worktreeSpecDir()]) {
      const plan = JSON.parse(readFileSync(join(dir, 'implementation_plan.json'), 'utf-8'));
      expect(plan.phases).toEqual([]);
      expect(plan.feature).toBe('Failed task');
    }
    expect(canResetPlan({ status: 'error' })).toBe(true);
    expect(canResetPlan({ status: 'human_review' })).toBe(false);
    expect(canResetPlan({ status: 'in_progress' })).toBe(false);
  });
});
