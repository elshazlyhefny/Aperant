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
 * never overridden. With no default set the metadata is returned unchanged,
 * so existing installs keep their configured profile.
 */
export function applyDefaultTaskAgent<T extends TaskMetadata>(
  metadata: T,
  settings: Partial<AppSettings> | undefined
): T {
  const selection = settings?.defaultTaskAgent;
  if (!selection) return metadata;
  if (
    metadata.taskAgentMode ||
    metadata.provider ||
    metadata.model ||
    metadata.phaseProviders ||
    metadata.phaseModels
  ) {
    return metadata;
  }
  return { ...metadata, ...taskPhaseMetadata(selection.phases), taskAgentMode: selection.mode };
}
