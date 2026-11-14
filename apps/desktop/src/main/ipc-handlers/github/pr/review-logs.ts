/**
 * PR review log parsing, persistence and streaming collector.
 *
 * Must not import 'electron' at runtime so it can be unit tested.
 */

import type { BrowserWindow } from "electron";
import path from "path";
import fs from "fs";
import { IPC_CHANNELS } from "../../../../shared/constants";
import type { Project } from "../../../../shared/types";
import { traceLog } from "./shared";

/**
 * Get the GitHub directory for a project
 */
export function getGitHubDir(project: Project): string {
  return path.join(project.path, ".auto-claude", "github");
}

/**
 * PR log phase type
 */
export type PRLogPhase = "context" | "analysis" | "synthesis";

/**
 * PR log entry type
 */
export type PRLogEntryType =
  | "text"
  | "tool_start"
  | "tool_end"
  | "phase_start"
  | "phase_end"
  | "error"
  | "success"
  | "info";

/**
 * Single PR log entry
 */
export interface PRLogEntry {
  timestamp: string;
  type: PRLogEntryType;
  content: string;
  phase: PRLogPhase;
  source?: string;
  detail?: string;
  collapsed?: boolean;
}

/**
 * Phase log with entries
 */
export interface PRPhaseLog {
  phase: PRLogPhase;
  status: "pending" | "active" | "completed" | "failed";
  started_at: string | null;
  completed_at: string | null;
  entries: PRLogEntry[];
}

/**
 * Complete PR logs structure
 */
export interface PRLogs {
  pr_number: number;
  repo: string;
  created_at: string;
  updated_at: string;
  is_followup: boolean;
  phases: {
    context: PRPhaseLog;
    analysis: PRPhaseLog;
    synthesis: PRPhaseLog;
  };
}

/**
 * Parse a log line and extract source and content
 * Returns null if line is not a log line
 */
export function parseLogLine(line: string): { source: string; content: string; isError: boolean } | null {
  // Match patterns like [Context], [AI], [Orchestrator], [Followup], [DEBUG ...], [ParallelFollowup], [BotDetector], [ParallelOrchestrator]
  const patterns = [
    /^\[Context\]\s*(.*)$/,
    /^\[AI\]\s*(.*)$/,
    /^\[Orchestrator\]\s*(.*)$/,
    /^\[Followup\]\s*(.*)$/,
    /^\[ParallelFollowup\]\s*(.*)$/,
    /^\[ParallelOrchestrator\]\s*(.*)$/,
    /^\[BotDetector\]\s*(.*)$/,
    /^\[PR Review Engine\]\s*(.*)$/,
    /^\[DEBUG\s+(\w+)\]\s*(.*)$/,
    /^\[ERROR\s+(\w+)\]\s*(.*)$/,
  ];

  // Check for specialist agent logs first (Agent:agent-name format)
  const agentMatch = line.match(/^\[Agent:([\w-]+)\]\s*(.*)$/);
  if (agentMatch) {
    return {
      source: `Agent:${agentMatch[1]}`,
      content: agentMatch[2],
      isError: false,
    };
  }

  // Check for parallel SDK specialist logs (Specialist:name format)
  const specialistMatch = line.match(/^\[Specialist:([\w-]+)\]\s*(.*)$/);
  if (specialistMatch) {
    return {
      source: `Specialist:${specialistMatch[1]}`,
      content: specialistMatch[2],
      isError: false,
    };
  }

  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match) {
      const isDebugOrError = pattern.source.includes("DEBUG") || pattern.source.includes("ERROR");
      if (isDebugOrError && match.length >= 3) {
        // Skip debug messages that only show message types (not useful)
        if (match[2].match(/^Message #\d+: \w+Message/)) {
          return null;
        }
        return {
          source: match[1],
          content: match[2],
          isError: pattern.source.includes("ERROR"),
        };
      }
      const source = line.match(/^\[(\w+(?:\s+\w+)*)\]/)?.[1] || "Unknown";
      return {
        source,
        content: match[1] || line,
        isError: false,
      };
    }
  }

  // Check for PR progress messages [PR #XXX] [YY%] message
  const prProgressMatch = line.match(/^\[PR #\d+\]\s*\[\s*(\d+)%\]\s*(.*)$/);
  if (prProgressMatch) {
    return {
      source: "Progress",
      content: `[${prProgressMatch[1]}%] ${prProgressMatch[2]}`,
      isError: false,
    };
  }

  // Check for progress messages [XX%]
  const progressMatch = line.match(/^\[(\d+)%\]\s*(.*)$/);
  if (progressMatch) {
    return {
      source: "Progress",
      content: `[${progressMatch[1]}%] ${progressMatch[2]}`,
      isError: false,
    };
  }

  // Catch-all: any [word] or [word_word] prefix not matched above (e.g. review engine phases)
  const genericBracketMatch = line.match(/^\[([\w_]+)\]\s*(.*)$/);
  if (genericBracketMatch) {
    return {
      source: genericBracketMatch[1],
      content: genericBracketMatch[2] || line,
      isError: false,
    };
  }

  // Match final summary lines (Status:, Summary:, Findings:, etc.)
  const summaryPatterns = [
    /^(Status|Summary|Findings|Verdict|Is Follow-up|Resolved|Still Open|New Issues):\s*(.*)$/,
    /^PR #\d+ (Follow-up )?Review Complete$/,
    /^={10,}$/,
    /^-{10,}$/,
    // Markdown headers (## Summary, ### Resolution Status, etc.)
    /^#{1,4}\s+.+$/,
    // Bullet points with content (- ✅ **Resolved**, - **Blocking Issues**, etc.)
    /^[-*]\s+.+$/,
    // Indented bullet points for findings (  - [MEDIUM] ..., . [LOW] ...)
    /^\s+[-.*]\s+\[.+$/,
    // Lines with bold text at start (**Why NEEDS_REVISION:**, **Recommended Actions:**)
    /^\*\*.+\*\*:?\s*$/,
    // Numbered list items (1. Add DANGEROUS_FLAGS...)
    /^\d+\.\s+.+$/,
    // File references (File: apps/desktop/...)
    /^\s+File:\s+.+$/,
  ];
  for (const pattern of summaryPatterns) {
    const match = line.match(pattern);
    if (match) {
      return {
        source: "Summary",
        content: line,
        isError: false,
      };
    }
  }

  return null;
}

/**
 * Determine the phase from source
 */
export function getPhaseFromSource(source: string): PRLogPhase {
  // Context phase: gathering PR data, commits, files, feedback
  // Note: "Followup" is context gathering for follow-up reviews (comparing commits, finding changes)
  const contextSources = ["Context", "BotDetector", "Followup", "fetching"];
  // Analysis phase: AI agents analyzing code
  const analysisSources = [
    "AI",
    "Orchestrator",
    "ParallelOrchestrator",
    "ParallelFollowup",
    "orchestrator",
    "PRReview", // Worktree creation and PR-specific analysis
    "ClientCache", // SDK client cache operations
    "analyzing",
    "orchestrating",
    "quick_scan",
    "security",
    "logic",
    "codebase_fit",
    "deep_analysis",
    "structural",
    "quality",
    "validation",
    "dedup",
    "FindingValidator",
  ];
  // Synthesis phase: final summary and results
  // Note: "Progress" logs are redundant (shown in progress bar) but kept for completeness
  const synthesisSources = ["PR Review Engine", "Summary", "Progress", "generating", "posting", "complete", "finalizing", "synthesis", "synthesizing"];

  if (contextSources.includes(source)) return "context";
  if (analysisSources.includes(source)) return "analysis";
  // Specialist agents (Agent:xxx and Specialist:xxx) are part of analysis phase
  if (source.startsWith("Agent:")) return "analysis";
  if (source.startsWith("Specialist:")) return "analysis";
  if (synthesisSources.includes(source)) return "synthesis";
  return "synthesis"; // Default to synthesis for unknown sources
}

/**
 * Create empty PR logs structure
 */
export function createEmptyPRLogs(prNumber: number, repo: string, isFollowup: boolean): PRLogs {
  const now = new Date().toISOString();
  const createEmptyPhase = (phase: PRLogPhase): PRPhaseLog => ({
    phase,
    status: "pending",
    started_at: null,
    completed_at: null,
    entries: [],
  });

  return {
    pr_number: prNumber,
    repo,
    created_at: now,
    updated_at: now,
    is_followup: isFollowup,
    phases: {
      context: createEmptyPhase("context"),
      analysis: createEmptyPhase("analysis"),
      synthesis: createEmptyPhase("synthesis"),
    },
  };
}

/**
 * Get PR logs file path
 *
 * Logs are stored at `.auto-claude/github/pr/logs_${prNumber}.json` within the project directory.
 * This provides persistent storage for streaming log data during PR reviews.
 */
export function getPRLogsPath(project: Project, prNumber: number): string {
  return path.join(getGitHubDir(project), "pr", `logs_${prNumber}.json`);
}

/**
 * Load PR logs from disk
 *
 * This function is called by:
 * 1. The IPC handler (GITHUB_PR_GET_LOGS) when the frontend polls for log updates
 * 2. The frontend polling mechanism (every 1.5s during active review)
 * 3. The fallback mechanism after review completion
 *
 * Returns null if the logs file doesn't exist yet (review hasn't started)
 * or if the file is corrupted/unreadable.
 */
export function loadPRLogs(project: Project, prNumber: number): PRLogs | null {
  const logsPath = getPRLogsPath(project, prNumber);

  try {
    const rawData = fs.readFileSync(logsPath, "utf-8");
    return JSON.parse(rawData) as PRLogs;
  } catch {
    return null;
  }
}

/**
 * Save PR logs to disk
 *
 * Called by PRLogCollector.save() to persist logs incrementally during review.
 * This enables real-time streaming to the frontend via file-based polling.
 *
 * The logs file is written compactly to a ".tmp" sibling and renamed over the
 * target, so a concurrent reader never observes a partial file. It includes:
 * - Phase status (pending/active/completed/failed)
 * - Log entries for each phase (context, analysis, synthesis)
 * - Timestamps for created_at and updated_at
 * - Review metadata (PR number, repo, followup status)
 */
export function savePRLogs(project: Project, logs: PRLogs): void {
  const logsPath = getPRLogsPath(project, logs.pr_number);
  const prDir = path.dirname(logsPath);

  if (!fs.existsSync(prDir)) {
    fs.mkdirSync(prDir, { recursive: true });
  }

  logs.updated_at = new Date().toISOString();
  const tmpPath = `${logsPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(logs), "utf-8");
  fs.renameSync(tmpPath, logsPath);
}

/**
 * Delta of a single phase: entries added since the last push.
 * `baseCount` is the number of entries the renderer should already hold.
 */
export interface PRLogPhaseDelta {
  baseCount: number;
  entries: PRLogEntry[];
  status: PRPhaseLog["status"];
  started_at: string | null;
  completed_at: string | null;
}

/**
 * Delta payload pushed to the renderer (only phases that changed are present)
 */
export interface PRLogsDelta {
  pr_number: number;
  created_at: string;
  updated_at: string;
  phases: { [phase in PRLogPhase]?: PRLogPhaseDelta };
}

/**
 * Version the caller already holds, used for cheap change detection
 */
export interface PRLogsKnownVersion {
  updated_at: string;
  entryCount: number;
}

const PHASES: PRLogPhase[] = ["context", "analysis", "synthesis"];

function countEntries(logs: PRLogs): number {
  return PHASES.reduce((n, p) => n + logs.phases[p].entries.length, 0);
}

/** Live collectors keyed by `${project.id}:${prNumber}` */
const liveCollectors = new Map<string, PRLogCollector>();

function liveKey(project: Project, prNumber: number): string {
  return `${project.id}:${prNumber}`;
}

/**
 * Get the in-memory logs of a running review, or null if none is live.
 */
export function getLiveLogs(project: Project, prNumber: number): PRLogs | null {
  return liveCollectors.get(liveKey(project, prNumber))?.getLogs() ?? null;
}

/** mtime-keyed cache so unchanged finished reviews are not re-read */
const fileVersionCache = new Map<string, { mtimeMs: number; updated_at: string; entryCount: number }>();

/**
 * Load logs only if they differ from what the caller already knows.
 * Returns 'unchanged' when the known version is still current.
 */
export function loadPRLogsIfChanged(
  project: Project,
  prNumber: number,
  known?: PRLogsKnownVersion
): PRLogs | null | "unchanged" {
  const live = getLiveLogs(project, prNumber);
  if (live) {
    if (known && known.updated_at === live.updated_at && known.entryCount === countEntries(live)) {
      return "unchanged";
    }
    return live;
  }

  const logsPath = getPRLogsPath(project, prNumber);
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(logsPath).mtimeMs;
  } catch {
    fileVersionCache.delete(logsPath);
    return null;
  }

  const cached = fileVersionCache.get(logsPath);
  if (
    known &&
    cached &&
    cached.mtimeMs === mtimeMs &&
    cached.updated_at === known.updated_at &&
    cached.entryCount === known.entryCount
  ) {
    return "unchanged";
  }

  const logs = loadPRLogs(project, prNumber);
  if (!logs) return null;
  const entryCount = countEntries(logs);
  fileVersionCache.set(logsPath, { mtimeMs, updated_at: logs.updated_at, entryCount });
  if (known && known.updated_at === logs.updated_at && known.entryCount === entryCount) {
    return "unchanged";
  }
  return logs;
}

/**
 * Add a log entry to PR logs
 * Returns true if the phase status changed (for triggering immediate save)
 */
export function addLogEntry(logs: PRLogs, entry: PRLogEntry): boolean {
  const phase = logs.phases[entry.phase];
  let statusChanged = false;

  // Start the phase if it was pending
  if (phase.status === "pending") {
    phase.status = "active";
    phase.started_at = entry.timestamp;
    statusChanged = true;
  }

  phase.entries.push(entry);
  return statusChanged;
}

/**
 * PR Log Collector - collects logs during review
 *
 * Log Streaming Architecture:
 * ===========================
 * 1. **Memory is authoritative**: logs live in this collector while the review
 *    runs (see getLiveLogs()); readers prefer them over the file.
 *
 * 2. **Throttled disk writes**: a trailing timer (~1s) persists the logs to
 *    .auto-claude/github/pr/logs_${prNumber}.json (compact JSON, atomic rename).
 *    Phase changes and finalize() write immediately.
 *
 * 3. **Delta push**: a coalesced trailing timer (~200ms) sends
 *    GITHUB_PR_LOGS_UPDATED with only the entries added since the last push,
 *    so IPC payloads stay small regardless of log size.
 *
 * 4. **Cheap poll fallback**: the renderer can still poll through
 *    loadPRLogsIfChanged(), which returns 'unchanged' without reading or
 *    parsing anything when nothing has changed.
 */
const DISK_FLUSH_MS = 1000;
const PUSH_FLUSH_MS = 200;

export class PRLogCollector {
  private logs: PRLogs;
  private project: Project;
  private currentPhase: PRLogPhase = "context";
  private entryCount: number = 0;
  private mainWindow: BrowserWindow | null;
  private sentCounts: Record<PRLogPhase, number> = { context: 0, analysis: 0, synthesis: 0 };
  private sentStatus: Record<PRLogPhase, string> = { context: "", analysis: "", synthesis: "" };
  private diskTimer: ReturnType<typeof setTimeout> | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    project: Project,
    prNumber: number,
    repo: string,
    isFollowup: boolean,
    mainWindow?: BrowserWindow
  ) {
    this.project = project;
    this.logs = createEmptyPRLogs(prNumber, repo, isFollowup);
    this.mainWindow = mainWindow || null;

    // Trace: Log collector creation (verbose only)
    const logPath = getPRLogsPath(project, prNumber);
    traceLog("PRLogCollector created", {
      prNumber,
      repo,
      isFollowup,
      logPath,
      hasMainWindow: !!this.mainWindow
    });

    liveCollectors.set(liveKey(project, prNumber), this);

    // Write initial empty logs so frontend sees the structure immediately
    this.flushDisk();
    this.flushPush();
  }

  /** In-memory logs (authoritative while the review runs) */
  getLogs(): PRLogs {
    return this.logs;
  }

  processLine(line: string): void {
    const parsed = parseLogLine(line);
    if (!parsed) return;

    const phase = getPhaseFromSource(parsed.source);

    // Trace: Log line processing (verbose only - fires on every log line)
    traceLog("PRLogCollector.processLine()", {
      prNumber: this.logs.pr_number,
      phase,
      currentPhase: this.currentPhase,
      source: parsed.source,
      isError: parsed.isError,
      entryCount: this.entryCount
    });

    // Track phase transitions - mark previous phases as complete (only if they were active)
    if (phase !== this.currentPhase) {
      // Only mark complete if the phase was actually active (received log entries)
      // This prevents marking phases as "completed" if they were skipped
      if (this.currentPhase === "context" && (phase === "analysis" || phase === "synthesis")) {
        if (this.logs.phases.context.status === "active") {
          this.markPhaseComplete("context", true);
        }
      }
      if (this.currentPhase === "analysis" && phase === "synthesis") {
        if (this.logs.phases.analysis.status === "active") {
          this.markPhaseComplete("analysis", true);
        }
      }
      this.currentPhase = phase;
    }

    const entry: PRLogEntry = {
      timestamp: new Date().toISOString(),
      type: parsed.isError ? "error" : "text",
      content: parsed.content,
      phase,
      source: parsed.source,
    };

    const phaseStatusChanged = addLogEntry(this.logs, entry);
    this.logs.updated_at = entry.timestamp;
    this.entryCount++;

    if (phaseStatusChanged) {
      // Flush immediately so frontend sees phase activation
      this.save();
    } else {
      this.scheduleDisk();
      this.schedulePush();
    }
  }

  markPhaseComplete(phase: PRLogPhase, success: boolean): void {
    const phaseLog = this.logs.phases[phase];
    phaseLog.status = success ? "completed" : "failed";
    phaseLog.completed_at = new Date().toISOString();
    this.logs.updated_at = phaseLog.completed_at;
    // Flush immediately so frontend sees the status change
    this.save();
  }

  /**
   * Flush to disk and push a delta to the renderer immediately,
   * cancelling any pending throttled flushes.
   */
  save(): void {
    this.flushDisk();
    this.flushPush();
  }

  private scheduleDisk(): void {
    if (this.diskTimer) return;
    this.diskTimer = setTimeout(() => this.flushDisk(), DISK_FLUSH_MS);
    this.diskTimer.unref?.();
  }

  private schedulePush(): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => this.flushPush(), PUSH_FLUSH_MS);
    this.pushTimer.unref?.();
  }

  private flushDisk(): void {
    if (this.diskTimer) {
      clearTimeout(this.diskTimer);
      this.diskTimer = null;
    }
    traceLog("PRLogCollector.flushDisk()", {
      prNumber: this.logs.pr_number,
      entryCount: this.entryCount
    });
    try {
      savePRLogs(this.project, this.logs);
    } catch (error) {
      traceLog("PRLogCollector.flushDisk() failed", { error: String(error) });
    }
  }

  private flushPush(): void {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    const delta: PRLogsDelta = {
      pr_number: this.logs.pr_number,
      created_at: this.logs.created_at,
      updated_at: this.logs.updated_at,
      phases: {},
    };
    for (const phase of PHASES) {
      const log = this.logs.phases[phase];
      const baseCount = this.sentCounts[phase];
      const entries = log.entries.slice(baseCount);
      if (entries.length === 0 && log.status === this.sentStatus[phase]) continue;
      delta.phases[phase] = {
        baseCount,
        entries,
        status: log.status,
        started_at: log.started_at,
        completed_at: log.completed_at,
      };
      this.sentCounts[phase] = log.entries.length;
      this.sentStatus[phase] = log.status;
    }

    this.mainWindow.webContents.send(IPC_CHANNELS.GITHUB_PR_LOGS_UPDATED, this.project.id, {
      prNumber: this.logs.pr_number,
      phaseStatus: {
        context: this.logs.phases.context.status,
        analysis: this.logs.phases.analysis.status,
        synthesis: this.logs.phases.synthesis.status
      },
      entryCount: this.entryCount,
      delta,
    });
  }

  finalize(success: boolean): void {
    // Mark active phases as completed based on success status
    // Pending phases with no entries stay pending (they never ran)
    for (const phase of PHASES) {
      if (this.logs.phases[phase].status === "active") {
        this.markPhaseComplete(phase, success);
      }
    }
    this.save();
    const key = liveKey(this.project, this.logs.pr_number);
    if (liveCollectors.get(key) === this) {
      liveCollectors.delete(key);
    }
  }
}
