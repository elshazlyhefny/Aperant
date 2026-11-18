/**
 * Report a task's outcome back to the issue it came from.
 *
 * zeenha fork: uses the credentials already configured for import. Each provider
 * is opt-in through user settings (default off). Providers are looked up in the
 * forge registry; this file does not branch on provider names. Comment text is
 * built from allow-listed fields only; tokens, bodies and response text are
 * never logged. Nothing here throws. The Electron-free logic is in
 * issue-writeback-core.ts.
 */

import type { Project, Task } from '../../../shared/types';
import { getSpecsDir } from '../../../shared/constants';
import { readSettingsFile } from '../../settings-utils';
import { taskSpecDirs } from '../../task-failure-facts';
import type { WebhookEvent } from '../../task-webhook-core';
import { OUTCOME_WRITERS } from '../forge/registry';
import { readMetadata } from './common';
import { dispatchIssueOutcomeWith, normalizeIssueWritebackSettings } from './issue-writeback-core';

export function dispatchIssueOutcome(input: { task: Task; project: Project; event: WebhookEvent }): void {
  try {
    const { task, project, event } = input;
    if (event === 'pr_opened') return;
    const settings = normalizeIssueWritebackSettings(readSettingsFile() ?? {}, OUTCOME_WRITERS);
    if (!OUTCOME_WRITERS.some((writer) => settings[writer.settingKey])) return;

    const meta = readMetadata(taskSpecDirs(project.path, getSpecsDir(project.autoBuildPath), task.specId));
    void dispatchIssueOutcomeWith({
      title: task.title,
      prUrl: task.metadata?.prUrl,
      project,
      event,
      meta,
      settings,
      writers: OUTCOME_WRITERS
    });
  } catch {
    // never let write-back problems affect task flow
  }
}
