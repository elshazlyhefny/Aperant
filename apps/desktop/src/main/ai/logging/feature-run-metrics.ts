/**
 * zeenha fork: token usage for the Roadmap and Ideation runners.
 *
 * Task sessions record their usage in a spec's `run_metrics.json` (see
 * ./run-metrics). Roadmap and Ideation call `streamText` directly and recorded
 * nothing, so what a roadmap refresh or an ideation run cost could not be
 * answered from any file. Each model session they run now appends one entry,
 * in the same format, to `run_metrics.json` in the runner's output directory
 * (`.auto-claude/roadmap/` or `.auto-claude/ideation/`).
 *
 * Recording must never affect a run: every failure here is swallowed.
 */

import type { SessionMetricsEntry } from '../../../shared/types/run-metrics';
import { appendRunMetrics, cleanErrorMessage } from './run-metrics';

interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * One usage object as a stream part carries it. The AI SDK v6 puts the cache
 * split in `inputTokenDetails`; the Claude Code engine reports it as
 * `cacheReadTokens` / `cacheCreationTokens` (as in session/runner.ts).
 */
export function normalizeUsage(usage: unknown): Tokens {
  if (usage === null || typeof usage !== 'object') return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const u = usage as Record<string, unknown>;
  const details = (u.inputTokenDetails ?? {}) as Record<string, unknown>;
  return {
    input: count(u.inputTokens),
    output: count(u.outputTokens),
    cacheRead: count(details.cacheReadTokens ?? u.cacheReadTokens ?? u.cachedInputTokens),
    cacheCreation: count(details.cacheWriteTokens ?? u.cacheCreationTokens),
  };
}

const isEmpty = (t: Tokens) => t.input + t.output === 0;

/** Tallies usage, steps and tool calls from one `streamText` full stream. */
export class StreamUsageMeter {
  private readonly stepTotal: Tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  private finishTotal: Tokens | null = null;
  steps = 0;
  toolCalls = 0;

  observe(part: { type: string; [key: string]: unknown }): void {
    switch (part.type) {
      case 'tool-call':
        this.toolCalls += 1;
        break;
      case 'finish-step': {
        this.steps += 1;
        const step = normalizeUsage(part.usage);
        this.stepTotal.input += step.input;
        this.stepTotal.output += step.output;
        this.stepTotal.cacheRead += step.cacheRead;
        this.stepTotal.cacheCreation += step.cacheCreation;
        break;
      }
      case 'finish': {
        const total = normalizeUsage(part.totalUsage);
        if (!isEmpty(total)) this.finishTotal = total;
        break;
      }
    }
  }

  /** The stream's own total when it sent one; otherwise the per-step tally (a cut-off stream). */
  tokens(): Tokens {
    return { ...(this.finishTotal ?? this.stepTotal) };
  }
}

/** A readable model id: the client's resolved id, else the model object's own. */
export function modelLabel(client: { resolvedModelId?: string; model?: unknown }): string {
  if (client.resolvedModelId) return client.resolvedModelId;
  const model = client.model;
  if (typeof model === 'string') return model;
  if (model && typeof model === 'object' && typeof (model as { modelId?: unknown }).modelId === 'string') {
    return (model as { modelId: string }).modelId;
  }
  return 'unknown';
}

export interface FeatureSessionInput {
  /** Directory that receives `run_metrics.json`; it must already exist. */
  directory: string;
  agentType: string;
  phase: string;
  model: string;
  thinkingLevel?: string;
  startedAt: Date;
  meter: StreamUsageMeter;
  /** `completed`, `error` (the stream reported one) or `threw`. */
  outcome: 'completed' | 'error' | 'threw';
  error?: unknown;
  now?: Date;
}

export function buildFeatureSessionEntry(input: FeatureSessionInput): SessionMetricsEntry {
  const end = input.now ?? new Date();
  const message =
    input.error === undefined ? undefined : input.error instanceof Error ? input.error.message : String(input.error);
  return {
    agentType: input.agentType,
    phase: input.phase,
    model: input.model,
    ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
    startedAt: input.startedAt.toISOString(),
    durationMs: Math.max(0, end.getTime() - input.startedAt.getTime()),
    toolTimeMs: 0,
    outcome: input.outcome,
    steps: input.meter.steps,
    toolCalls: input.meter.toolCalls,
    tokens: input.meter.tokens(),
    tools: {},
    slowest: [],
    ...(message !== undefined && input.outcome !== 'completed'
      ? { error: { code: input.outcome === 'threw' ? 'threw' : 'stream_error', message: cleanErrorMessage(message) } }
      : {}),
  };
}

/** Append one Roadmap or Ideation session. Never throws. */
export function recordFeatureSession(input: FeatureSessionInput): void {
  try {
    appendRunMetrics([input.directory], buildFeatureSessionEntry(input));
  } catch {
    // Metrics must never affect a run.
  }
}
