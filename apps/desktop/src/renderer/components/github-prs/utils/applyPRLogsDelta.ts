import type { PRLogs, PRLogPhase, PRLogsDelta } from '../../../../preload/api/modules/github-api';

const PHASES: PRLogPhase[] = ['context', 'analysis', 'synthesis'];

/**
 * Apply an appended-entries delta to the current PR review logs.
 * Returns null when the delta cannot be applied (no previous logs, a different
 * review, or an entry count that does not match baseCount), which signals the
 * caller to resync with a full load. Untouched phases keep their reference.
 */
export function applyPRLogsDelta(prev: PRLogs | null, delta: PRLogsDelta): PRLogs | null {
  if (!prev) return null;
  if (prev.pr_number !== delta.pr_number || prev.created_at !== delta.created_at) return null;

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
