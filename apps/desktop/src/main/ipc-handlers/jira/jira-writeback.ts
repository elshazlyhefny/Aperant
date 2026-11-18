/**
 * Report a Jira-imported task's outcome back to the issue it came from.
 *
 * zeenha fork: desktop wrapper. Reads settings and task metadata, then hands off
 * to the Electron-free core in jira-writeback-core.ts. Nothing here throws.
 */

import type { Project, Task } from '../../../shared/types';
import { getSpecsDir } from '../../../shared/constants';
import { readSettingsFile } from '../../settings-utils';
import { taskSpecDirs } from '../../task-failure-facts';
import type { WebhookEvent } from '../../task-webhook-core';
import { readMetadata } from '../issue-writeback/common';
import { dispatchJiraOutcomeWith, normalizeJiraWritebackSettings } from './jira-writeback-core';

export { buildJiraComment } from './jira-writeback-core';

export function dispatchJiraOutcome(input: { task: Task; project: Project; event: WebhookEvent }): void {
  try {
    const { task, project, event } = input;
    if (event === 'pr_opened') return;
    const settings = normalizeJiraWritebackSettings(readSettingsFile() ?? {});
    if (settings.enabled !== true) return;
    const meta = readMetadata(taskSpecDirs(project.path, getSpecsDir(project.autoBuildPath), task.specId));
    void dispatchJiraOutcomeWith({
      title: task.title,
      prUrl: task.metadata?.prUrl,
      project,
      event,
      meta,
      settings
    });
  } catch {
    // never let Jira problems affect task flow
  }
}
