import type { TaskLogs, TaskLogPhase, TaskLogsDelta } from '../../../../shared/types';

const PHASES: TaskLogPhase[] = ['planning', 'coding', 'validation'];

/**
 * Apply an appended-entries delta to the current logs.
 * Returns null when the delta cannot be applied (no previous logs or the
 * entry count does not match baseCount), which signals the caller to resync
 * with a full load. Untouched phases keep their object reference.
 */
export function applyLogsDelta(prev: TaskLogs | null, delta: TaskLogsDelta): TaskLogs | null {
  if (!prev) return null;

  const phases = { ...prev.phases };
  for (const phase of PHASES) {
    const change = delta.phases[phase];
    if (!change) continue;
    const old = prev.phases[phase];
    if (!old || old.entries.length !== change.baseCount) return null;
    phases[phase] = {
      ...old,
      status: change.status,
      started_at: change.started_at,
      completed_at: change.completed_at,
      entries: change.entries.length > 0 ? [...old.entries, ...change.entries] : old.entries
    };
  }

  return { ...prev, updated_at: delta.updated_at, phases };
}
