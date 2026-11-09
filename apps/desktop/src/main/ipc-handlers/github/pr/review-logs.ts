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
import { traceLog, sanitizeNetworkData } from "./shared";

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
    const sanitizedData = sanitizeNetworkData(rawData);
    return JSON.parse(sanitizedData) as PRLogs;
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
 * The logs file is written atomically and includes:
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
  fs.writeFileSync(logsPath, JSON.stringify(logs, null, 2), "utf-8");
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
 * Saves incrementally to disk so frontend can stream logs in real-time
 *
 * Log Streaming Architecture:
 * ===========================
 * This class implements a hybrid push/pull approach for real-time log streaming:
 *
 * 1. **File-Based Storage**: Logs are saved to disk every 3 entries (saveInterval)
 *    - Location: .auto-claude/github/pr/logs_${prNumber}.json
 *    - Format: JSON with phase status and log entries
 *
 * 2. **Push-Based Updates**: Emits IPC events (GITHUB_PR_LOGS_UPDATED) after each save
 *    - Notifies frontend immediately when new logs are available
 *    - Includes phase status and entry count for quick UI updates
 *
 * 3. **Pull-Based Polling**: Frontend polls via loadPRLogs() every 1.5s as fallback
 *    - Ensures logs are displayed even if IPC events are missed
 *    - Provides resilience against event delivery failures
 *
 * This hybrid approach ensures reliable real-time updates while maintaining
 * simplicity and debuggability (logs are always on disk for inspection).
 */
export class PRLogCollector {
  private logs: PRLogs;
  private project: Project;
  private currentPhase: PRLogPhase = "context";
  private entryCount: number = 0;
  private saveInterval: number = 3; // Save every N entries for real-time streaming
  private mainWindow: BrowserWindow | null;

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

    // Save initial empty logs so frontend sees the structure immediately
    this.save();
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
      // When moving to a new phase, mark the previous phase as complete
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
    this.entryCount++;

    // Save immediately if phase status changed (so frontend sees phase activation)
    // OR save periodically for real-time streaming (every N entries)
    if (phaseStatusChanged || this.entryCount % this.saveInterval === 0) {
      this.save();
    }
  }

  markPhaseComplete(phase: PRLogPhase, success: boolean): void {
    const phaseLog = this.logs.phases[phase];
    phaseLog.status = success ? "completed" : "failed";
    phaseLog.completed_at = new Date().toISOString();
    // Save immediately so frontend sees the status change
    this.save();
  }

  /**
   * Save logs to disk and notify frontend
   *
   * This method is called:
   * 1. Every N entries (saveInterval = 3) for incremental streaming
   * 2. When phase status changes (pending → active, active → completed)
   * 3. On review finalization (success or failure)
   *
   * Two-step update mechanism:
   * --------------------------
   * 1. **File Write**: Persists logs to disk via savePRLogs()
   *    - Creates/updates .auto-claude/github/pr/logs_${prNumber}.json
   *    - Updates the `updated_at` timestamp
   *
   * 2. **IPC Push Event**: Sends GITHUB_PR_LOGS_UPDATED to renderer
   *    - Contains phase status summary (pending/active/completed/failed)
   *    - Includes entry count for detecting changes
   *    - Enables instant UI updates without polling delay
   *
   * The frontend receives the IPC event and can optionally trigger an
   * immediate poll via loadPRLogs() to fetch the latest log content.
   * This is more efficient than polling alone, as the UI can update
   * immediately when logs are available rather than waiting for the
   * next poll interval (1.5s).
   */
  save(): void {
    const logPath = getPRLogsPath(this.project, this.logs.pr_number);
    traceLog("PRLogCollector.save()", {
      prNumber: this.logs.pr_number,
      logPath,
      entryCount: this.entryCount,
      phases: Object.entries(this.logs.phases).map(([name, phase]) => ({
        name,
        status: phase.status,
        entryCount: phase.entries.length
      }))
    });

    // Step 1: Write logs to disk for persistence and polling-based retrieval
    savePRLogs(this.project, this.logs);

    // Step 2: Emit IPC event to notify renderer of log update (push-based)
    // Uses standard (projectId, data) pattern matching other IPC communicators
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IPC_CHANNELS.GITHUB_PR_LOGS_UPDATED, this.project.id, {
        prNumber: this.logs.pr_number,
        phaseStatus: {
          context: this.logs.phases.context.status,
          analysis: this.logs.phases.analysis.status,
          synthesis: this.logs.phases.synthesis.status
        },
        entryCount: this.entryCount
      });
    }
  }

  finalize(success: boolean): void {
    // Mark active phases as completed based on success status
    // Pending phases with no entries should stay pending (they never ran)
    for (const phase of ["context", "analysis", "synthesis"] as PRLogPhase[]) {
      const phaseLog = this.logs.phases[phase];
      if (phaseLog.status === "active") {
        this.markPhaseComplete(phase, success);
      }
      // Note: Pending phases stay pending - they never received any log entries
      // This is correct behavior for follow-up reviews where some phases may be skipped
    }
    this.save();
  }
}
