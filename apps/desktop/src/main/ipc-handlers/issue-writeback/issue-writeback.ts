/**
 * Report a task's outcome back to the issue it came from.
 *
 * zeenha fork: uses the credentials already configured for import. Each provider
 * is opt-in through user settings (default off). Providers are looked up in the
 * forge registry; this file does not branch on provider names. Comment text is
 * built from allow-listed fields only; tokens, bodies and response text are
 * never logged. Nothing here throws.
 */

import type { Project, Task } from '../../../shared/types';
import type { IssueWritebackSettings } from '../../../shared/types/settings';
import { DEFAULT_APP_SETTINGS } from '../../../shared/constants/config';
import { getSpecsDir } from '../../../shared/constants';
import { readSettingsFile } from '../../settings-utils';
import { taskSpecDirs } from '../../task-failure-facts';
import type { WebhookEvent } from '../../task-webhook';
import { OUTCOME_WRITERS, getOutcomeWriter } from '../forge/registry';
import { buildOutcomeComment, readMetadata } from './common';

function loadSettings(): IssueWritebackSettings {
  const raw = readSettingsFile() ?? {};
  const def = DEFAULT_APP_SETTINGS.issueWriteback;
  const w = (raw as { issueWriteback?: Partial<IssueWritebackSettings> }).issueWriteback ?? {};
  const settings = { ...def };
  for (const writer of OUTCOME_WRITERS) {
    settings[writer.settingKey] = w[writer.settingKey] === true ? true : def[writer.settingKey];
  }
  return settings;
}

export function dispatchIssueOutcome(input: { task: Task; project: Project; event: WebhookEvent }): void {
  try {
    const { task, project, event } = input;
    if (event === 'pr_opened') return;
    const settings = loadSettings();
    if (!OUTCOME_WRITERS.some((writer) => settings[writer.settingKey])) return;

    const meta = readMetadata(taskSpecDirs(project.path, getSpecsDir(project.autoBuildPath), task.specId));
    if (!meta) return;
    const text = buildOutcomeComment(event, task.title, task.metadata?.prUrl);

    const writer = getOutcomeWriter(String(meta.sourceType));
    if (writer && settings[writer.settingKey]) writer.postOutcome({ meta, project, event, text });
  } catch {
    // never let write-back problems affect task flow
  }
}
