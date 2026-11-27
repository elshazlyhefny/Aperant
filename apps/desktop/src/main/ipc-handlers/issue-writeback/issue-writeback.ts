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
import type { AppSettings } from '../../../shared/types/settings';
import { getSpecsDir } from '../../../shared/constants';
import type { DeliveryReceiptRecorder } from '../../delivery-receipts';
import { readSettingsFile } from '../../settings-utils';
import { taskSpecDirs } from '../../task-failure-facts';
import type { WebhookEvent } from '../../task-webhook-core';
import { OUTCOME_WRITERS } from '../forge/registry';
import { isIssueOutcomeEvent, readMetadata } from './common';
import { anyWriterEnabled, dispatchIssueOutcomeWith } from './issue-writeback-core';

export async function dispatchIssueOutcome(
  input: { task: Task; project: Project; event: WebhookEvent },
  recorder?: DeliveryReceiptRecorder
): Promise<void> {
  try {
    const { task, project, event } = input;
    // zeenha fork: pr_opened and account pauses are webhook-only (see OutcomeEvent).
    if (!isIssueOutcomeEvent(event)) return;
    const raw = (readSettingsFile() ?? {}) as Partial<AppSettings>;
    if (!anyWriterEnabled(OUTCOME_WRITERS, raw)) return;

    const meta = readMetadata(taskSpecDirs(project.path, getSpecsDir(project.autoBuildPath), task.specId));
    await dispatchIssueOutcomeWith({
      title: task.title,
      prUrl: task.metadata?.prUrl,
      project,
      event,
      meta,
      raw,
      writers: OUTCOME_WRITERS,
      recorder
    });
  } catch {
    // never let write-back problems affect task flow
  }
}
