/**
 * zeenha fork: what each agent session cost, per task.
 *
 * Nothing recorded this. `task_logs.json` drops usage events and holds only
 * what the UI shows; the CLI runs with `--no-session-persistence`. So "where
 * does a task's time and quota go?" could not be answered from any file.
 *
 * Each finished session appends one entry to `run_metrics.json` in the spec
 * directory and, in worktree mode, in the main project's spec directory too,
 * so the numbers outlive the worktree. Recording must never affect a build:
 * every failure here is swallowed.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SessionResult, StreamEvent } from '../session/types';

export const RUN_METRICS_FILE = 'run_metrics.json';

const SLOWEST_KEPT = 5;
const DETAIL_MAX_CHARS = 120;

export interface ToolMetrics {
  calls: number;
  errors: number;
  totalMs: number;
}

export interface SlowToolCall {
  tool: string;
  ms: number;
  detail?: string;
}

export interface SessionMetricsEntry {
  agentType: string;
  phase: string;
  subtaskId?: string;
  sessionNumber?: number;
  model: string;
  thinkingLevel?: string;
  startedAt: string;
  durationMs: number;
  /** Wall time inside tools; `durationMs` minus this is roughly model time. */
  toolTimeMs: number;
  outcome: string;
  steps: number;
  toolCalls: number;
  tokens: {
    /** All input, including cached input. */
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  };
  tools: Record<string, ToolMetrics>;
  slowest: SlowToolCall[];
}

interface RunMetricsFile {
  version: 1;
  sessions: SessionMetricsEntry[];
}

/** Commands are logged elsewhere in full, but a metrics file should not carry credentials. */
export function redactDetail(text: string): string {
  return text
    .replace(/(authorization:\s*bearer\s+|bearer\s+)\S+/gi, '$1***')
    .replace(/\b([\w-]*(?:token|secret|password|passwd|api[_-]?key)[\w-]*)(\s*[=:]\s*)\S+/gi, '$1$2***');
}

function detailFromArgs(args: Record<string, unknown>): string | undefined {
  const value = args.command ?? args.file_path ?? args.pattern;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return redactDetail(value.replace(/\s+/g, ' ').trim()).slice(0, DETAIL_MAX_CHARS);
}

/** Collects per-tool timings from one session's stream events. */
export class SessionMetricsCollector {
  private readonly details = new Map<string, string | undefined>();
  private readonly tools: Record<string, ToolMetrics> = {};
  private slowest: SlowToolCall[] = [];
  private toolTimeMs = 0;

  observe(event: StreamEvent): void {
    if (event.type === 'tool-call') {
      this.details.set(event.toolCallId, detailFromArgs(event.args));
      return;
    }
    if (event.type !== 'tool-result') return;

    const tool = (this.tools[event.toolName] ??= { calls: 0, errors: 0, totalMs: 0 });
    tool.calls += 1;
    tool.totalMs += event.durationMs;
    if (event.isError) tool.errors += 1;
    this.toolTimeMs += event.durationMs;

    const detail = this.details.get(event.toolCallId);
    this.details.delete(event.toolCallId);
    this.slowest.push({ tool: event.toolName, ms: event.durationMs, ...(detail ? { detail } : {}) });
    this.slowest.sort((a, b) => b.ms - a.ms);
    this.slowest.length = Math.min(this.slowest.length, SLOWEST_KEPT);
  }

  summary(): Pick<SessionMetricsEntry, 'toolTimeMs' | 'tools' | 'slowest'> {
    return { toolTimeMs: this.toolTimeMs, tools: this.tools, slowest: this.slowest };
  }
}

export interface SessionMetricsInput {
  agentType: string;
  phase: string;
  subtaskId?: string;
  sessionNumber?: number;
  model: string;
  thinkingLevel?: string;
  startedAt: Date;
  /** Null when the session threw before producing a result. */
  result: SessionResult | null;
  collector: SessionMetricsCollector;
  now?: Date;
}

export function buildSessionEntry(input: SessionMetricsInput): SessionMetricsEntry {
  const { result, collector } = input;
  const elapsed = (input.now ?? new Date()).getTime() - input.startedAt.getTime();
  return {
    agentType: input.agentType,
    phase: input.phase,
    ...(input.subtaskId ? { subtaskId: input.subtaskId } : {}),
    ...(input.sessionNumber !== undefined ? { sessionNumber: input.sessionNumber } : {}),
    model: input.model,
    ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
    startedAt: input.startedAt.toISOString(),
    durationMs: result?.durationMs || elapsed,
    outcome: result?.outcome ?? 'threw',
    steps: result?.stepsExecuted ?? 0,
    toolCalls: result?.toolCallCount ?? 0,
    tokens: {
      input: result?.usage.promptTokens ?? 0,
      output: result?.usage.completionTokens ?? 0,
      cacheRead: result?.usage.cacheReadTokens ?? 0,
      cacheCreation: result?.usage.cacheCreationTokens ?? 0,
    },
    ...collector.summary(),
  };
}

function readSessions(path: string): SessionMetricsEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<RunMetricsFile>;
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch {
    return [];
  }
}

/**
 * Append one entry to `run_metrics.json` in each directory that exists.
 * Each task has one worker, so a task's file has a single writer; the rename
 * only protects a reader from seeing half a file.
 */
export function appendRunMetrics(directories: Array<string | undefined>, entry: SessionMetricsEntry): void {
  for (const directory of new Set(directories)) {
    if (!directory) continue;
    try {
      if (!existsSync(directory)) continue;
      const path = join(directory, RUN_METRICS_FILE);
      const file: RunMetricsFile = { version: 1, sessions: [...readSessions(path), entry] };
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, 'utf-8');
      renameSync(temporary, path);
    } catch {
      // Metrics must never affect a build.
    }
  }
}
