import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import { FileEvolutionTracker, pruneFinishedTask } from '../file-evolution';

describe('FileEvolutionTracker', () => {
  let root: string;
  let projectDir: string;
  let storageDir: string;

  const write = (rel: string, content: string) => {
    const full = path.join(projectDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  };
  const make = () => new FileEvolutionTracker(projectDir, storageDir);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-evolution-'));
    projectDir = path.join(root, 'project');
    storageDir = path.join(root, 'storage');
    fs.mkdirSync(projectDir, { recursive: true });
    write('src/a.ts', 'export const a = 1;\n');
    write('src/b.ts', 'export const b = 1;\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('captures baselines for an explicit file list and skips missing files', () => {
    const tracker = make();
    const captured = tracker.captureBaselines('t1', ['src/a.ts', 'src/missing.ts'], 'intent');

    expect([...captured.keys()]).toEqual(['src/a.ts']);
    expect(tracker.getBaselineContent('src/a.ts')).toBe('export const a = 1;\n');
    const evo = tracker.getFileEvolution('src/a.ts')!;
    expect(evo.taskSnapshots).toHaveLength(1);
    expect(evo.taskSnapshots[0].taskIntent).toBe('intent');
    expect(fs.existsSync(tracker.evolutionFile)).toBe(true);
    expect(fs.existsSync(path.join(tracker.baselinesDir, 't1'))).toBe(true);
  });

  it('recordModification returns undefined for unknown files', () => {
    const tracker = make();
    expect(tracker.recordModification('t1', 'src/a.ts', 'x', 'y')).toBeUndefined();
  });

  it('recordModification stores changes, hash and raw diff', () => {
    const tracker = make();
    tracker.captureBaselines('t1', ['src/a.ts']);
    const oldC = 'export const a = 1;\n';
    const newC = 'import x from "x";\nexport const a = 1;\n';
    const snap = tracker.recordModification('t1', 'src/a.ts', oldC, newC, 'RAWDIFF')!;

    expect(snap.contentHashAfter).not.toBe('');
    expect(snap.rawDiff).toBe('RAWDIFF');
    expect(snap.completedAt).toBeInstanceOf(Date);
    expect(snap.semanticChanges.length).toBeGreaterThan(0);

    const skipped = tracker.recordModification('t1', 'src/a.ts', oldC, newC, undefined, true)!;
    expect(skipped.semanticChanges).toEqual([]);
  });

  it('getTaskModifications only lists modified files', () => {
    const tracker = make();
    tracker.captureBaselines('t1', ['src/a.ts', 'src/b.ts']);
    expect(tracker.getTaskModifications('t1')).toEqual([]);
    tracker.recordModification('t1', 'src/a.ts', 'export const a = 1;\n', 'export const a = 2;\nexport const z = 3;\n');
    const mods = tracker.getTaskModifications('t1');
    expect(mods.map(([f]) => f)).toEqual(['src/a.ts']);
  });

  it('getFilesModifiedByTasks and getConflictingFiles detect overlap', () => {
    const tracker = make();
    tracker.captureBaselines('t1', ['src/a.ts', 'src/b.ts']);
    tracker.captureBaselines('t2', ['src/a.ts', 'src/b.ts']);
    tracker.recordModification('t1', 'src/a.ts', 'export const a = 1;\n', 'export const a = 2;\n');
    tracker.recordModification('t2', 'src/a.ts', 'export const a = 1;\n', 'export const a = 3;\n');
    tracker.recordModification('t1', 'src/b.ts', 'export const b = 1;\n', 'export const b = 2;\n');

    const map = tracker.getFilesModifiedByTasks(['t1', 't2']);
    expect(map.get('src/a.ts')).toEqual(['t1', 't2']);
    expect(map.get('src/b.ts')).toEqual(['t1']);
    expect(tracker.getConflictingFiles(['t1', 't2'])).toEqual(['src/a.ts']);
    expect(tracker.getConflictingFiles(['t1'])).toEqual([]);
  });

  it('markTaskCompleted removes the task from active tasks', () => {
    const tracker = make();
    tracker.captureBaselines('t1', ['src/a.ts']);
    tracker.captureBaselines('t2', ['src/a.ts']);
    expect(tracker.getActiveTasks()).toEqual(new Set(['t1', 't2']));
    tracker.markTaskCompleted('t1');
    expect(tracker.getActiveTasks()).toEqual(new Set(['t2']));
  });

  it('cleanupTask removes snapshots, baselines and empty evolutions', () => {
    const tracker = make();
    tracker.captureBaselines('t1', ['src/a.ts']);
    tracker.captureBaselines('t2', ['src/a.ts', 'src/b.ts']);
    tracker.cleanupTask('t1');

    expect(fs.existsSync(path.join(tracker.baselinesDir, 't1'))).toBe(false);
    expect(fs.existsSync(path.join(tracker.baselinesDir, 't2'))).toBe(true);
    expect(tracker.getFileEvolution('src/a.ts')!.taskSnapshots.map((s) => s.taskId)).toEqual(['t2']);

    tracker.cleanupTask('t2');
    expect(tracker.getFileEvolution('src/a.ts')).toBeUndefined();
    expect(tracker.getFileEvolution('src/b.ts')).toBeUndefined();
  });

  it('cleanupTask can keep baselines', () => {
    const tracker = make();
    tracker.captureBaselines('t1', ['src/a.ts']);
    tracker.cleanupTask('t1', false);
    expect(fs.existsSync(path.join(tracker.baselinesDir, 't1'))).toBe(true);
    expect(tracker.getActiveTasks().size).toBe(0);
  });

  it('getEvolutionSummary reports counts', () => {
    const tracker = make();
    tracker.captureBaselines('t1', ['src/a.ts', 'src/b.ts']);
    tracker.captureBaselines('t2', ['src/a.ts']);
    tracker.recordModification('t1', 'src/a.ts', 'export const a = 1;\n', 'import x from "x";\nexport const a = 1;\n');
    const summary = tracker.getEvolutionSummary();
    expect(summary.total_files_tracked).toBe(2);
    expect(summary.total_tasks).toBe(2);
    expect(summary.files_with_potential_conflicts).toBe(1);
    expect(summary.active_tasks).toBe(2); // t1 still active via b.ts, t2 via a.ts
    expect(summary.total_semantic_changes as number).toBeGreaterThan(0);
  });

  it('persists to file_evolution.json and reloads in a new tracker', () => {
    const tracker = make();
    tracker.captureBaselines('t1', ['src/a.ts'], 'my intent');
    tracker.recordModification('t1', 'src/a.ts', 'export const a = 1;\n', 'export const a = 2;\n', 'DIFF');

    const reloaded = make();
    const evo = reloaded.getFileEvolution('src/a.ts')!;
    expect(evo).toBeDefined();
    expect(evo.taskSnapshots[0].taskIntent).toBe('my intent');
    expect(evo.taskSnapshots[0].rawDiff).toBe('DIFF');
    expect(reloaded.getBaselineContent('src/a.ts')).toBe('export const a = 1;\n');
  });

  it('ignores a corrupt evolution file', () => {
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(path.join(storageDir, 'file_evolution.json'), '{not json', 'utf8');
    expect(make().getActiveTasks().size).toBe(0);
  });

  it('normalises absolute and relative paths to the same key', () => {
    const tracker = make();
    tracker.captureBaselines('t1', [path.join(projectDir, 'src/a.ts')]);
    expect(tracker.getFileEvolution('src/a.ts')).toBeDefined();
    expect(tracker.getFileEvolution(path.join(projectDir, 'src', 'a.ts'))).toBeDefined();
    expect(tracker.getFileEvolution('src\\a.ts')).toBeDefined();
    expect(
      tracker.recordModification('t1', path.join(projectDir, 'src/a.ts'), 'a', 'b', undefined, true),
    ).toBeDefined();
  });
  describe('pruning', () => {
    const evoJson = () => fs.readFileSync(path.join(storageDir, 'file_evolution.json'), 'utf8');

    it('pruning a merged task removes its entries and keeps other tasks', () => {
      write('src/only1.ts', 'export const o = 1;\n');
      const tracker = make();
      tracker.captureBaselines('t1', ['src/a.ts', 'src/b.ts', 'src/only1.ts']);
      tracker.captureBaselines('t2', ['src/a.ts', 'src/b.ts']);
      tracker.recordModification('t1', 'src/a.ts', 'export const a = 1;\n', 'export const a = 2;\n', 'D1');
      tracker.recordModification('t2', 'src/a.ts', 'export const a = 1;\n', 'export const a = 3;\n', 'D2');

      pruneFinishedTask(projectDir, storageDir, 't1');

      const reloaded = make();
      const evo = reloaded.getFileEvolution('src/a.ts')!;
      expect(evo.taskSnapshots.map((s) => s.taskId)).toEqual(['t2']);
      expect(evo.taskSnapshots[0].rawDiff).toBe('D2');
      expect(reloaded.getFileEvolution('src/only1.ts')).toBeUndefined();
      expect(fs.existsSync(path.join(storageDir, 'baselines', 't1'))).toBe(false);
      expect(fs.existsSync(path.join(storageDir, 'baselines', 't2'))).toBe(true);
      expect(evoJson()).not.toContain('only1.ts');
    });

    it('pruneFinishedTask is a no-op when nothing is stored', () => {
      expect(() => pruneFinishedTask(projectDir, storageDir, 't1')).not.toThrow();
      expect(fs.existsSync(storageDir)).toBe(false);
    });

    it('pruneFinishedTask swallows errors', () => {
      fs.writeFileSync(storageDir, 'i am a file', 'utf8');
      expect(() => pruneFinishedTask(projectDir, storageDir, 't1')).not.toThrow();
      fs.rmSync(storageDir, { force: true });
      fs.mkdirSync(storageDir, { recursive: true });
      fs.writeFileSync(path.join(storageDir, 'file_evolution.json'), '{not json', 'utf8');
      expect(() => pruneFinishedTask(projectDir, storageDir, 't1')).not.toThrow();
    });

    it('pruneOrphanedTasks drops tasks with no spec folder', () => {
      const tracker = make();
      tracker.captureBaselines('t1', ['src/a.ts']);
      tracker.captureBaselines('t2', ['src/a.ts']);
      fs.mkdirSync(path.join(storageDir, 'specs', 't2'), { recursive: true });

      const fresh = make();
      const evo = fresh.getFileEvolution('src/a.ts')!;
      expect(evo.taskSnapshots.map((s) => s.taskId)).toEqual(['t2']);
      expect(fs.existsSync(path.join(storageDir, 'baselines', 't1'))).toBe(false);
      expect(fs.existsSync(path.join(storageDir, 'baselines', 't2'))).toBe(true);
      expect(evoJson()).not.toContain('"t1"');
    });

    it('orphan pass keeps tasks that only have a worktree folder', () => {
      const tracker = make();
      tracker.captureBaselines('t2', ['src/a.ts']);
      tracker.captureBaselines('t3', ['src/a.ts']);
      fs.mkdirSync(path.join(storageDir, 'specs', 't2'), { recursive: true });
      fs.mkdirSync(path.join(storageDir, 'worktrees', 'tasks', 't3'), { recursive: true });

      const ids = make().getFileEvolution('src/a.ts')!.taskSnapshots.map((s) => s.taskId);
      expect(ids.sort()).toEqual(['t2', 't3']);
    });

    it('orphan pass is skipped when there is no specs directory', () => {
      make().captureBaselines('t1', ['src/a.ts']);
      const ids = make().getFileEvolution('src/a.ts')!.taskSnapshots.map((s) => s.taskId);
      expect(ids).toEqual(['t1']);
    });

    it('orphan pass does not rewrite the file when nothing is orphaned', () => {
      make().captureBaselines('t1', ['src/a.ts']);
      fs.mkdirSync(path.join(storageDir, 'specs', 't1'), { recursive: true });
      const file = path.join(storageDir, 'file_evolution.json');
      const old = new Date(2020, 0, 1);
      fs.utimesSync(file, old, old);
      const before = fs.readFileSync(file, 'utf8');

      make();

      expect(fs.statSync(file).mtimeMs).toBe(old.getTime());
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    });
  });
});

// =============================================================================
// refreshFromGit — real git repo + worktree
// =============================================================================

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function writeIn(dir: string, rel: string, content: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function commitAll(dir: string, message: string): void {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', message);
}

describe('FileEvolutionTracker.refreshFromGit', () => {
  let root: string;
  let projectDir: string;
  let storageDir: string;
  let worktree: string;

  const make = () => new FileEvolutionTracker(projectDir, storageDir);
  const spySave = (tracker: FileEvolutionTracker) =>
    // biome-ignore lint/suspicious/noExplicitAny: accessing private storage for spying
    vi.spyOn((tracker as any).storage, 'saveEvolutions');

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-evolution-git-'));
    projectDir = path.join(root, 'project');
    storageDir = path.join(root, 'storage');
    worktree = path.join(root, 'wt');
    fs.mkdirSync(projectDir, { recursive: true });
    git(projectDir, 'init', '-b', 'main');
    git(projectDir, 'config', 'user.name', 'Test');
    git(projectDir, 'config', 'user.email', 'test@example.com');
    writeIn(projectDir, 'src/a.ts', 'export const a = 1;\n');
    writeIn(projectDir, 'src/b.ts', 'export const b = 1;\n');
    writeIn(projectDir, 'src/c.ts', 'export const c = 1;\n');
    commitAll(projectDir, 'baseline');
    git(projectDir, 'worktree', 'add', worktree, '-b', 'task-branch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Committed modification (a), new committed file (new.ts), uncommitted edit (b). */
  const changeSeveralFiles = () => {
    writeIn(worktree, 'src/a.ts', 'import x from "x";\nexport const a = 2;\n');
    writeIn(worktree, 'src/new.ts', 'import y from "y";\nexport const n = 1;\n');
    commitAll(worktree, 'task work');
    writeIn(worktree, 'src/b.ts', 'import z from "z";\nexport const b = 5;\n');
  };

  it('persists exactly once per refresh and records every changed file', async () => {
    changeSeveralFiles();
    const tracker = make();
    const save = spySave(tracker);

    await tracker.refreshFromGit('t1', worktree, 'main');

    expect(save).toHaveBeenCalledTimes(1);
    const mods = tracker.getTaskModifications('t1');
    expect(mods.map(([f]) => f).sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/new.ts']);

    const byFile = new Map(mods);
    expect(byFile.get('src/a.ts')!.rawDiff).toBeTruthy();
    expect(byFile.get('src/new.ts')!.contentHashBefore).not.toBe('');
    expect(byFile.get('src/new.ts')!.contentHashAfter).not.toBe('');

    await tracker.refreshFromGit('t1', worktree, 'main');
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('writes file_evolution.json once per refresh', async () => {
    changeSeveralFiles();
    const tracker = make();
    const spy = vi.spyOn(fs, 'writeFileSync');
    try {
      await tracker.refreshFromGit('t1', worktree, 'main');
      const evoWrites = spy.mock.calls.filter((c) => String(c[0]).endsWith('file_evolution.json'));
      expect(evoWrites).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('skips semantic analysis for files outside analyzeOnlyFiles', async () => {
    changeSeveralFiles();
    const tracker = make();
    await tracker.refreshFromGit('t1', worktree, 'main', new Set(['src/a.ts']));

    const byFile = new Map(tracker.getTaskModifications('t1'));
    expect(byFile.size).toBe(3);
    expect(byFile.get('src/a.ts')!.semanticChanges.length).toBeGreaterThan(0);
    expect(byFile.get('src/b.ts')!.semanticChanges).toEqual([]);
    expect(byFile.get('src/new.ts')!.semanticChanges).toEqual([]);
  });

  it('writes compact JSON that a new tracker reloads', async () => {
    changeSeveralFiles();
    const tracker = make();
    await tracker.refreshFromGit('t1', worktree, 'main');

    const raw = fs.readFileSync(tracker.evolutionFile, 'utf8');
    expect(raw).not.toContain('\n  ');
    expect(JSON.stringify(JSON.parse(raw))).toBe(raw);

    const reloaded = make();
    expect(reloaded.getTaskModifications('t1').map(([f]) => f).sort()).toEqual(
      tracker.getTaskModifications('t1').map(([f]) => f).sort(),
    );
  });

  it('still loads a pretty-printed legacy evolution file', async () => {
    changeSeveralFiles();
    const tracker = make();
    await tracker.refreshFromGit('t1', worktree, 'main');
    const parsed = JSON.parse(fs.readFileSync(tracker.evolutionFile, 'utf8'));
    fs.writeFileSync(tracker.evolutionFile, JSON.stringify(parsed, null, 2), 'utf8');

    const reloaded = make();
    expect(reloaded.getTaskModifications('t1')).toHaveLength(3);
  });

  it('recordModification still saves once per call', () => {
    const tracker = make();
    tracker.captureBaselines('t1', ['src/a.ts']);
    const save = spySave(tracker);

    tracker.recordModification('t1', 'src/a.ts', 'export const a = 1;\n', 'export const a = 2;\n');
    expect(save).toHaveBeenCalledTimes(1);
    tracker.recordModification('t1', 'src/a.ts', 'export const a = 1;\n', 'export const a = 3;\n');
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('records all files when more than the concurrency bound changed', async () => {
    for (let i = 0; i < 20; i++) writeIn(worktree, `src/gen/f${i}.ts`, `export const v${i} = ${i};\n`);
    commitAll(worktree, 'many files');
    const tracker = make();
    const save = spySave(tracker);

    await tracker.refreshFromGit('t1', worktree, 'main');

    const files = tracker.getTaskModifications('t1').map(([f]) => f);
    expect(files).toHaveLength(20);
    expect(new Set(files).size).toBe(20);
    expect(save).toHaveBeenCalledTimes(1);
  }, 30000);
});
