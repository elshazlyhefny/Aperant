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
import type { AppSettings, IssueWritebackSettings } from '../../../shared/types/settings';
import { normalizeIssueWritebackSettings } from '../../../shared/utils/issue-writeback-settings';
import { getSpecsDir } from '../../../shared/constants';
import { readSettingsFile } from '../../settings-utils';
import { taskSpecDirs } from '../../task-failure-facts';
import type { WebhookEvent } from '../../task-webhook';
import { OUTCOME_WRITERS, getOutcomeWriter } from '../forge/registry';
import type { OutcomeWriter } from '../forge/types';
import { buildOutcomeComment, readMetadata } from './common';

function isWriterEnabled(
  writer: OutcomeWriter,
  raw: Partial<AppSettings>,
  settings: IssueWritebackSettings
): boolean {
  if (writer.isEnabled) return writer.isEnabled(raw) === true;
  return writer.settingKey !== undefined && settings[writer.settingKey] === true;
}

export function dispatchIssueOutcome(input: { task: Task; project: Project; event: WebhookEvent }): void {
  try {
    const { task, project, event } = input;
    if (event === 'pr_opened') return;
    const raw = (readSettingsFile() ?? {}) as Partial<AppSettings>;
    const settings = normalizeIssueWritebackSettings(raw.issueWriteback);
    if (!OUTCOME_WRITERS.some((writer) => isWriterEnabled(writer, raw, settings))) return;

    const meta = readMetadata(taskSpecDirs(project.path, getSpecsDir(project.autoBuildPath), task.specId));
    if (!meta) return;
    const text = buildOutcomeComment(event, task.title, task.metadata?.prUrl);

    const writer = getOutcomeWriter(String(meta.sourceType));
    if (writer && isWriterEnabled(writer, raw, settings)) {
      writer.postOutcome({ meta, project, event, text, settings });
    }
  } catch {
    // never let write-back problems affect task flow
  }
}
