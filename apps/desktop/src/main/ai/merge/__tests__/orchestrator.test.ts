import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import { MergeOrchestrator, type MergeReport } from '../orchestrator';
import { MergeDecision, type MergeResult } from '../types';

// =============================================================================
// Real git repo helpers
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

function write(dir: string, rel: string, content: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function commitAll(dir: string, message: string): void {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', message);
}

const BASELINE_APP = `import React from 'react';

function App(): JSX.Element {
  return <div>Hello</div>;
}

export default App;
`;

interface Fixture {
  root: string;
  projectDir: string;
  storageDir: string;
  worktree(name: string): string;
}

function createRepo(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-orch-'));
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(projectDir);
  git(projectDir, 'init', '-b', 'main');
  git(projectDir, 'config', 'user.name', 'Test');
  git(projectDir, 'config', 'user.email', 'test@example.com');
  write(projectDir, 'src/App.tsx', BASELINE_APP);
  commitAll(projectDir, 'baseline');
  return {
    root,
    projectDir,
    storageDir: path.join(root, '.auto-claude'),
    worktree: (name: string) => path.join(root, name),
  };
}

function addWorktree(fx: Fixture, name: string, branch: string): string {
  const dir = fx.worktree(name);
  git(fx.projectDir, 'worktree', 'add', dir, '-b', branch);
  return dir;
}

function makeOrchestrator(fx: Fixture, dryRun: boolean): MergeOrchestrator {
  return new MergeOrchestrator({
    projectDir: fx.projectDir,
    storageDir: fx.storageDir,
    enableAi: false,
    dryRun,
  });
}

function appWithHook(hook: string): string {
  return BASELINE_APP.replace(
    '  return <div>Hello</div>;',
    `  ${hook}\n  return <div>Hello</div>;`,
  );
}

// =============================================================================
// Tests
// =============================================================================

describe('MergeOrchestrator (real git repo)', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = createRepo();
  });

  afterEach(() => {
    // Worktrees live under root, so removing root cleans everything
    fs.rmSync(fx.root, { recursive: true, force: true });
  });

  describe('previewMerge', () => {
    it('lists files and flags a file edited by two tasks', async () => {
      const wtA = addWorktree(fx, 'wt-a', 'task-a');
      const wtB = addWorktree(fx, 'wt-b', 'task-b');

      write(wtA, 'src/App.tsx', appWithHook('const [a, setA] = useState(0);'));
      write(wtA, 'src/only-a.ts', 'export const a = 1;\n');
      commitAll(wtA, 'task a');
      write(wtB, 'src/App.tsx', appWithHook('const [b, setB] = useState(1);'));
      commitAll(wtB, 'task b');

      const orchestrator = makeOrchestrator(fx, true);
      await orchestrator.evolutionTracker.refreshFromGit('task-a', wtA, 'main');
      await orchestrator.evolutionTracker.refreshFromGit('task-b', wtB, 'main');

      const preview = orchestrator.previewMerge(['task-a', 'task-b']) as {
        tasks: string[];
        files_to_merge: string[];
        files_with_potential_conflicts: string[];
        conflicts: Array<Record<string, unknown>>;
        summary: Record<string, number>;
      };

      expect(preview.tasks).toEqual(['task-a', 'task-b']);
      expect([...preview.files_to_merge].sort()).toEqual(['src/App.tsx', 'src/only-a.ts']);
      expect(preview.files_with_potential_conflicts).toEqual(['src/App.tsx']);

      expect(preview.summary.total_files).toBe(2);
      expect(preview.summary.conflict_files).toBe(1);
      expect(preview.summary.total_conflicts).toBe(preview.conflicts.length);
      expect(preview.summary.auto_mergeable).toBe(
        preview.conflicts.filter((c) => c['can_auto_merge'] === true).length,
      );
      for (const c of preview.conflicts) {
        expect(c['file']).toBe('src/App.tsx');
        expect(typeof c['can_auto_merge']).toBe('boolean');
        if (c['can_auto_merge'] === true) expect(c['strategy']).not.toBeNull();
      }
    });

    it('reports no potential conflicts when tasks touch different files', async () => {
      const wtA = addWorktree(fx, 'wt-a', 'task-a');
      const wtB = addWorktree(fx, 'wt-b', 'task-b');

      write(wtA, 'src/a.ts', 'export const a = 1;\n');
      commitAll(wtA, 'task a');
      write(wtB, 'src/b.ts', 'export const b = 2;\n');
      commitAll(wtB, 'task b');

      const orchestrator = makeOrchestrator(fx, true);
      await orchestrator.evolutionTracker.refreshFromGit('task-a', wtA, 'main');
      await orchestrator.evolutionTracker.refreshFromGit('task-b', wtB, 'main');

      const preview = orchestrator.previewMerge(['task-a', 'task-b']) as {
        files_to_merge: string[];
        files_with_potential_conflicts: string[];
        conflicts: unknown[];
        summary: Record<string, number>;
      };

      expect([...preview.files_to_merge].sort()).toEqual(['src/a.ts', 'src/b.ts']);
      expect(preview.files_with_potential_conflicts).toEqual([]);
      expect(preview.conflicts).toEqual([]);
      expect(preview.summary).toEqual({
        total_files: 2,
        conflict_files: 0,
        total_conflicts: 0,
        auto_mergeable: 0,
      });
    });
  });

  describe('mergeTask', () => {
    it('uses DIRECT_COPY with the worktree file as mergedContent for a single task', async () => {
      const wtA = addWorktree(fx, 'wt-a', 'task-a');
      const changed = "import { useState } from 'react';\n" + BASELINE_APP;
      write(wtA, 'src/App.tsx', changed);
      commitAll(wtA, 'task a');

      const orchestrator = makeOrchestrator(fx, true);
      const report = await orchestrator.mergeTask('task-a', wtA, 'main');

      expect(report.success).toBe(true);
      expect(report.tasksMerged).toEqual(['task-a']);
      const result = report.fileResults.get('src/App.tsx');
      expect(result).toBeDefined();
      expect(result?.decision).toBe(MergeDecision.DIRECT_COPY);
      expect(result?.mergedContent).toBe(changed);
      expect(report.stats.filesProcessed).toBe(1);
      expect(report.stats.filesAutoMerged).toBe(1);
    });

    it('does not write a report in dry-run mode', async () => {
      const wtA = addWorktree(fx, 'wt-a', 'task-a');
      write(wtA, 'src/new.ts', 'export const x = 1;\n');
      commitAll(wtA, 'task a');

      await makeOrchestrator(fx, true).mergeTask('task-a', wtA, 'main');

      expect(fs.existsSync(path.join(fx.storageDir, 'merge_reports'))).toBe(false);
    });

    it('succeeds with no file results when the worktree has no changes', async () => {
      const wtA = addWorktree(fx, 'wt-a', 'task-a');

      const report = await makeOrchestrator(fx, true).mergeTask('task-a', wtA, 'main');

      expect(report.success).toBe(true);
      expect(report.fileResults.size).toBe(0);
      expect(report.stats.filesProcessed).toBe(0);
    });
  });

  describe('mergeTasks regression: two hooks in a typed function', () => {
    it('never reports AUTO_MERGED with a missing hook', async () => {
      const wtA = addWorktree(fx, 'wt-a', 'task-a');
      const wtB = addWorktree(fx, 'wt-b', 'task-b');
      const hookA = 'const [countA, setCountA] = useState(0);';
      const hookB = 'const nameB = useMemo(() => "b", []);';

      write(wtA, 'src/App.tsx', appWithHook(hookA));
      commitAll(wtA, 'task a');
      write(wtB, 'src/App.tsx', appWithHook(hookB));
      commitAll(wtB, 'task b');

      const orchestrator = makeOrchestrator(fx, true);
      const report = await orchestrator.mergeTasks(
        [
          { taskId: 'task-a', worktreePath: wtA, priority: 1 },
          { taskId: 'task-b', worktreePath: wtB, priority: 0 },
        ],
        'main',
      );

      const result = report.fileResults.get('src/App.tsx') as MergeResult | undefined;
      expect(result).toBeDefined();
      const content = result?.mergedContent ?? '';
      const hasBoth = content.includes(hookA) && content.includes(hookB);
      const failedOrReview =
        result?.decision === MergeDecision.FAILED ||
        result?.decision === MergeDecision.NEEDS_HUMAN_REVIEW;

      if (!hasBoth) {
        // A merge missing a hook must be surfaced, never reported as success
        expect(failedOrReview).toBe(true);
        expect(
          report.success === false || (result?.conflictsRemaining.length ?? 0) > 0,
        ).toBe(true);
      }
      if (result?.decision === MergeDecision.AUTO_MERGED) {
        expect(hasBoth).toBe(true);
      }
    });
  });

  describe('applyToProject', () => {
    function makeReport(results: Array<[string, MergeResult]>): MergeReport {
      return {
        success: true,
        startedAt: new Date(),
        tasksMerged: ['task-a'],
        fileResults: new Map(results),
        stats: {} as MergeReport['stats'],
      };
    }

    function result(filePath: string, decision: MergeDecision, content?: string): MergeResult {
      return {
        decision,
        filePath,
        mergedContent: content,
        conflictsResolved: [],
        conflictsRemaining: [],
        aiCallsMade: 0,
        tokensUsed: 0,
        explanation: '',
      };
    }

    it('does not write a FAILED result to disk but writes successful ones', () => {
      const orchestrator = makeOrchestrator(fx, false);
      const report = makeReport([
        ['src/App.tsx', result('src/App.tsx', MergeDecision.FAILED, 'BROKEN CONTENT')],
        ['src/ok.ts', result('src/ok.ts', MergeDecision.AUTO_MERGED, 'export const ok = 1;\n')],
      ]);

      expect(orchestrator.applyToProject(report)).toBe(true);

      expect(fs.readFileSync(path.join(fx.projectDir, 'src/App.tsx'), 'utf8')).toBe(BASELINE_APP);
      expect(fs.readFileSync(path.join(fx.projectDir, 'src/ok.ts'), 'utf8')).toBe(
        'export const ok = 1;\n',
      );
    });

    it('writes nothing in dry-run mode', () => {
      const orchestrator = makeOrchestrator(fx, true);
      const report = makeReport([
        ['src/ok.ts', result('src/ok.ts', MergeDecision.AUTO_MERGED, 'x\n')],
      ]);

      expect(orchestrator.applyToProject(report)).toBe(true);
      expect(fs.existsSync(path.join(fx.projectDir, 'src/ok.ts'))).toBe(false);
    });
  });
});
