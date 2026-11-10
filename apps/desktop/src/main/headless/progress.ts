/**
 * zeenha fork: progress output for headless runs. Text mode prints readable
 * lines; json mode prints one JSON object per line on stdout.
 */
import type { ExecutionProgressData } from '../agent/types';
import { stripAnsiCodes } from '../../shared/utils/ansi-sanitizer';
import type { RunEvent, RunOutcome } from './outcome';

export interface ProgressReporterOptions {
  json?: boolean;
  verbose?: boolean;
  out?: (text: string) => void;
  err?: (text: string) => void;
  /** Secret values that must never be echoed. */
  redact?: string[];
}

export interface ResultInfo {
  spec?: string;
  branch?: string;
  worktree?: string;
}

export interface ProgressReporter {
  log(text: string): void;
  progress(data: ExecutionProgressData): void;
  taskEvent(event: RunEvent): void;
  error(message: string): void;
  summary(outcome: RunOutcome, info?: ResultInfo): void;
}

export function createProgressReporter(options: ProgressReporterOptions = {}): ProgressReporter {
  const json = options.json === true;
  const verbose = options.verbose === true;
  const out = options.out ?? ((t: string) => void process.stdout.write(t));
  const err = options.err ?? ((t: string) => void process.stderr.write(t));
  const secrets = (options.redact ?? []).filter((s) => s.length > 0);

  const clean = (text: string): string => {
    let result = stripAnsiCodes(text);
    for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
    return result;
  };
  const emit = (obj: Record<string, unknown>) => out(`${JSON.stringify(obj)}\n`);

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
      if (json) {
        emit({ type: 'progress', phase: data.phase, subtask: data.currentSubtask, message });
        return;
      }
      const detail = [data.currentSubtask, message].filter(Boolean).join(': ');
      out(`[${data.phase}]${detail ? ` ${detail}` : ''}\n`);
    },

    taskEvent(event) {
      if (json) {
        emit({ type: 'task-event', event: JSON.parse(clean(JSON.stringify(event))) });
      }
    },

    error(message) {
      const line = clean(message).replace(/\s+$/, '');
      if (json) {
        emit({ type: 'log', level: 'error', message: line });
      }
      err(`error: ${line}\n`);
    },

    summary(outcome, info = {}) {
      const reason = outcome.reason ? clean(outcome.reason) : undefined;
      if (json) {
        emit({ type: 'result', kind: outcome.kind, exitCode: outcome.exitCode, reason, ...info });
        return;
      }
      const parts = [`RESULT ${outcome.kind} exit=${outcome.exitCode}`];
      if (info.spec) parts.push(`spec=${info.spec}`);
      if (info.branch) parts.push(`branch=${info.branch}`);
      if (info.worktree) parts.push(`worktree=${info.worktree}`);
      out(`${parts.join(' ')}\n`);
      if (reason) err(`reason: ${reason}\n`);
    },
  };
}
