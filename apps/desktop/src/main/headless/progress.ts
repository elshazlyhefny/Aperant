/**
 * zeenha fork: progress output for headless runs. Text mode prints readable
 * lines; json mode prints one JSON object per line on stdout.
 */
import type { ExecutionProgressData } from '../agent/types';
import type { DeliveryReceipt } from '../../shared/types/delivery-receipt';
import { stripAnsiCodes } from '../../shared/utils/ansi-sanitizer';
import type { RunEvent, RunOutcome } from './outcome';
import type { HeadlessTokenBudget } from './token-budget';

export interface ProgressReporterOptions {
  json?: boolean;
  verbose?: boolean;
  /** Task correlation for daemon child records. */
  taskId?: string;
  out?: (text: string) => void;
  err?: (text: string) => void;
  /** Secret values that must never be echoed. */
  redact?: string[];
}

export interface ResultInfo {
  spec?: string;
  branch?: string;
  worktree?: string;
  tokenBudget?: { limit: number | null; source: string };
}

export interface ProgressReporter {
  log(text: string): void;
  progress(data: ExecutionProgressData): void;
  taskEvent(event: RunEvent): void;
  tokenBudget(budget: HeadlessTokenBudget): void;
  error(message: string): void;
  deliveryReceipts(spec: string, receipts: DeliveryReceipt[]): void;
  summary(outcome: RunOutcome, info?: ResultInfo): void;
}

export function createProgressReporter(options: ProgressReporterOptions = {}): ProgressReporter {
  const json = options.json === true;
  const verbose = options.verbose === true;
  const out = options.out ?? ((t: string) => void process.stdout.write(t));
  const err = options.err ?? ((t: string) => void process.stderr.write(t));
  const secrets = options.redact ?? [];

  const clean = (text: string): string => {
    let result = stripAnsiCodes(text);
    for (const secret of secrets) {
      if (secret) result = result.split(secret).join('[REDACTED]');
    }
    return result;
  };
  const emit = (obj: Record<string, unknown>) =>
    out(`${JSON.stringify(options.taskId === undefined ? obj : { ...obj, taskId: options.taskId })}\n`);

  let lastPhase: string | undefined;
  let lastSubtask: string | undefined;

  return {
    log(text) {
      const line = clean(text).replace(/\s+$/, '');
      if (!line) return;
      if (json) {
        emit({ type: 'log', message: line });
        return;
      }
      if (verbose) out(`${line}\n`);
    },

    progress(data) {
      if (data.phase === lastPhase && data.currentSubtask === lastSubtask) return;
      lastPhase = data.phase;
      lastSubtask = data.currentSubtask;
      const message = data.message ? clean(data.message) : undefined;
      const subtask = data.currentSubtask ? clean(data.currentSubtask) : data.currentSubtask;
      if (json) {
        emit({ type: 'progress', phase: data.phase, subtask, message });
        return;
      }
      const detail = [subtask, message].filter(Boolean).join(': ');
      out(`[${clean(data.phase)}]${detail ? ` ${detail}` : ''}\n`);
    },

    taskEvent(event) {
      if (json) {
        const safeEvent = JSON.stringify(event, (_key, value) => typeof value === 'string' ? clean(value) : value);
        emit({ type: 'task-event', event: JSON.parse(safeEvent) });
      }
    },

    // zeenha fork: report the effective budget and its source in both output modes.
    tokenBudget({ limit, source }) {
      if (json) {
        emit({ type: 'token-budget', limit: limit ?? null, source });
        return;
      }
      const label = limit === undefined ? 'unlimited' : `${limit} tokens`;
      out(`token budget: ${label} (source: ${source})\n`);
    },

    error(message) {
      const line = clean(message).replace(/\s+$/, '');
      if (json) {
        emit({ type: 'log', level: 'error', message: line });
      }
      err(`error: ${line}\n`);
    },

    // zeenha fork: only store/recorder projections enter delivery output.
    deliveryReceipts(spec, receipts) {
      if (json) {
        emit({ type: 'delivery-receipts', spec, receipts });
        return;
      }
      if (receipts.length === 0) out(`No delivery history for ${spec}\n`);
      for (const receipt of receipts) {
        const parts = [`DELIVERY spec=${spec}`, receipt.createdAt, receipt.operation, receipt.event, receipt.status];
        if (receipt.provider) parts.push(`provider=${receipt.provider}`);
        if (receipt.reason) parts.push(`reason=${receipt.reason}`);
        if (receipt.attempts !== undefined) parts.push(`attempts=${receipt.attempts}`);
        if (receipt.httpStatus !== undefined) parts.push(`http=${receipt.httpStatus}`);
        out(`${parts.join(' ')}\n`);
      }
    },

    summary(outcome, info = {}) {
      const reason = outcome.reason ? clean(outcome.reason) : undefined;
      const { spec, branch, worktree, tokenBudget } = info;
      if (json) {
        emit({ type: 'result', kind: outcome.kind, exitCode: outcome.exitCode, reason,
          spec: spec === undefined ? undefined : clean(spec),
          branch: branch === undefined ? undefined : clean(branch),
          worktree: worktree === undefined ? undefined : clean(worktree),
          tokenBudget: tokenBudget === undefined ? undefined : { limit: tokenBudget.limit, source: clean(tokenBudget.source) } });
        return;
      }
      const parts = [`RESULT ${outcome.kind} exit=${outcome.exitCode}`];
      if (spec) parts.push(`spec=${clean(spec)}`);
      if (branch) parts.push(`branch=${clean(branch)}`);
      if (worktree) parts.push(`worktree=${clean(worktree)}`);
      out(`${parts.join(' ')}\n`);
      if (reason) err(`reason: ${reason}\n`);
    },
  };
}
