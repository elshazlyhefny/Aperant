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

import type {
  RunMetricsGroup,
  RunMetricsSummary,
  SessionMetricsEntry,
  SlowToolCall,
  ToolMetrics,
} from '../../../shared/types/run-metrics';
import type { SessionResult, StreamEvent } from '../session/types';

export const RUN_METRICS_FILE = 'run_metrics.json';

const SLOWEST_KEPT = 5;
const DETAIL_MAX_CHARS = 120;

export type { SessionMetricsEntry, SlowToolCall, ToolMetrics };

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
    if (!parsed || !Array.isArray(parsed.sessions)) return [];
    return parsed.sessions.filter((s) => s !== null && typeof s === 'object' && !Array.isArray(s));
  } catch {
    return [];
  }
}

/** Read a spec directory's recorded sessions; a missing or corrupt file gives []. */
export function readRunMetrics(directory: string): SessionMetricsEntry[] {
  return readSessions(join(directory, RUN_METRICS_FILE));
}

// zeenha fork: exported so the project-wide aggregator shares the same guards.
export const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export const emptyTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });

function addGroup(groups: Map<string, RunMetricsGroup>, key: string, entry: SessionMetricsEntry): void {
  const group =
    groups.get(key) ?? { key, sessions: 0, durationMs: 0, toolTimeMs: 0, tokens: emptyTokens() };
  group.sessions += 1;
  group.durationMs += num(entry.durationMs);
  group.toolTimeMs += num(entry.toolTimeMs);
  group.tokens.input += num(entry.tokens?.input);
  group.tokens.output += num(entry.tokens?.output);
  group.tokens.cacheRead += num(entry.tokens?.cacheRead);
  group.tokens.cacheCreation += num(entry.tokens?.cacheCreation);
  groups.set(key, group);
}

/** Pure aggregate of a task's sessions. Tolerates entries with missing fields. */
export function aggregateRunMetrics(entries: SessionMetricsEntry[]): RunMetricsSummary {
  const phases = new Map<string, RunMetricsGroup>();
  const agents = new Map<string, RunMetricsGroup>();
  const tools = new Map<string, { tool: string; calls: number; errors: number; totalMs: number }>();
  const slowest: RunMetricsSummary['slowest'] = [];
  const summary: RunMetricsSummary = {
    sessionCount: 0,
    durationMs: 0,
    toolTimeMs: 0,
    tokens: emptyTokens(),
    byPhase: [],
    byAgent: [],
    byTool: [],
    slowest: [],
  };

  for (const entry of entries) {
    summary.sessionCount += 1;
    summary.durationMs += num(entry.durationMs);
    summary.toolTimeMs += num(entry.toolTimeMs);
    summary.tokens.input += num(entry.tokens?.input);
    summary.tokens.output += num(entry.tokens?.output);
    summary.tokens.cacheRead += num(entry.tokens?.cacheRead);
    summary.tokens.cacheCreation += num(entry.tokens?.cacheCreation);

    const phase = typeof entry.phase === 'string' ? entry.phase : 'unknown';
    const agentType = typeof entry.agentType === 'string' ? entry.agentType : 'unknown';
    addGroup(phases, phase, entry);
    addGroup(agents, agentType, entry);

    for (const [tool, metrics] of Object.entries(entry.tools ?? {})) {
      const merged = tools.get(tool) ?? { tool, calls: 0, errors: 0, totalMs: 0 };
      merged.calls += num(metrics?.calls);
      merged.errors += num(metrics?.errors);
      merged.totalMs += num(metrics?.totalMs);
      tools.set(tool, merged);
    }

    if (Array.isArray(entry.slowest)) {
      for (const call of entry.slowest) {
        if (call && typeof call.tool === 'string') {
          slowest.push({ ...call, ms: num(call.ms), agentType, phase });
        }
      }
    }
  }

  summary.byPhase = [...phases.values()];
  summary.byAgent = [...agents.values()];
  summary.byTool = [...tools.values()].sort((a, b) => b.totalMs - a.totalMs);
  summary.slowest = slowest.sort((a, b) => b.ms - a.ms).slice(0, SLOWEST_KEPT);
  return summary;
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
