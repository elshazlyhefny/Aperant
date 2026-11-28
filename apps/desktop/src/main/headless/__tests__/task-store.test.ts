import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TASK_RECORD_FIXTURES } from '../../__tests__/fixtures/task-record-fixtures';
import { DELIVERY_TIMING_FILE } from '../../ai/logging/delivery-timing';
import {
  createHeadlessTaskReader,
  createScheduledTaskSpec,
  listHeadlessTasks,
  queueHeadlessTask,
  resetStuckSubtasks,
  resolveSpecId,
  setTaskStatus
} from '../task-store';

vi.mock('fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs')>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) };
});

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

  it('uses the Markdown heading instead of a spec-ID feature', () => {
    const dir = writeSpec(root, '012-some-id', { feature: '012-some-id', description: 'From the plan' });
    writeFileSync(path.join(dir, 'spec.md'), '# Specification: Real Title');

    const [task] = listHeadlessTasks(project());
    expect(task.title).toBe('Real Title');
    expect(task.description).toBe('From the plan');
  });

  it('uses the Markdown Overview when requirements and the plan supply no description', () => {
    const dir = writeSpec(root, '012-some-id', { feature: 'Plan title' });
    writeFileSync(path.join(dir, 'spec.md'), '# Spec title\n\n## Overview\n\nDescribe the task\n\n## Details\n\nMore text');

    const [task] = listHeadlessTasks(project());
    expect(task.title).toBe('Plan title');
    expect(task.description).toBe('Describe the task');
  });

  it('does not read spec.md when requirements and the plan supply display fields', () => {
    const dir = writeSpec(root, '012-some-id', { feature: 'Plan title' }, undefined, 'From requirements');
    const specFile = path.join(dir, 'spec.md');
    writeFileSync(specFile, '# Spec title\n\n## Overview\n\nSpec description');
    vi.mocked(readFileSync).mockClear();

    const [task] = listHeadlessTasks(project());
    expect(task.title).toBe('Plan title');
    expect(task.description).toBe('From requirements');
    expect(vi.mocked(readFileSync).mock.calls.map(([file]) => file)).not.toContain(specFile);
  });

  it('reports an unreadable plan without desktop display markers', () => {
    const dir = writeSpec(root, '012-some-id');
    writeFileSync(path.join(dir, 'implementation_plan.json'), 'not valid JSON');
    writeFileSync(path.join(dir, 'spec.md'), '# Spec title\n\n## Overview\n\nSpec description');

    const [task] = listHeadlessTasks(project());
    expect(task.status).toBe('human_review');
    expect(task.reviewReason).toBe('errors');
    expect(task.title).toBe('012-some-id');
    expect(task.description).toBe('Spec description');
  });
});

describe('shared task record fixtures', () => {
  it.each(TASK_RECORD_FIXTURES)('$name', ({ specId, plan, requirements, specMd, expected }) => {
    const dir = writeSpec(root, specId);
    if (plan !== undefined) {
      writeFileSync(path.join(dir, 'implementation_plan.json'), typeof plan === 'string' ? plan : JSON.stringify(plan));
    }
    if (requirements !== undefined) {
      writeFileSync(path.join(dir, 'requirements.json'), JSON.stringify(requirements));
    }
    if (specMd !== undefined) {
      writeFileSync(path.join(dir, 'spec.md'), specMd);
    }

    const tasks = listHeadlessTasks(project());
    expect(tasks).toHaveLength(1);
    const [task] = tasks;
    expect(task.specId).toBe(specId);
    expect(task.status).toBe(expected.status);
    expect(task.reviewReason).toBe(expected.reviewReason);
    expect(task.title).toBe(expected.title);
    expect(task.description).toBe(expected.description);
    expect(task.subtasks.map(({ id }) => id)).toEqual(expected.subtaskIds);
    if (expected.subtaskFiles) {
      expect(Object.fromEntries(task.subtasks.map(({ id, files }) => [id, files]))).toEqual(expected.subtaskFiles);
    }
    if (expected.createdAt) expect(task.createdAt.toISOString()).toBe(expected.createdAt);
    if (expected.updatedAt) expect(task.updatedAt.toISOString()).toBe(expected.updatedAt);
  });
});

// zeenha fork: test the daemon's repeated scans with settled files that can be cached.
describe('createHeadlessTaskReader', () => {
  const settledAt = new Date('2020-01-01T00:00:00Z');
  const timestamps = { created_at: settledAt.toISOString(), updated_at: settledAt.toISOString() };
  const worktree = () => path.join(root, '.auto-claude', 'worktrees', 'tasks', '001-a');

  function backdate(file: string): void {
    utimesSync(file, settledAt, settledAt);
  }

  it('reuses all three unchanged parsed files without new misses', () => {
    const dir = writeSpec(root, '001-a', { status: 'queue', ...timestamps }, { tokenBudget: 5 }, 'Description');
    for (const file of ['implementation_plan.json', 'requirements.json', 'task_metadata.json']) {
      backdate(path.join(dir, file));
    }
    const reader = createHeadlessTaskReader(project());
    const first = reader.list();
    expect(first).toEqual(listHeadlessTasks(project()));
    expect(reader.stats).toEqual({ hits: 0, misses: 3 });
    expect(reader.list()).toEqual(first);
    expect(reader.stats).toEqual({ hits: 3, misses: 3 });
  });

  it('drops removed specs and evicts copies that no longer have a main spec', () => {
    const main = writeSpec(root, '001-a', { status: 'queue' });
    const wt = writeSpec(worktree(), '001-a', { status: 'in_progress' });
    backdate(path.join(main, 'implementation_plan.json'));
    backdate(path.join(wt, 'implementation_plan.json'));
    const reader = createHeadlessTaskReader(project());
    expect(reader.list()[0].status).toBe('in_progress');
    expect(reader.stats.misses).toBe(2);

    // Move it aside so it can be restored with the exact same inode and mtime.
    const moved = path.join(root, 'moved-spec');
    renameSync(main, moved);
    expect(reader.list()).toEqual([]);
    renameSync(moved, main);
    expect(reader.list()[0].status).toBe('in_progress');
    expect(reader.stats).toEqual({ hits: 0, misses: 4 });
  });

  it('falls back to main and evicts the worktree files when a worktree disappears', () => {
    const main = writeSpec(root, '001-a', { status: 'queue' });
    const wt = writeSpec(worktree(), '001-a', { status: 'in_progress' });
    backdate(path.join(main, 'implementation_plan.json'));
    backdate(path.join(wt, 'implementation_plan.json'));
    const reader = createHeadlessTaskReader(project());
    expect(reader.list()[0].status).toBe('in_progress');

    const moved = path.join(root, 'moved-worktree');
    renameSync(worktree(), moved);
    expect(reader.list()[0]).toMatchObject({ status: 'queue', specsPath: main });
    expect(reader.stats).toEqual({ hits: 1, misses: 2 });
    renameSync(moved, worktree());
    expect(reader.list()[0]).toMatchObject({ status: 'in_progress', specsPath: wt });
    expect(reader.stats).toEqual({ hits: 2, misses: 3 });
  });

  it('caches a malformed plan, then sees a repair and distinguishes a deleted plan', () => {
    const plan = path.join(writeSpec(root, '001-a'), 'implementation_plan.json');
    writeFileSync(plan, 'garbage');
    backdate(plan);
    const reader = createHeadlessTaskReader(project());
    for (let pass = 0; pass < 2; pass++) {
      expect(reader.list()[0]).toMatchObject({ status: 'human_review', reviewReason: 'errors' });
    }
    expect(reader.stats).toEqual({ hits: 1, misses: 1 });

    writeFileSync(plan, JSON.stringify({ status: 'queue' }));
    const repairedAt = new Date(settledAt.getTime() + 1000);
    utimesSync(plan, repairedAt, repairedAt);
    expect(reader.list()[0].status).toBe('queue');
    rmSync(plan);
    const [task] = reader.list();
    expect(task.status).toBe('backlog');
    expect(task).not.toHaveProperty('reviewReason');
  });

  it('routes a plan read error to human review instead of backlog', () => {
    const dir = writeSpec(root, '001-a');
    mkdirSync(path.join(dir, 'implementation_plan.json'));
    const reader = createHeadlessTaskReader(project());
    expect(reader.list()[0]).toMatchObject({ status: 'human_review', reviewReason: 'errors' });
  });

  it('detects an atomic plan replacement with the same mtime and size', () => {
    const dir = writeSpec(root, '001-a');
    const plan = path.join(dir, 'implementation_plan.json');
    const replacement = path.join(dir, 'replacement.json');
    writeFileSync(plan, JSON.stringify({ status: 'queue' }).padEnd(40));
    backdate(plan);
    const reader = createHeadlessTaskReader(project());
    expect(reader.list()[0].status).toBe('queue');

    writeFileSync(replacement, JSON.stringify({ status: 'in_progress' }).padEnd(40));
    backdate(replacement);
    renameSync(replacement, plan);
    expect(reader.list()[0].status).toBe('in_progress');
    expect(reader.stats).toEqual({ hits: 0, misses: 2 });
  });

  it('invalidates both plan copies after setTaskStatus and sees the new status immediately', async () => {
    const main = writeSpec(root, '001-a', { status: 'queue' });
    const wt = writeSpec(worktree(), '001-a', { status: 'queue' });
    const paths = [main, wt].map((dir) => path.join(dir, 'implementation_plan.json'));
    paths.forEach(backdate);
    const reader = createHeadlessTaskReader(project());
    expect(reader.list()[0].status).toBe('queue');
    const invalidate = vi.spyOn(reader.cache, 'invalidate');

    await setTaskStatus(project(), '001-a', 'in_progress', undefined, reader.cache);
    expect(invalidate.mock.calls.flat()).toEqual(paths);
    expect(reader.list()[0].status).toBe('in_progress');
  });

  it('invalidates the plan after resetting stuck subtasks', async () => {
    const dir = writeSpec(root, '001-a', {
      status: 'in_progress',
      phases: [{ subtasks: [{ id: 's1', status: 'in_progress' }] }]
    });
    const plan = path.join(dir, 'implementation_plan.json');
    backdate(plan);
    const reader = createHeadlessTaskReader(project());
    expect(reader.list()[0].subtasks[0].status).toBe('in_progress');
    const invalidate = vi.spyOn(reader.cache, 'invalidate');

    expect(await resetStuckSubtasks(plan, reader.cache)).toEqual({ success: true, resetCount: 1 });
    expect(invalidate.mock.calls).toEqual([[plan]]);
    expect(reader.list()[0].subtasks[0].status).toBe('pending');
  });

  it('invalidates scheduled spec files and lists the new task with its metadata', async () => {
    const reader = createHeadlessTaskReader(project());
    expect(reader.list()).toEqual([]);
    const invalidate = vi.spyOn(reader.cache, 'invalidate');
    const created = await createScheduledTaskSpec(
      project(),
      { title: 'Nightly check', description: 'Run the checks', tokenBudget: 1234 },
      'sched-1',
      1700000000000,
      reader.cache
    );
    const dir = path.join(root, '.auto-claude', 'specs', created.id);
    expect(invalidate.mock.calls.flat().sort()).toEqual(
      ['implementation_plan.json', 'requirements.json', 'task_metadata.json']
        .map((file) => path.join(dir, file))
        .sort()
    );
    expect(reader.list()).toEqual([created]);
    expect(created).toMatchObject({
      status: 'queue',
      metadata: { sourceType: 'schedule', scheduleId: 'sched-1', scheduledFor: 1700000000000, tokenBudget: 1234 }
    });
  });

  it('does not expose cached metadata to callers', () => {
    const dir = writeSpec(root, '001-a', { status: 'queue' }, { taskDependencies: ['000-z'], tokenBudget: 5 });
    backdate(path.join(dir, 'task_metadata.json'));
    const reader = createHeadlessTaskReader(project());
    const [task] = reader.list();
    if (!task.metadata?.taskDependencies) throw new Error('Expected dependencies in task metadata');
    task.metadata.taskDependencies.push('002-b');
    task.metadata.tokenBudget = 100;

    expect(reader.list()[0].metadata).toEqual({ taskDependencies: ['000-z'], tokenBudget: 5 });
    expect(reader.stats.hits).toBe(1);
  });

  it('builds a by-ID snapshot from one scan, with the worktree copy taking precedence', () => {
    const main = writeSpec(root, '001-a', { status: 'queue', ...timestamps });
    const second = writeSpec(root, '002-b', { status: 'queue', ...timestamps });
    const wt = writeSpec(worktree(), '001-a', { status: 'in_progress', ...timestamps });
    const orphan = writeSpec(worktree(), '009-orphan', { status: 'in_progress' });
    for (const dir of [main, second, wt, orphan]) backdate(path.join(dir, 'implementation_plan.json'));
    const reader = createHeadlessTaskReader(project());
    const snapshot = reader.snapshotById();

    expect(reader.stats).toEqual({ hits: 0, misses: 3 });
    expect(Array.from(snapshot.values())).toEqual(reader.list());
    expect(snapshot.get('001-a')).toMatchObject({ status: 'in_progress', specsPath: wt });
    expect(snapshot.get('002-b')).toMatchObject({ status: 'queue', specsPath: second });
    expect(snapshot.has('009-orphan')).toBe(false);
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
      const timing = JSON.parse(readFileSync(path.join(dir, DELIVERY_TIMING_FILE), 'utf-8'));
      expect(timing.events).toMatchObject([
        { status: 'human_review', reviewReason: 'completed', from: 'queue', source: 'daemon' }
      ]);
    }
    const [task] = listHeadlessTasks(project());
    expect(task.status).toBe('human_review');
    expect(task.reviewReason).toBe('completed');
  });

  it('records pause and interruption metadata with the previous status of each copy', async () => {
    const main = writeSpec(root, '001-a', { status: 'in_progress' });
    const wtDir = writeSpec(path.join(root, '.auto-claude', 'worktrees', 'tasks', '001-a'), '001-a', {
      status: 'coding'
    });

    await setTaskStatus(project(), '001-a', 'error', undefined, undefined, { pause: 'budget' });
    await setTaskStatus(project(), '001-a', 'queue', undefined, undefined, { interrupted: true });

    for (const [dir, from] of [[main, 'in_progress'], [wtDir, 'coding']]) {
      const timing = JSON.parse(readFileSync(path.join(dir, DELIVERY_TIMING_FILE), 'utf-8'));
      expect(timing.events).toMatchObject([
        { status: 'error', from, pause: 'budget', source: 'daemon' },
        { status: 'queue', from: 'error', interrupted: true, source: 'daemon' }
      ]);
    }
  });

  it('creates a minimal plan when none exists', async () => {
    writeSpec(root, '001-a');
    await setTaskStatus(project(), '001-a', 'queue');
    expect(listHeadlessTasks(project())[0].status).toBe('queue');
  });
});

describe('queueHeadlessTask', () => {
  it('queues a backlog spec on main and worktree copies', async () => {
    const main = writeSpec(root, '001-a', { feature: 'A', status: 'backlog' });
    const wtDir = writeSpec(path.join(root, '.auto-claude', 'worktrees', 'tasks', '001-a'), '001-a', {
      feature: 'A',
      status: 'backlog'
    });
    expect(await queueHeadlessTask(project(), '001-a')).toEqual({ ok: true, specId: '001-a' });
    for (const dir of [main, wtDir]) {
      const plan = JSON.parse(readFileSync(path.join(dir, 'implementation_plan.json'), 'utf-8'));
      expect(plan.status).toBe('queue');
    }
  });

  it('resolves by unique prefix', async () => {
    writeSpec(root, '007-foo', { feature: 'Foo', status: 'backlog' });
    writeSpec(root, '008-bar', { feature: 'Bar', status: 'backlog' });
    expect(await queueHeadlessTask(project(), '007')).toEqual({ ok: true, specId: '007-foo' });
    const byId = Object.fromEntries(listHeadlessTasks(project()).map((t) => [t.id, t.status]));
    expect(byId).toEqual({ '007-foo': 'queue', '008-bar': 'backlog' });
  });

  it('rejects an ambiguous prefix and lists candidates', async () => {
    writeSpec(root, '007-foo', { status: 'backlog' });
    writeSpec(root, '007-bar', { status: 'backlog' });
    const result = await queueHeadlessTask(project(), '007');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('ambiguous');
      expect(result.error).toContain('007-foo');
      expect(result.error).toContain('007-bar');
    }
    expect(listHeadlessTasks(project()).every((t) => t.status === 'backlog')).toBe(true);
  });

  it('prefers an exact id over a prefix match', () => {
    writeSpec(root, '007', { status: 'backlog' });
    writeSpec(root, '007-foo', { status: 'backlog' });
    expect(resolveSpecId(listHeadlessTasks(project()), '007')).toEqual({ specId: '007' });
  });

  it('rejects an unknown spec', async () => {
    writeSpec(root, '001-a', { status: 'backlog' });
    const result = await queueHeadlessTask(project(), '999');
    expect(result).toEqual({ ok: false, error: expect.stringContaining('not found') });
  });

  it.each(['in_progress', 'queue', 'human_review', 'done'])('refuses a %s task', async (status) => {
    const dir = writeSpec(root, '001-a', { feature: 'A', status });
    const result = await queueHeadlessTask(project(), '001-a');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(status);
    const plan = JSON.parse(readFileSync(path.join(dir, 'implementation_plan.json'), 'utf-8'));
    expect(plan.status).toBe(status);
  });

  it('queues regardless of status with requireBacklog false', async () => {
    writeSpec(root, '001-a', { feature: 'A', status: 'human_review' });
    expect(await queueHeadlessTask(project(), '001-a', { requireBacklog: false })).toEqual({
      ok: true,
      specId: '001-a'
    });
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
  // zeenha fork: no spec.md; runHeadlessTask creates it from requirements.json, as on the desktop.
  it('creates a queued task with schedule metadata and requirements, without spec.md', async () => {
    writeSpec(root, '004-old', { status: 'done' });
    const created = await createScheduledTaskSpec(
      project(),
      { title: 'Nightly check', description: 'Run the checks', tokenBudget: 1234, category: 'feature' },
      'sched-1',
      1700000000000
    );
    expect(created.id.startsWith('005-')).toBe(true);
    expect(existsSync(path.join(created.specsPath as string, 'spec.md'))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(created.specsPath as string, 'requirements.json'), 'utf-8')))
      .toEqual({ task_description: 'Run the checks', workflow_type: 'feature' });

    const listed = listHeadlessTasks(project()).find((t) => t.id === created.id);
    expect(listed?.status).toBe('queue');
    expect(listed?.metadata?.scheduleId).toBe('sched-1');
    expect(listed?.metadata?.sourceType).toBe('schedule');
    expect(listed?.metadata?.scheduledFor).toBe(1700000000000);
    expect(listed?.metadata?.tokenBudget).toBe(1234);
    expect(listed?.description).toBe('Run the checks');
  });
});
