import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createScheduledTaskSpec,
  listHeadlessTasks,
  resetStuckSubtasks,
  setTaskStatus
} from '../task-store';

let root: string;
const project = () => ({ id: 'p1', path: root, autoBuildPath: '.auto-claude' });

function writeSpec(base: string, specId: string, plan?: object, metadata?: object, description?: string): string {
  const dir = path.join(base, '.auto-claude', 'specs', specId);
  mkdirSync(dir, { recursive: true });
  if (plan) writeFileSync(path.join(dir, 'implementation_plan.json'), JSON.stringify(plan));
  if (metadata) writeFileSync(path.join(dir, 'task_metadata.json'), JSON.stringify(metadata));
  if (description) writeFileSync(path.join(dir, 'requirements.json'), JSON.stringify({ task_description: description }));
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'headless-task-store-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('listHeadlessTasks', () => {
  it('merges main and worktree, worktree wins', () => {
    writeSpec(root, '001-a', { feature: 'A', status: 'queue', created_at: '2026-01-01T00:00:00Z' });
    writeSpec(root, '002-b', { feature: 'B', status: 'queue' });
    const wt = path.join(root, '.auto-claude', 'worktrees', 'tasks', '001-a');
    writeSpec(wt, '001-a', { feature: 'A', status: 'in_progress' });
    writeSpec(wt, '009-orphan', { feature: 'Orphan', status: 'in_progress' });

    const tasks = listHeadlessTasks(project());
    const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
    expect(Object.keys(byId).sort()).toEqual(['001-a', '002-b']);
    expect(byId['001-a'].status).toBe('in_progress');
    expect(byId['002-b'].status).toBe('queue');
  });

  it('surfaces queue fields, dependencies and plan data', () => {
    writeSpec(
      root,
      '001-a',
      {
        feature: 'A',
        status: 'human_review',
        reviewReason: 'completed',
        created_at: '2026-01-01T00:00:00.000Z',
        phases: [{ subtasks: [{ id: 's1', title: 't', description: 'd', status: 'completed', files_to_modify: ['x.ts'] }] }]
      },
      { taskDependencies: ['000-z'], tokenBudget: 5, scheduleId: 'sch', archivedAt: '2026-02-01' },
      'Do the thing'
    );
    const [task] = listHeadlessTasks(project());
    expect(task.description).toBe('Do the thing');
    expect(task.reviewReason).toBe('completed');
    expect(task.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(task.metadata?.taskDependencies).toEqual(['000-z']);
    expect(task.metadata?.tokenBudget).toBe(5);
    expect(task.metadata?.scheduleId).toBe('sch');
    expect(task.subtasks).toHaveLength(1);
    expect(task.subtasks[0].files).toContain('x.ts');
  });

  it('defaults to backlog without a plan', () => {
    writeSpec(root, '001-a');
    expect(listHeadlessTasks(project())[0].status).toBe('backlog');
  });
});

describe('setTaskStatus', () => {
  it('round trips status and review reason on main and worktree copies', async () => {
    const main = writeSpec(root, '001-a', { feature: 'A', status: 'queue' });
    const wtDir = writeSpec(path.join(root, '.auto-claude', 'worktrees', 'tasks', '001-a'), '001-a', {
      feature: 'A',
      status: 'queue'
    });
    await setTaskStatus(project(), '001-a', 'human_review', 'completed');
    for (const dir of [main, wtDir]) {
      const plan = JSON.parse(readFileSync(path.join(dir, 'implementation_plan.json'), 'utf-8'));
      expect(plan.status).toBe('human_review');
      expect(plan.planStatus).toBe('review');
      expect(plan.reviewReason).toBe('completed');
    }
    const [task] = listHeadlessTasks(project());
    expect(task.status).toBe('human_review');
    expect(task.reviewReason).toBe('completed');
  });

  it('creates a minimal plan when none exists', async () => {
    writeSpec(root, '001-a');
    await setTaskStatus(project(), '001-a', 'queue');
    expect(listHeadlessTasks(project())[0].status).toBe('queue');
  });
});

describe('resetStuckSubtasks', () => {
  it('resets in_progress and failed, keeps completed', async () => {
    const dir = writeSpec(root, '001-a', {
      status: 'in_progress',
      phases: [
        {
          subtasks: [
            { id: '1', status: 'completed', completed_at: 'x' },
            { id: '2', status: 'in_progress', started_at: 'y' },
            { id: '3', status: 'failed' }
          ]
        }
      ]
    });
    const planPath = path.join(dir, 'implementation_plan.json');
    expect(await resetStuckSubtasks(planPath)).toEqual({ success: true, resetCount: 2 });
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
    expect(plan.phases[0].subtasks.map((s: { status: string }) => s.status)).toEqual([
      'completed',
      'pending',
      'pending'
    ]);
    expect(plan.phases[0].subtasks[0].completed_at).toBe('x');
  });

  it('reports failure for a missing file', async () => {
    expect(await resetStuckSubtasks(path.join(root, 'nope.json'))).toEqual({ success: false, resetCount: 0 });
  });
});

describe('createScheduledTaskSpec', () => {
  it('creates a queued task with schedule metadata and spec.md', async () => {
    writeSpec(root, '004-old', { status: 'done' });
    const created = await createScheduledTaskSpec(
      project(),
      { title: 'Nightly check', description: 'Run the checks', tokenBudget: 1234, category: 'feature' },
      'sched-1',
      1700000000000
    );
    expect(created.id.startsWith('005-')).toBe(true);
    expect(readFileSync(path.join(created.specsPath as string, 'spec.md'), 'utf-8')).toContain('Run the checks');

    const listed = listHeadlessTasks(project()).find((t) => t.id === created.id);
    expect(listed?.status).toBe('queue');
    expect(listed?.metadata?.scheduleId).toBe('sched-1');
    expect(listed?.metadata?.sourceType).toBe('schedule');
    expect(listed?.metadata?.scheduledFor).toBe(1700000000000);
    expect(listed?.metadata?.tokenBudget).toBe(1234);
    expect(listed?.description).toBe('Run the checks');
  });
});
