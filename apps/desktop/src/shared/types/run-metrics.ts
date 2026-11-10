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

/** zeenha fork: token budget state for a task. `limit` undefined = unlimited. */
export interface TokenBudgetStatus {
  limit?: number;
  used: number;
  source: 'task' | 'project' | 'none';
}

export interface TaskRunMetrics {
  sessions: SessionMetricsEntry[];
  summary: RunMetricsSummary;
}

/** zeenha fork: request for project-wide metrics; null periodDays means all time. */
export interface ProjectRunMetricsRequest {
  periodDays: number | null;
}

/** zeenha fork: tasks/sessions/tokens aggregated by phase or model. */
export interface ProjectRunMetricsGroup {
  key: string;
  tasks: number;
  sessions: number;
  durationMs: number;
  tokens: RunMetricsTokens;
  totalTokens: number;
}

/** zeenha fork: one day of the delivery trend. */
export interface ProjectRunMetricsTrendPoint {
  /** YYYY-MM-DD */
  date: string;
  completedTasks: number;
  totalTokens: number;
  tokensPerCompletedTask: number | null;
}

/** zeenha fork: project-wide delivery and token metrics. */
export interface ProjectRunMetrics {
  periodDays: number | null;
  generatedAt: string;
  /** Tasks scanned in the period. */
  taskCount: number;
  /** Tasks with valid metrics. */
  included: number;
  excluded: { missing: number; corrupt: number };
  completedTasks: number;
  failedBeforeWork: {
    count: number;
    /** Capped at 50 entries. */
    tasks?: Array<{ specId: string; title?: string }>;
  };
  totals: {
    sessions: number;
    durationMs: number;
    tokens: RunMetricsTokens;
    totalTokens: number;
  };
  /** Null when there are no completed tasks. */
  perCompletedTask: { totalTokens: number; durationMs: number } | null;
  qa: {
    tasksWithQa: number;
    totalIterations: number;
    /** Null when no task has QA. */
    averageIterations: number | null;
  };
  byPhase: ProjectRunMetricsGroup[];
  byModel: ProjectRunMetricsGroup[];
  trend: ProjectRunMetricsTrendPoint[];
}
