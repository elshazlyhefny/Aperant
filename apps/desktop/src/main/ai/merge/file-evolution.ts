/**
 * File Evolution Tracker
 * ======================
 *
 * Tracks file modification history across task modifications.
 * See apps/desktop/src/main/ai/merge/file-evolution.ts for the TypeScript implementation.
 *
 * Manages:
 * - Baseline capture when worktrees are created
 * - File content snapshots in .auto-claude/baselines/
 * - Task modification tracking with semantic analysis
 * - Persistence of evolution data
 */

import fs from 'fs';
import path from 'path';
import { execFile, spawnSync } from 'child_process';
import { promisify } from 'util';

import { SemanticAnalyzer } from './semantic-analyzer';
import {
  type FileEvolution,
  type TaskSnapshot,
  addTaskSnapshot,
  computeContentHash,
  fileEvolutionFromDict,
  fileEvolutionToDict,
  getTaskSnapshot,
  sanitizePathForStorage,
  taskSnapshotHasModifications,
} from './types';

// =============================================================================
// Default file extensions to track
// =============================================================================

export const DEFAULT_EXTENSIONS = new Set([
  '.py', '.js', '.ts', '.tsx', '.jsx',
  '.json', '.yaml', '.yml', '.toml',
  '.md', '.txt', '.html', '.css', '.scss',
  '.go', '.rs', '.java', '.kt', '.swift',
]);

// =============================================================================
// Storage
// =============================================================================

class EvolutionStorage {
  readonly projectDir: string;
  readonly storageDir: string;
  readonly baselinesDir: string;
  readonly evolutionFile: string;

  constructor(projectDir: string, storageDir: string) {
    this.projectDir = path.resolve(projectDir);
    this.storageDir = path.resolve(storageDir);
    this.baselinesDir = path.join(this.storageDir, 'baselines');
    this.evolutionFile = path.join(this.storageDir, 'file_evolution.json');

    fs.mkdirSync(this.storageDir, { recursive: true });
    fs.mkdirSync(this.baselinesDir, { recursive: true });
  }

  loadEvolutions(): Map<string, FileEvolution> {
    if (!fs.existsSync(this.evolutionFile)) return new Map();

    try {
      const data = JSON.parse(fs.readFileSync(this.evolutionFile, 'utf8'));
      const evolutions = new Map<string, FileEvolution>();
      for (const [filePath, evolutionData] of Object.entries(data)) {
        evolutions.set(filePath, fileEvolutionFromDict(evolutionData as Record<string, unknown>));
      }
      return evolutions;
    } catch {
      return new Map();
    }
  }

  saveEvolutions(evolutions: Map<string, FileEvolution>): void {
    try {
      const data: Record<string, unknown> = {};
      for (const [filePath, evolution] of evolutions) {
        data[filePath] = fileEvolutionToDict(evolution);
      }
      fs.writeFileSync(this.evolutionFile, JSON.stringify(data), 'utf8');
    } catch {
      // Non-fatal persistence failure
    }
  }

  storeBaselineContent(filePath: string, content: string, taskId: string): string {
    const safeName = sanitizePathForStorage(filePath);
    const baselineDir = path.join(this.baselinesDir, taskId);
    const baselinePath = path.join(baselineDir, `${safeName}.baseline`);

    fs.mkdirSync(baselineDir, { recursive: true });
    fs.writeFileSync(baselinePath, content, 'utf8');

    return path.relative(this.storageDir, baselinePath);
  }

  readBaselineContent(baselineSnapshotPath: string): string | undefined {
    const baselinePath = path.join(this.storageDir, baselineSnapshotPath);
    if (!fs.existsSync(baselinePath)) return undefined;

    try {
      return fs.readFileSync(baselinePath, 'utf8');
    } catch {
      return undefined;
    }
  }

  readFileContent(filePath: string): string | undefined {
    try {
      const p = path.isAbsolute(filePath) ? filePath : path.join(this.projectDir, filePath);
      return fs.readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  }

  getRelativePath(filePath: string): string {
    // If the path is already relative (e.g., from git diff output), just normalize slashes.
    // Git always outputs paths relative to the repo root, which is what we want.
    // Using path.relative() on a non-absolute path resolves against CWD (the Electron
    // app directory), producing incorrect traversal paths.
    if (!path.isAbsolute(filePath)) {
      return filePath.replace(/\\/g, '/');
    }
    try {
      return path.relative(this.projectDir, path.resolve(filePath)).replace(/\\/g, '/');
    } catch {
      return filePath.replace(/\\/g, '/');
    }
  }
}

// =============================================================================
// Git helpers
// =============================================================================

function runGit(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function tryRunGit(args: string[], cwd: string): string | null {
  try {
    return runGit(args, cwd);
  } catch {
    return null;
  }
}

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const GIT_CONCURRENCY = 8;

async function runGitAsync(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout.trim();
}

async function tryRunGitAsync(args: string[], cwd: string): Promise<string | null> {
  try {
    return await runGitAsync(args, cwd);
  } catch {
    return null;
  }
}

/** Run `fn` over items with at most `limit` in flight; results keep input order (undefined on failure). */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array(items.length).fill(undefined);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const idx = next++;
      try {
        results[idx] = await fn(items[idx]);
      } catch {
        results[idx] = undefined;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function getCurrentCommit(cwd: string): string {
  return tryRunGit(['rev-parse', 'HEAD'], cwd) ?? 'unknown';
}

function discoverTrackableFiles(projectDir: string, extensions: Set<string>): string[] {
  const output = tryRunGit(['ls-files'], projectDir);
  if (!output) return [];

  return output
    .split('\n')
    .filter((f) => f && extensions.has(path.extname(f).toLowerCase()));
}

function detectTargetBranch(worktreePath: string): string {
  for (const branch of ['main', 'master', 'develop']) {
    const result = tryRunGit(['merge-base', branch, 'HEAD'], worktreePath);
    if (result !== null) return branch;
  }
  return 'main';
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isSafeTaskId(taskId: string): boolean {
  return (
    taskId !== '' &&
    taskId !== '.' &&
    taskId !== '..' &&
    !taskId.includes('/') &&
    !taskId.includes('\\')
  );
}

// =============================================================================
// FileEvolutionTracker
// =============================================================================

/**
 * Tracks file evolution across task modifications.
 */
export class FileEvolutionTracker {
  static readonly DEFAULT_EXTENSIONS = DEFAULT_EXTENSIONS;

  private readonly storage: EvolutionStorage;
  private readonly analyzer: SemanticAnalyzer;
  private evolutions: Map<string, FileEvolution>;

  get storageDir(): string { return this.storage.storageDir; }
  get baselinesDir(): string { return this.storage.baselinesDir; }
  get evolutionFile(): string { return this.storage.evolutionFile; }

  constructor(
    projectDir: string,
    storageDir?: string,
    semanticAnalyzer?: SemanticAnalyzer,
  ) {
    const resolvedStorageDir = storageDir ?? path.join(projectDir, '.auto-claude');
    this.storage = new EvolutionStorage(projectDir, resolvedStorageDir);
    this.analyzer = semanticAnalyzer ?? new SemanticAnalyzer();
    this.evolutions = this.storage.loadEvolutions();

    // zeenha fork: file_evolution.json used to grow forever because finished
    // tasks were never removed. Drop snapshots of tasks that have neither a spec
    // folder nor a task worktree. Skipped when there is no specs directory
    // (tests, fresh storage). Must never make construction fail.
    try {
      const specsDir = path.join(this.storage.storageDir, 'specs');
      if (isDirectory(specsDir)) {
        const worktreesDir = path.join(this.storage.storageDir, 'worktrees', 'tasks');
        this.pruneOrphanedTasks(
          (taskId) =>
            fs.existsSync(path.join(specsDir, taskId)) ||
            fs.existsSync(path.join(worktreesDir, taskId)),
        );
      }
    } catch {
      // Pruning is best-effort
    }
  }

  private saveEvolutions(): void {
    this.storage.saveEvolutions(this.evolutions);
  }

  /**
   * Capture baseline state of files for a task.
   */
  captureBaselines(
    taskId: string,
    files?: string[],
    intent = '',
  ): Map<string, FileEvolution> {
    const commit = getCurrentCommit(this.storage.projectDir);
    const capturedAt = new Date();
    const captured = new Map<string, FileEvolution>();

    const fileList = files ?? discoverTrackableFiles(this.storage.projectDir, DEFAULT_EXTENSIONS);

    for (const filePath of fileList) {
      const relPath = this.storage.getRelativePath(filePath);
      const content = this.storage.readFileContent(filePath);
      if (content === undefined) continue;

      const baselinePath = this.storage.storeBaselineContent(relPath, content, taskId);
      const contentHash = computeContentHash(content);

      let evolution = this.evolutions.get(relPath);
      if (!evolution) {
        evolution = {
          filePath: relPath,
          baselineCommit: commit,
          baselineCapturedAt: capturedAt,
          baselineContentHash: contentHash,
          baselineSnapshotPath: baselinePath,
          taskSnapshots: [],
        };
        this.evolutions.set(relPath, evolution);
      }

      const snapshot: TaskSnapshot = {
        taskId,
        taskIntent: intent,
        startedAt: capturedAt,
        contentHashBefore: contentHash,
        contentHashAfter: '',
        semanticChanges: [],
      };
      addTaskSnapshot(evolution, snapshot);
      captured.set(relPath, evolution);
    }

    this.saveEvolutions();
    return captured;
  }

  /**
   * Record a file modification by a task.
   */
  recordModification(
    taskId: string,
    filePath: string,
    oldContent: string,
    newContent: string,
    rawDiff?: string,
    skipSemanticAnalysis = false,
  ): TaskSnapshot | undefined {
    const snapshot = this.recordModificationNoSave(
      taskId, filePath, oldContent, newContent, rawDiff, skipSemanticAnalysis,
    );
    if (snapshot) this.saveEvolutions();
    return snapshot;
  }

  private recordModificationNoSave(
    taskId: string,
    filePath: string,
    oldContent: string,
    newContent: string,
    rawDiff?: string,
    skipSemanticAnalysis = false,
  ): TaskSnapshot | undefined {
    const relPath = this.storage.getRelativePath(filePath);

    if (!this.evolutions.has(relPath)) return undefined;

    const evolution = this.evolutions.get(relPath)!;
    let snapshot = getTaskSnapshot(evolution, taskId);

    if (!snapshot) {
      snapshot = {
        taskId,
        taskIntent: '',
        startedAt: new Date(),
        contentHashBefore: computeContentHash(oldContent),
        contentHashAfter: '',
        semanticChanges: [],
      };
    }

    const semanticChanges = skipSemanticAnalysis
      ? []
      : this.analyzer.analyzeDiff(relPath, oldContent, newContent).changes;

    snapshot.completedAt = new Date();
    snapshot.contentHashAfter = computeContentHash(newContent);
    snapshot.semanticChanges = semanticChanges;
    snapshot.rawDiff = rawDiff;

    addTaskSnapshot(evolution, snapshot);
    return snapshot;
  }

  /**
   * Refresh task snapshots by analyzing git diff from worktree.
   */
  async refreshFromGit(
    taskId: string,
    worktreePath: string,
    targetBranch?: string,
    analyzeOnlyFiles?: Set<string>,
  ): Promise<void> {
    const branch = targetBranch ?? detectTargetBranch(worktreePath);

    let mergeBase: string;
    try {
      mergeBase = await runGitAsync(['merge-base', branch, 'HEAD'], worktreePath);
    } catch (err) {
      // merge-base failed — the target branch may not exist in this repo.
      // Fallback: use the main project's HEAD as the comparison base.
      // This works because worktrees share the same git object store.
      console.warn(`[FileEvolutionTracker] merge-base '${branch}' failed in ${worktreePath}: ${err instanceof Error ? err.message : err}`);
      try {
        mergeBase = await runGitAsync(['rev-parse', 'HEAD'], this.storage.projectDir);
        console.warn(`[FileEvolutionTracker] Falling back to project HEAD: ${mergeBase.slice(0, 8)}`);
      } catch (fallbackErr) {
        console.warn(`[FileEvolutionTracker] Fallback also failed:`, fallbackErr);
        return;
      }
    }

    // Collect ALL changed files: committed (mergeBase..HEAD) + uncommitted working tree changes.
    // The worktree may have uncommitted edits (e.g., after a fast-forward to base branch)
    // that git diff mergeBase..HEAD won't capture.
    const changedFileSet = new Set<string>();

    // 1. Committed changes between merge base and HEAD
    const committedOutput = await tryRunGitAsync(['diff', '--name-only', `${mergeBase}..HEAD`], worktreePath);
    if (committedOutput) {
      for (const f of committedOutput.split('\n')) { if (f) changedFileSet.add(f); }
    }

    // 2. Uncommitted changes (working tree vs HEAD)
    const unstaged = await tryRunGitAsync(['diff', '--name-only', 'HEAD'], worktreePath);
    if (unstaged) {
      for (const f of unstaged.split('\n')) { if (f) changedFileSet.add(f); }
    }

    // 3. Staged but not yet committed changes
    const staged = await tryRunGitAsync(['diff', '--name-only', '--cached', 'HEAD'], worktreePath);
    if (staged) {
      for (const f of staged.split('\n')) { if (f) changedFileSet.add(f); }
    }

    const changedFiles = [...changedFileSet];

    // Fetch per-file data in parallel (bounded); mutation of the evolutions map
    // happens afterwards, sequentially, in the original order.
    const fetched = await mapWithConcurrency(changedFiles, GIT_CONCURRENCY, async (filePath) => {
      // Use mergeBase comparison against working tree to capture all changes
      const diffOutput = (await tryRunGitAsync(['diff', mergeBase, '--', filePath], worktreePath)) ?? '';

      let oldContent = '';
      try {
        oldContent = await runGitAsync(['show', `${mergeBase}:${filePath}`], worktreePath);
      } catch {
        // File is new
      }

      const fullPath = path.join(worktreePath, filePath);
      let newContent = '';
      if (fs.existsSync(fullPath)) {
        try {
          newContent = fs.readFileSync(fullPath, 'utf8');
        } catch {
          newContent = '';
        }
      }
      return { diffOutput, oldContent, newContent };
    });

    for (let i = 0; i < changedFiles.length; i++) {
      const filePath = changedFiles[i];
      const data = fetched[i];
      if (!data) continue;
      try {
        const { diffOutput, oldContent, newContent } = data;
        const relPath = this.storage.getRelativePath(filePath);
        if (!this.evolutions.has(relPath)) {
          this.evolutions.set(relPath, {
            filePath: relPath,
            baselineCommit: mergeBase,
            baselineCapturedAt: new Date(),
            baselineContentHash: computeContentHash(oldContent),
            baselineSnapshotPath: '',
            taskSnapshots: [],
          });
        }

        const skipAnalysis = analyzeOnlyFiles !== undefined && !analyzeOnlyFiles.has(relPath);

        this.recordModificationNoSave(taskId, filePath, oldContent, newContent, diffOutput, skipAnalysis);
      } catch {
        // Skip failed file
      }
    }

    this.saveEvolutions();
  }

  /**
   * Get the complete evolution history for a file.
   */
  getFileEvolution(filePath: string): FileEvolution | undefined {
    const relPath = this.storage.getRelativePath(filePath);
    return this.evolutions.get(relPath);
  }

  /**
   * Get the baseline content for a file.
   */
  getBaselineContent(filePath: string): string | undefined {
    const relPath = this.storage.getRelativePath(filePath);
    const evolution = this.evolutions.get(relPath);
    if (!evolution) return undefined;
    return this.storage.readBaselineContent(evolution.baselineSnapshotPath);
  }

  /**
   * Get all file modifications made by a specific task.
   */
  getTaskModifications(taskId: string): Array<[string, TaskSnapshot]> {
    const modifications: Array<[string, TaskSnapshot]> = [];
    for (const [filePath, evolution] of this.evolutions) {
      const snapshot = getTaskSnapshot(evolution, taskId);
      if (snapshot && taskSnapshotHasModifications(snapshot)) {
        modifications.push([filePath, snapshot]);
      }
    }
    return modifications;
  }

  /**
   * Get files modified by specified tasks.
   */
  getFilesModifiedByTasks(taskIds: string[]): Map<string, string[]> {
    const fileTasks = new Map<string, string[]>();
    const taskIdSet = new Set(taskIds);

    for (const [filePath, evolution] of this.evolutions) {
      for (const snapshot of evolution.taskSnapshots) {
        if (taskIdSet.has(snapshot.taskId) && taskSnapshotHasModifications(snapshot)) {
          if (!fileTasks.has(filePath)) fileTasks.set(filePath, []);
          fileTasks.get(filePath)!.push(snapshot.taskId);
        }
      }
    }

    return fileTasks;
  }

  /**
   * Get files modified by multiple tasks (potential conflicts).
   */
  getConflictingFiles(taskIds: string[]): string[] {
    const fileTasks = this.getFilesModifiedByTasks(taskIds);
    return [...fileTasks.entries()]
      .filter(([, tasks]) => tasks.length > 1)
      .map(([filePath]) => filePath);
  }

  /**
   * Mark a task as completed.
   */
  markTaskCompleted(taskId: string): void {
    const now = new Date();
    for (const evolution of this.evolutions.values()) {
      const snapshot = getTaskSnapshot(evolution, taskId);
      if (snapshot && !snapshot.completedAt) {
        snapshot.completedAt = now;
      }
    }
    this.saveEvolutions();
  }

  /**
   * Clean up data for a completed/cancelled task.
   */
  cleanupTask(taskId: string, removeBaselines = true): void {
    this.removeTaskInMemory(taskId, removeBaselines);
    this.saveEvolutions();
  }

  /**
   * Remove snapshots (and optionally baselines) for a task without saving.
   */
  private removeTaskInMemory(taskId: string, removeBaselines: boolean): void {
    for (const evolution of this.evolutions.values()) {
      evolution.taskSnapshots = evolution.taskSnapshots.filter((ts) => ts.taskId !== taskId);
    }

    if (removeBaselines) {
      const baselineDir = path.join(this.storage.baselinesDir, taskId);
      if (fs.existsSync(baselineDir)) {
        fs.rmSync(baselineDir, { recursive: true });
      }
    }

    // Remove empty evolutions
    for (const [filePath, evolution] of this.evolutions) {
      if (evolution.taskSnapshots.length === 0) {
        this.evolutions.delete(filePath);
      }
    }
  }

  /**
   * Remove all data for task ids that are no longer known.
   * Ids containing path separators or equal to '.'/'..' are skipped.
   * Saves once, only if something was removed. Returns removed task id count.
   */
  pruneOrphanedTasks(isKnownTask: (taskId: string) => boolean): number {
    const taskIds = new Set<string>();
    for (const evolution of this.evolutions.values()) {
      for (const snapshot of evolution.taskSnapshots) taskIds.add(snapshot.taskId);
    }

    let removed = 0;
    for (const taskId of taskIds) {
      if (!isSafeTaskId(taskId)) continue;
      if (isKnownTask(taskId)) continue;
      this.removeTaskInMemory(taskId, true);
      removed++;
    }

    if (removed > 0) this.saveEvolutions();
    return removed;
  }

  /**
   * Get set of task IDs with active (non-completed) modifications.
   */
  getActiveTasks(): Set<string> {
    const active = new Set<string>();
    for (const evolution of this.evolutions.values()) {
      for (const snapshot of evolution.taskSnapshots) {
        if (!snapshot.completedAt) active.add(snapshot.taskId);
      }
    }
    return active;
  }

  /**
   * Get a summary of tracked file evolutions.
   */
  getEvolutionSummary(): Record<string, unknown> {
    const totalFiles = this.evolutions.size;
    const allTasks = new Set<string>();
    let filesWithMultipleTasks = 0;
    let totalChanges = 0;

    for (const evolution of this.evolutions.values()) {
      const taskIds = evolution.taskSnapshots.map((ts) => ts.taskId);
      taskIds.forEach((id) => allTasks.add(id));
      if (taskIds.length > 1) filesWithMultipleTasks++;
      totalChanges += evolution.taskSnapshots.reduce((sum, ts) => sum + ts.semanticChanges.length, 0);
    }

    return {
      total_files_tracked: totalFiles,
      total_tasks: allTasks.size,
      files_with_potential_conflicts: filesWithMultipleTasks,
      total_semantic_changes: totalChanges,
      active_tasks: this.getActiveTasks().size,
    };
  }
}

/**
 * Remove a finished (merged/discarded) task from file evolution tracking.
 * Best-effort: callers have already completed the merge/discard, so failures
 * are logged and swallowed.
 */
export function pruneFinishedTask(projectDir: string, storageDir: string, taskId: string): void {
  try {
    if (!isSafeTaskId(taskId)) return;
    const resolved = path.resolve(storageDir);
    const hasEvolutionFile = fs.existsSync(path.join(resolved, 'file_evolution.json'));
    const hasBaselines = fs.existsSync(path.join(resolved, 'baselines', taskId));
    if (!hasEvolutionFile && !hasBaselines) return;
    new FileEvolutionTracker(projectDir, resolved).cleanupTask(taskId);
  } catch (err) {
    console.warn(
      `[FileEvolutionTracker] prune failed for task ${taskId}: ${err instanceof Error ? err.message : err}`,
    );
  }
}
