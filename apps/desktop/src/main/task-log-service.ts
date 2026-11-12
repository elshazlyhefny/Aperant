import path from 'path';
import { existsSync, readFileSync, statSync } from 'fs';
import { EventEmitter } from 'events';
import type { TaskLogs, TaskLogPhase, TaskPhaseLog, TaskLogEntry, TaskLogsDelta } from '../shared/types';
import { findTaskWorktree } from './worktree-paths';
import { debugLog, debugWarn, debugError } from '../shared/utils/debug-logger';

type FileSignature = { mtimeMs: number; size: number };
type PhaseBaseline = { count: number; lastKey: string | null };
type Baseline = Record<TaskLogPhase, PhaseBaseline>;

const LOG_PHASES: TaskLogPhase[] = ['planning', 'coding', 'validation'];

// Same key shape combinePhaseLogs uses to identify an entry
function entryKey(entry: TaskLogEntry): string {
  return `${entry.timestamp}|${entry.type}|${entry.content}`;
}

function buildBaseline(logs: TaskLogs): Baseline {
  const baseline = {} as Baseline;
  for (const phase of LOG_PHASES) {
    const entries = logs.phases[phase]?.entries ?? [];
    baseline[phase] = {
      count: entries.length,
      lastKey: entries.length > 0 ? entryKey(entries[entries.length - 1]) : null
    };
  }
  return baseline;
}

function findWorktreeSpecDir(projectPath: string, specId: string, specsRelPath: string): string | null {
  const worktreePath = findTaskWorktree(projectPath, specId);
  if (worktreePath) {
    return path.join(worktreePath, specsRelPath, specId);
  }
  return null;
}

/**
 * Service for loading and watching phase-based task logs (task_logs.json)
 *
 * This service provides:
 * - Loading logs from the spec directory (and worktree spec directory when active)
 * - Watching for log file changes
 * - Emitting logs-changed events when logs change
 * - Determining which phase is currently active
 *
 * Note: When a task runs in isolated mode (worktrees), the build logs are written to
 * the worktree's spec directory, not the main project's spec directory. This service
 * watches both locations and merges logs from both sources.
 */
export class TaskLogService extends EventEmitter {
  private logCache: Map<string, TaskLogs> = new Map();
  private pollIntervals: Map<string, NodeJS.Timeout> = new Map();
  // Store paths being watched for each specId (main + worktree)
  private watchedPaths: Map<string, { mainSpecDir: string; worktreeSpecDir: string | null; specsRelPath: string }> = new Map();

  // Per-spec record of what has been emitted to (or fetched by) the renderer.
  // Seeded from the initial load in startWatching and reset via markEmitted()
  // whenever the renderer does a full getTaskLogs load, so both sides agree.
  private emitted: Map<string, Baseline> = new Map();
  // Last status triple emitted per phase, to detect status-only changes
  private emittedStatus: Map<string, Record<TaskLogPhase, string>> = new Map();

  // Poll interval for watching log changes (more reliable than fs.watch on some systems)
  private readonly POLL_INTERVAL_MS = 1000;

  /**
   * Load task logs from a single spec directory
   * Returns cached logs if the file is corrupted (e.g., mid-write by Python backend)
   */
  loadLogsFromPath(specDir: string): TaskLogs | null {
    const logFile = path.join(specDir, 'task_logs.json');

    debugLog('[TaskLogService.loadLogsFromPath] Attempting to load logs:', {
      specDir,
      logFile,
      exists: existsSync(logFile)
    });

    if (!existsSync(logFile)) {
      debugLog('[TaskLogService.loadLogsFromPath] Log file does not exist:', logFile);
      return null;
    }

    try {
      const content = readFileSync(logFile, 'utf-8');
      const logs = JSON.parse(content) as TaskLogs;

      debugLog('[TaskLogService.loadLogsFromPath] Successfully loaded logs:', {
        specDir,
        specId: logs.spec_id,
        phases: Object.keys(logs.phases),
        entryCounts: {
          planning: logs.phases.planning?.entries?.length || 0,
          coding: logs.phases.coding?.entries?.length || 0,
          validation: logs.phases.validation?.entries?.length || 0
        }
      });

      this.logCache.set(specDir, logs);
      return logs;
    } catch (error) {
      // JSON parse error - file may be mid-write, return cached version if available
      const cached = this.logCache.get(specDir);
      if (cached) {
        debugWarn('[TaskLogService.loadLogsFromPath] Parse error, returning cached logs:', {
          specDir,
          error: error instanceof Error ? error.message : String(error)
        });
        return cached;
      }
      // Only log if we have no cached fallback
      debugError('[TaskLogService.loadLogsFromPath] Failed to load logs (no cache):', {
        logFile,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Merge logs from main and worktree spec directories
   */
  private mergeLogs(mainLogs: TaskLogs | null, worktreeLogs: TaskLogs | null, specDir: string): TaskLogs | null {
    debugLog('[TaskLogService.mergeLogs] Merging logs:', {
      specDir,
      hasMainLogs: !!mainLogs,
      hasWorktreeLogs: !!worktreeLogs,
      mainEntries: mainLogs ? {
        planning: mainLogs.phases.planning?.entries?.length || 0,
        coding: mainLogs.phases.coding?.entries?.length || 0,
        validation: mainLogs.phases.validation?.entries?.length || 0
      } : null,
      worktreeEntries: worktreeLogs ? {
        planning: worktreeLogs.phases.planning?.entries?.length || 0,
        coding: worktreeLogs.phases.coding?.entries?.length || 0,
        validation: worktreeLogs.phases.validation?.entries?.length || 0
      } : null
    });

    if (!worktreeLogs) {
      debugLog('[TaskLogService.mergeLogs] No worktree logs, using main logs only');
      if (mainLogs) {
        this.logCache.set(specDir, mainLogs);
      }
      return mainLogs;
    }

    if (!mainLogs) {
      debugLog('[TaskLogService.mergeLogs] No main logs, using worktree logs only');
      this.logCache.set(specDir, worktreeLogs);
      return worktreeLogs;
    }

    // Merge logs: planning from main, coding/validation from worktree (if available)
    const mergedLogs: TaskLogs = {
      spec_id: mainLogs.spec_id,
      created_at: mainLogs.created_at,
      updated_at: worktreeLogs.updated_at > mainLogs.updated_at ? worktreeLogs.updated_at : mainLogs.updated_at,
      phases: {
        planning: this.combinePhaseLogs(mainLogs.phases.planning, worktreeLogs.phases.planning),
        // Use worktree logs for coding/validation if they have entries, otherwise fall back to main
        coding: (worktreeLogs.phases.coding?.entries?.length > 0 || worktreeLogs.phases.coding?.status !== 'pending')
          ? worktreeLogs.phases.coding
          : mainLogs.phases.coding,
        validation: (worktreeLogs.phases.validation?.entries?.length > 0 || worktreeLogs.phases.validation?.status !== 'pending')
          ? worktreeLogs.phases.validation
          : mainLogs.phases.validation
      }
    };

    debugLog('[TaskLogService.mergeLogs] Merged logs created:', {
      specDir,
      mergedEntries: {
        planning: mergedLogs.phases.planning?.entries?.length || 0,
        coding: mergedLogs.phases.coding?.entries?.length || 0,
        validation: mergedLogs.phases.validation?.entries?.length || 0
      },
      source: {
        planning: 'combined',
        coding: (worktreeLogs.phases.coding?.entries?.length > 0 || worktreeLogs.phases.coding?.status !== 'pending') ? 'worktree' : 'main',
        validation: (worktreeLogs.phases.validation?.entries?.length > 0 || worktreeLogs.phases.validation?.status !== 'pending') ? 'worktree' : 'main'
      }
    });

    this.logCache.set(specDir, mergedLogs);
    return mergedLogs;
  }

  /**
   * Load and merge task logs from main spec dir and worktree spec dir
   * Planning phase logs are in main spec dir, coding/validation logs may be in worktree
   *
   * @param specDir - Main project spec directory
   * @param projectPath - Optional: Project root path (needed to find worktree if not registered)
   * @param specsRelPath - Optional: Relative path to specs (e.g., "auto-claude/specs")
   * @param specId - Optional: Spec ID (needed to find worktree if not registered)
   */
  loadLogs(specDir: string, projectPath?: string, specsRelPath?: string, specId?: string): TaskLogs | null {
    debugLog('[TaskLogService.loadLogs] Loading logs:', {
      specDir,
      projectPath,
      specsRelPath,
      specId,
      watchedPathsCount: this.watchedPaths.size
    });

    // First try to load from main spec dir
    const mainLogs = this.loadLogsFromPath(specDir);

    // Check if we have worktree paths registered for this spec
    const watchedInfo = Array.from(this.watchedPaths.entries()).find(
      ([_, info]) => info.mainSpecDir === specDir
    );

    let worktreeSpecDir: string | null = null;

    if (watchedInfo?.[1].worktreeSpecDir) {
      worktreeSpecDir = watchedInfo[1].worktreeSpecDir;
      debugLog('[TaskLogService.loadLogs] Found worktree from watched paths:', worktreeSpecDir);
    } else if (projectPath && specsRelPath && specId) {
      // Calculate worktree path from provided params
      worktreeSpecDir = findWorktreeSpecDir(projectPath, specId, specsRelPath);
      debugLog('[TaskLogService.loadLogs] Calculated worktree path:', {
        worktreeSpecDir,
        projectPath,
        specId,
        specsRelPath
      });
    }

    if (!worktreeSpecDir) {
      // No worktree info available
      debugLog('[TaskLogService.loadLogs] No worktree found, using main logs only');
      if (mainLogs) {
        this.logCache.set(specDir, mainLogs);
      }
      return mainLogs;
    }

    // Try to load from worktree spec dir
    const worktreeLogs = this.loadLogsFromPath(worktreeSpecDir);

    return this.mergeLogs(mainLogs, worktreeLogs, specDir);
  }

  /**
   * Get the currently active phase from logs
   */
  getActivePhase(specDir: string): TaskLogPhase | null {
    const logs = this.loadLogs(specDir);
    if (!logs) return null;

    const phases: TaskLogPhase[] = ['planning', 'coding', 'validation'];
    for (const phase of phases) {
      if (logs.phases[phase]?.status === 'active') {
        return phase;
      }
    }
    return null;
  }

  /**
   * Get logs for a specific phase
   */
  getPhaseLog(specDir: string, phase: TaskLogPhase): TaskPhaseLog | null {
    const logs = this.loadLogs(specDir);
    if (!logs) return null;
    return logs.phases[phase] || null;
  }

  /**
   * Stat a file and return its change signature, or null if it cannot be read
   */
  private statSignature(file: string): FileSignature | null {
    try {
      const st = statSync(file);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  }

  private signatureChanged(prev: FileSignature | null, next: FileSignature): boolean {
    return !prev || prev.mtimeMs !== next.mtimeMs || prev.size !== next.size;
  }

  /**
   * Start watching a spec directory for log changes
   * Also watches the worktree spec directory if it exists (for coding/validation phases)
   *
   * @param specId - The spec ID (e.g., "013-screenshots-on-tasks")
   * @param specDir - Main project spec directory
   * @param projectPath - Optional: Project root path (needed to find worktree)
   * @param specsRelPath - Optional: Relative path to specs (e.g., "auto-claude/specs")
   */
  startWatching(specId: string, specDir: string, projectPath?: string, specsRelPath?: string): void {
    debugLog('[TaskLogService.startWatching] Starting watch:', {
      specId,
      specDir,
      projectPath,
      specsRelPath
    });

    // Check if already watching with the same parameters (prevents rapid watch/unwatch cycles)
    const existingWatch = this.watchedPaths.get(specId);
    if (existingWatch && existingWatch.mainSpecDir === specDir) {
      debugLog('[TaskLogService.startWatching] Already watching this spec, skipping');
      return;
    }

    // Stop any existing watch (different spec dir or first time)
    this.stopWatching(specId);

    const mainLogFile = path.join(specDir, 'task_logs.json');

    // Calculate worktree spec directory path if we have project info
    let worktreeSpecDir: string | null = null;
    if (projectPath && specsRelPath) {
      worktreeSpecDir = findWorktreeSpecDir(projectPath, specId, specsRelPath);
    }

    // Store watched paths for this specId
    this.watchedPaths.set(specId, {
      mainSpecDir: specDir,
      worktreeSpecDir,
      specsRelPath: specsRelPath || ''
    });

    // Cheap change detection: compare stat signatures instead of file contents
    let lastMainSig = this.statSignature(mainLogFile);
    let lastWorktreeSig: FileSignature | null = worktreeSpecDir
      ? this.statSignature(path.join(worktreeSpecDir, 'task_logs.json'))
      : null;

    // Do initial merged load
    debugLog('[TaskLogService.startWatching] Loading initial logs');
    const initialLogs = this.loadLogs(specDir);
    if (initialLogs) {
      debugLog('[TaskLogService.startWatching] Initial logs loaded:', {
        specId: initialLogs.spec_id,
        entryCounts: {
          planning: initialLogs.phases.planning?.entries?.length || 0,
          coding: initialLogs.phases.coding?.entries?.length || 0,
          validation: initialLogs.phases.validation?.entries?.length || 0
        }
      });
      this.logCache.set(specDir, initialLogs);
      this.markEmitted(specId, initialLogs);
    } else {
      debugLog('[TaskLogService.startWatching] No initial logs found');
    }

    // Poll for changes in both locations
    // Note: worktreeSpecDir may be null initially if worktree doesn't exist yet.
    // We need to dynamically re-discover it during polling.
    const pollInterval = setInterval(() => {
      let mainChanged = false;
      let worktreeChanged = false;

      // Dynamically re-discover worktree if not found yet
      // This handles the case where user opens logs before worktree is created
      const watchedInfo = this.watchedPaths.get(specId);
      let currentWorktreeSpecDir = watchedInfo?.worktreeSpecDir || null;

      if (!currentWorktreeSpecDir && projectPath && specsRelPath) {
        const discoveredWorktree = findWorktreeSpecDir(projectPath, specId, specsRelPath);
        if (discoveredWorktree) {
          currentWorktreeSpecDir = discoveredWorktree;
          // Update stored paths so future iterations don't need to re-discover
          this.watchedPaths.set(specId, {
            mainSpecDir: specDir,
            worktreeSpecDir: discoveredWorktree,
            specsRelPath: specsRelPath
          });
          debugLog('[TaskLogService] Discovered worktree for spec:', {
            specId,
            worktreeSpecDir: discoveredWorktree
          });
        }
      }

      // Check main spec dir
      const mainSig = this.statSignature(mainLogFile);
      if (mainSig && this.signatureChanged(lastMainSig, mainSig)) {
        mainChanged = true;
      }
      lastMainSig = mainSig;

      // Check worktree spec dir
      if (currentWorktreeSpecDir) {
        const worktreeSig = this.statSignature(path.join(currentWorktreeSpecDir, 'task_logs.json'));
        if (worktreeSig && this.signatureChanged(lastWorktreeSig, worktreeSig)) {
          worktreeChanged = true;
        }
        lastWorktreeSig = worktreeSig;
      }

      // If either file changed, reload and emit
      if (mainChanged || worktreeChanged) {
        debugLog('[TaskLogService] Log file changed:', {
          specId,
          mainChanged,
          worktreeChanged
        });

        const logs = this.loadLogs(specDir);

        if (logs) {
          const delta = this.computeDelta(specId, logs);
          if (delta === 'none') {
            debugLog('[TaskLogService] No new entries or status changes, emitting nothing:', specId);
          } else if (delta) {
            debugLog('[TaskLogService] Emitting logs-appended event:', { specId });
            this.emit('logs-appended', specId, delta);
          } else {
            debugLog('[TaskLogService] Emitting logs-changed event (resync):', { specId });
            this.emit('logs-changed', specId, logs);
          }
        } else {
          debugWarn('[TaskLogService] No logs loaded after file change:', specId);
        }
      }
    }, this.POLL_INTERVAL_MS);

    this.pollIntervals.set(specId, pollInterval);
    debugLog('[TaskLogService] Started watching spec:', {
      specId,
      mainSpecDir: specDir,
      worktreeSpecDir: worktreeSpecDir || 'none',
      pollIntervalMs: this.POLL_INTERVAL_MS
    });
  }

  /**
   * Stop watching a spec directory
   */
  stopWatching(specId: string): void {
    const interval = this.pollIntervals.get(specId);
    if (interval) {
      debugLog('[TaskLogService.stopWatching] Stopping watch for spec:', specId);
      clearInterval(interval);
      this.pollIntervals.delete(specId);
      this.watchedPaths.delete(specId);
    }
    this.emitted.delete(specId);
    this.emittedStatus.delete(specId);
  }

  /**
   * Record that the renderer now holds `logs` in full (e.g. after a getTaskLogs
   * load or a full 'logs-changed' emit), so later deltas are computed against it.
   */
  markEmitted(specId: string, logs: TaskLogs): void {
    this.emitted.set(specId, buildBaseline(logs));
    const statuses = {} as Record<TaskLogPhase, string>;
    for (const phase of LOG_PHASES) {
      statuses[phase] = this.statusKey(logs.phases[phase]);
    }
    this.emittedStatus.set(specId, statuses);
  }

  private statusKey(log: TaskPhaseLog | undefined): string {
    return `${log?.status}|${log?.started_at}|${log?.completed_at}`;
  }

  /**
   * Compare freshly loaded logs against the emitted baseline.
   * Returns a delta when entries were only appended, 'none' when nothing
   * observable changed, or null when a full resync is required (shrink/reorder
   * or no baseline). The baseline is updated in every case.
   */
  private computeDelta(specId: string, logs: TaskLogs): TaskLogsDelta | 'none' | null {
    const prev = this.emitted.get(specId);
    const prevStatus = this.emittedStatus.get(specId);

    let appendOnly = !!prev && !!prevStatus;
    if (prev) {
      for (const phase of LOG_PHASES) {
        const entries = logs.phases[phase]?.entries ?? [];
        const base = prev[phase];
        if (entries.length < base.count) {
          appendOnly = false;
          break;
        }
        if (base.count > 0 && entryKey(entries[base.count - 1]) !== base.lastKey) {
          appendOnly = false;
          break;
        }
      }
    }

    if (!appendOnly || !prev || !prevStatus) {
      this.markEmitted(specId, logs);
      return null;
    }

    const delta: TaskLogsDelta = { spec_id: logs.spec_id, updated_at: logs.updated_at, phases: {} };
    for (const phase of LOG_PHASES) {
      const log = logs.phases[phase];
      const entries = log?.entries ?? [];
      const newEntries = entries.slice(prev[phase].count);
      if (newEntries.length === 0 && this.statusKey(log) === prevStatus[phase]) continue;
      delta.phases[phase] = {
        status: log.status,
        started_at: log.started_at,
        completed_at: log.completed_at,
        baseCount: prev[phase].count,
        entries: newEntries
      };
    }

    this.markEmitted(specId, logs);
    return Object.keys(delta.phases).length === 0 ? 'none' : delta;
  }

  /**
   * Stop all watches
   */
  stopAllWatching(): void {
    for (const specId of this.pollIntervals.keys()) {
      this.stopWatching(specId);
    }
  }

  /**
   * Combine entries from two phase log sources.
   * Used for the planning phase where spec creation logs (main) and
   * planner agent logs (worktree) should both appear.
   */
  private combinePhaseLogs(main: TaskPhaseLog | undefined, worktree: TaskPhaseLog | undefined): TaskPhaseLog {
    // If only one has entries, use it
    if (!main?.entries?.length && !worktree?.entries?.length) {
      return main || worktree || { phase: 'planning' as TaskLogPhase, status: 'pending', started_at: null, completed_at: null, entries: [] };
    }
    if (!main?.entries?.length) return worktree!;
    if (!worktree?.entries?.length) return main;

    // Combine entries from both, sorted by timestamp
    const allEntries = [...main.entries, ...worktree.entries].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    // Deduplicate: entries with identical timestamp + type + content are considered duplicates.
    // This happens when task_logs.json is copied from main to worktree (worktree-manager Step 7),
    // causing both dirs to contain the same planning phase entries.
    const seen = new Set<string>();
    const deduped = allEntries.filter(entry => {
      const key = `${entry.timestamp}|${entry.type}|${entry.content}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const combined: TaskPhaseLog = {
      phase: main.phase,
      // Use the most advanced status (worktree typically has the later state)
      status: worktree.status !== 'pending' ? worktree.status : main.status,
      started_at: main.started_at || worktree.started_at,
      completed_at: worktree.completed_at || main.completed_at,
      entries: deduped,
    };
    return combined;
  }

  /**
   * Get cached logs without re-reading from disk
   */
  getCachedLogs(specDir: string): TaskLogs | null {
    return this.logCache.get(specDir) || null;
  }

  /**
   * Clear the log cache for a spec
   */
  clearCache(specDir: string): void {
    this.logCache.delete(specDir);
  }

  /**
   * Check if logs exist for a spec
   */
  hasLogs(specDir: string): boolean {
    const logFile = path.join(specDir, 'task_logs.json');
    return existsSync(logFile);
  }
}

// Singleton instance
export const taskLogService = new TaskLogService();
