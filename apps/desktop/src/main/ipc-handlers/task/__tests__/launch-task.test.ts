import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const watcher = vi.hoisted(() => ({ watch: vi.fn(() => Promise.resolve()) }));
vi.mock('../../../file-watcher', () => ({ fileWatcher: watcher }));

const git = vi.hoisted(() => ({
  checkGitStatus: vi.fn((): { isGitRepo: boolean; hasCommits: boolean; error?: string } => ({
    isGitRepo: true,
    hasCommits: true,
  })),
}));
vi.mock('../../../project-initializer', () => ({ checkGitStatus: git.checkGitStatus }));

const auth = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('../../../claude-profile-manager', () => ({ initializeClaudeProfileManager: auth.init }));

const worktree = vi.hoisted(() => ({ find: vi.fn((): string | null => null) }));
vi.mock('../../../worktree-paths', () => ({ findTaskWorktree: worktree.find }));

const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../../settings-utils', () => ({ readSettingsFile: () => settings.value }));

import {
  buildExecutionOptions,
  launchTask,
  planHasSubtasks,
  preflightTaskLaunch,
  resolveBaseBranch,
} from '../launch-task';

const agentManager = { startSpecCreation: vi.fn(), startTaskExecution: vi.fn() };

let root = '';
let specDir = '';

// biome-ignore lint/suspicious/noExplicitAny: minimal fixtures
function makeTask(over: any = {}): any {
  return { id: 't1', specId: '001-x', title: 'Title', description: 'Desc', metadata: undefined, ...over };
}
// biome-ignore lint/suspicious/noExplicitAny: minimal fixtures
function makeProject(over: any = {}): any {
  return { id: 'p1', path: root, autoBuildPath: '.auto-claude', settings: { mainBranch: 'main' }, ...over };
}
function writeSpec() {
  fs.writeFileSync(path.join(specDir, 'spec.md'), '# Spec\n');
}
function writePlan(content: string | object) {
  fs.writeFileSync(
    path.join(specDir, 'implementation_plan.json'),
    typeof content === 'string' ? content : JSON.stringify(content)
  );
}
const WITH_SUBTASKS = { phases: [{ subtasks: [{ id: 's1', status: 'pending' }] }] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  settings.value = {};
  worktree.find.mockReturnValue(null);
  git.checkGitStatus.mockReturnValue({ isGitRepo: true, hasCommits: true });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-task-'));
  specDir = path.join(root, '.auto-claude', 'specs', '001-x');
  fs.mkdirSync(specDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('planHasSubtasks', () => {
  it('is false when the plan file is missing', () => {
    expect(planHasSubtasks(specDir)).toBe(false);
  });
  it('is false for corrupt JSON', () => {
    writePlan('{not json');
    expect(planHasSubtasks(specDir)).toBe(false);
  });
  it('is false for phases without subtasks', () => {
    writePlan({ phases: [{ name: 'a' }, { subtasks: [] }] });
    expect(planHasSubtasks(specDir)).toBe(false);
  });
  it('is true when subtasks exist', () => {
    writePlan(WITH_SUBTASKS);
    expect(planHasSubtasks(specDir)).toBe(true);
  });
});

describe('buildExecutionOptions', () => {
  it('passes all five fields through', () => {
    const task = makeTask({
      metadata: { useWorktree: false, useLocalBranch: true, pushNewBranches: false },
    });
    expect(buildExecutionOptions(task, 'dev')).toEqual({
      parallel: false,
      workers: 1,
      baseBranch: 'dev',
      useWorktree: false,
      useLocalBranch: true,
      pushNewBranches: false,
    });
  });
  it('handles undefined metadata', () => {
    expect(buildExecutionOptions(makeTask(), undefined)).toEqual({
      parallel: false,
      workers: 1,
      baseBranch: undefined,
      useWorktree: undefined,
      useLocalBranch: undefined,
      pushNewBranches: undefined,
    });
  });
});

describe('resolveBaseBranch', () => {
  it('prefers task_metadata.json, then project setting, then main', () => {
    fs.writeFileSync(path.join(specDir, 'task_metadata.json'), JSON.stringify({ baseBranch: 'feat' }));
    expect(resolveBaseBranch(makeTask(), makeProject())).toBe('feat');
    fs.rmSync(path.join(specDir, 'task_metadata.json'));
    expect(resolveBaseBranch(makeTask(), makeProject({ settings: { mainBranch: 'dev' } }))).toBe('dev');
    expect(resolveBaseBranch(makeTask(), makeProject({ settings: undefined }))).toBe('main');
  });

  it('strips a leading origin/ from the stored base branch', () => {
    fs.writeFileSync(path.join(specDir, 'task_metadata.json'), JSON.stringify({ baseBranch: 'origin/feat/x' }));
    expect(resolveBaseBranch(makeTask(), makeProject())).toBe('feat/x');
  });
});

describe('launchTask', () => {
  const run = (task = makeTask(), extra: object = {}) =>
    launchTask({ task, project: makeProject(), agentManager, logTag: '[TEST]', ...extra });

  it('starts spec creation when there is no spec', () => {
    fs.writeFileSync(path.join(specDir, 'task_metadata.json'), JSON.stringify({ baseBranch: 'feat' }));
    const task = makeTask({ metadata: { baseBranch: 'feat' } });
    const result = run(task);
    expect(agentManager.startSpecCreation).toHaveBeenCalledWith(
      't1', root, 'Desc', specDir, task.metadata, 'feat', 'p1'
    );
    expect(agentManager.startTaskExecution).not.toHaveBeenCalled();
    expect(result).toEqual({ mode: 'spec_creation', hasSpec: false, planHasSubtasks: false });
  });

  it('falls back to the title when there is no description', () => {
    run(makeTask({ description: '' }));
    expect(agentManager.startSpecCreation.mock.calls[0][2]).toBe('Title');
  });

  it('plans when the spec exists without subtasks', () => {
    writeSpec();
    const result = run();
    expect(agentManager.startTaskExecution).toHaveBeenCalledTimes(1);
    expect(agentManager.startSpecCreation).not.toHaveBeenCalled();
    expect(result.mode).toBe('planning');
  });

  it('executes when the plan has subtasks', () => {
    writeSpec();
    writePlan(WITH_SUBTASKS);
    const result = run();
    expect(agentManager.startTaskExecution).toHaveBeenCalledTimes(1);
    expect(agentManager.startTaskExecution).toHaveBeenCalledWith(
      't1', root, '001-x', buildExecutionOptions(makeTask(), 'main'), 'p1'
    );
    expect(result).toEqual({ mode: 'execution', hasSpec: true, planHasSubtasks: true });
  });

  it('treats a corrupt plan as having no subtasks', () => {
    writeSpec();
    writePlan('{oops');
    expect(run().mode).toBe('planning');
  });

  it('respects a precomputed planHasSubtasks', () => {
    writeSpec();
    writePlan(WITH_SUBTASKS);
    expect(run(makeTask(), { planHasSubtasks: false }).mode).toBe('planning');
  });

  it('watches the main spec dir by default', () => {
    run();
    expect(watcher.watch).toHaveBeenCalledWith('t1', specDir);
  });

  it('watches the worktree spec dir when one has a plan', () => {
    const wt = path.join(root, 'wt');
    const wtSpec = path.join(wt, '.auto-claude', 'specs', '001-x');
    fs.mkdirSync(wtSpec, { recursive: true });
    fs.writeFileSync(path.join(wtSpec, 'implementation_plan.json'), '{}');
    worktree.find.mockReturnValue(wt);
    run();
    expect(watcher.watch).toHaveBeenCalledWith('t1', wtSpec);
  });

  it('logs a failed watch with the caller tag', async () => {
    watcher.watch.mockReturnValueOnce(Promise.reject(new Error('boom')));
    run();
    await Promise.resolve();
    await Promise.resolve();
    expect(console.error).toHaveBeenCalledWith('[TEST] Failed to watch spec dir for t1:', expect.any(Error));
  });
});

describe('preflightTaskLaunch', () => {
  const profile = (valid: boolean) => ({ hasValidAuth: () => valid });

  it('rejects a non-repo', async () => {
    git.checkGitStatus.mockReturnValue({ isGitRepo: false, hasCommits: false });
    const r = await preflightTaskLaunch(makeTask(), makeProject());
    expect(r).toEqual({
      ok: false,
      error: 'Git repository required. Please run "git init" in your project directory. Aperant uses git worktrees for isolated builds.',
    });
  });

  it('rejects a repo without commits', async () => {
    git.checkGitStatus.mockReturnValue({ isGitRepo: true, hasCommits: false });
    const r = await preflightTaskLaunch(makeTask(), makeProject());
    expect(r).toEqual({
      ok: false,
      error: 'Git repository has no commits. Please make an initial commit first (git add . && git commit -m "Initial commit").',
    });
  });

  it('passes through a profile init failure', async () => {
    auth.init.mockRejectedValue(new Error('disk full'));
    const r = await preflightTaskLaunch(makeTask(), makeProject());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('Failed to initialize profile manager');
    expect(!r.ok && r.error).toContain('disk full');
  });

  it('rejects when there is no auth', async () => {
    auth.init.mockResolvedValue(profile(false));
    const r = await preflightTaskLaunch(makeTask(), makeProject());
    expect(r).toEqual({
      ok: false,
      error: 'Authentication required. Please add an account in Settings > Accounts before starting tasks.',
    });
  });

  it('accepts a provider account without a valid profile', async () => {
    auth.init.mockResolvedValue(profile(false));
    settings.value = { providerAccounts: [{ id: 'a' }] };
    expect((await preflightTaskLaunch(makeTask(), makeProject())).ok).toBe(true);
  });

  it('returns the profile manager on success', async () => {
    const pm = profile(true);
    auth.init.mockResolvedValue(pm);
    const r = await preflightTaskLaunch(makeTask(), makeProject());
    expect(r).toEqual({ ok: true, profileManager: pm });
  });
});
