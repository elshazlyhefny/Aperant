import type { AppSettings } from '../../shared/types/settings';
import type { TaskMetadata } from '../../shared/types/task';
import { taskPhaseMetadata } from '../../shared/utils/task-agent';

/**
 * zeenha fork: apply the Settings default task agent (Claude, Codex or both)
 * to the metadata of a task that is about to be written.
 *
 * Execution reads its provider routing only from task_metadata.json
 * (ai/agent/phase-connection.ts). Every path that creates a task (the task
 * dialog, GitHub, GitLab, Jira, Linear, Azure Boards, Ideation, Roadmap,
 * Insights) must therefore apply the default itself, or its tasks silently
 * run on the legacy Claude profile.
 *
 * The default applies only when `defaultTaskAgent` is set and the metadata
 * carries no explicit agent choice (taskAgentMode, provider, model,
 * phaseProviders or phaseModels), so an explicit or custom per-task setup is
 * never overridden.
 *
 * Without a default task agent, an active cross-provider (mixed) agent profile
 * applies instead, as the task dialog does. Otherwise tasks from these sources
 * ignored the mixed profile and every phase ran on whichever account came first
 * in the priority queue. With neither set the metadata is returned unchanged.
 */
export function applyDefaultTaskAgent<T extends TaskMetadata>(
  metadata: T,
  settings: Partial<AppSettings> | undefined
): T {
  const selection = settings?.defaultTaskAgent;
  const mixed = settings?.customMixedProfileActive ? settings.customMixedPhaseConfig : undefined;
  if (!selection && !mixed) return metadata;
  if (
    metadata.taskAgentMode ||
    metadata.provider ||
    metadata.model ||
    metadata.phaseProviders ||
    metadata.phaseModels
  ) {
    return metadata;
  }
  if (selection) {
    return { ...metadata, ...taskPhaseMetadata(selection.phases), taskAgentMode: selection.mode };
  }
  return { ...metadata, ...taskPhaseMetadata(mixed as NonNullable<typeof mixed>) };
}
