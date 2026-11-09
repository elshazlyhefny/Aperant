import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { FileEvolutionTracker } from '../file-evolution';

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
});
