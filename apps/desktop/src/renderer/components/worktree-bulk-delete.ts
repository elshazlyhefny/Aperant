// zeenha fork: Report per-worktree delete outcomes and retry only failures confirmed by a fresh list.
export const TASK_PREFIX = 'task:';
export const TERMINAL_PREFIX = 'terminal:';

export type BulkDeleteOutcome = 'deleted' | 'failed';

type WorktreeKind = 'task' | 'terminal';

export interface BulkDeleteAttempt {
  id: string;
  kind: WorktreeKind;
  name: string;
  outcome: BulkDeleteOutcome;
  reason?: string;
}

export interface BulkDeleteReport {
  attempts: BulkDeleteAttempt[];
  deletedCount: number;
  failedCount: number;
  refreshFailed: boolean;
  refreshError?: string;
  retainedFailedIds: string[];
}

type BulkDeleteRefresh =
  | { ok: true; taskSpecNames: Iterable<string>; terminalNames: Iterable<string> }
  | { ok: false; error?: string };

export function parseSelectionId(id: string): { kind: WorktreeKind; key: string } | null {
  if (id.startsWith(TASK_PREFIX)) {
    return { kind: 'task', key: id.slice(TASK_PREFIX.length) };
  }
  if (id.startsWith(TERMINAL_PREFIX)) {
    return { kind: 'terminal', key: id.slice(TERMINAL_PREFIX.length) };
  }
  return null;
}

export function taskWorktreeDisplayName(specName: string, taskTitle?: string): string {
  return taskTitle ? `${taskTitle} (${specName})` : specName;
}

export function summarizeAttempts(attempts: readonly BulkDeleteAttempt[]): {
  deletedCount: number;
  failedCount: number;
  failed: BulkDeleteAttempt[];
} {
  const failed = attempts.filter((attempt) => attempt.outcome === 'failed');
  return { deletedCount: attempts.length - failed.length, failedCount: failed.length, failed };
}

export function retainFailedIds(
  attempts: readonly BulkDeleteAttempt[],
  freshTaskSpecNames: Iterable<string>,
  freshTerminalNames: Iterable<string>
): string[] {
  const freshNames = {
    task: new Set(freshTaskSpecNames),
    terminal: new Set(freshTerminalNames)
  };
  const retainedFailedIds: string[] = [];
  for (const attempt of attempts) {
    if (attempt.outcome !== 'failed') continue;

    const selection = parseSelectionId(attempt.id);
    if (selection && freshNames[selection.kind].has(selection.key)) {
      retainedFailedIds.push(attempt.id);
    }
  }
  return retainedFailedIds;
}

export function buildBulkDeleteReport(
  attempts: readonly BulkDeleteAttempt[],
  refresh: BulkDeleteRefresh
): BulkDeleteReport {
  const { deletedCount, failedCount } = summarizeAttempts(attempts);
  return {
    attempts: [...attempts],
    deletedCount,
    failedCount,
    refreshFailed: !refresh.ok,
    ...(!refresh.ok && refresh.error !== undefined ? { refreshError: refresh.error } : {}),
    retainedFailedIds: refresh.ok
      ? retainFailedIds(attempts, refresh.taskSpecNames, refresh.terminalNames)
      : []
  };
}
