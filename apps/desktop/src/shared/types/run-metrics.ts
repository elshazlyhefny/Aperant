/**
 * zeenha fork: renderer-safe run metrics types. The main process records one
 * SessionMetricsEntry per agent session; RunMetricsSummary is the aggregate
 * shown for a task.
 */

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

export interface RunMetricsTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface RunMetricsGroup {
  key: string;
  sessions: number;
  durationMs: number;
  toolTimeMs: number;
  tokens: RunMetricsTokens;
}

export interface RunMetricsSummary {
  sessionCount: number;
  durationMs: number;
  toolTimeMs: number;
  tokens: RunMetricsTokens;
  byPhase: RunMetricsGroup[];
  byAgent: RunMetricsGroup[];
  byTool: Array<{ tool: string; calls: number; errors: number; totalMs: number }>;
  slowest: Array<SlowToolCall & { agentType: string; phase: string }>;
}
