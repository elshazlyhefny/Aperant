/**
 * Electron-free core of the issue write-back dispatcher.
 *
 * zeenha fork: settings, metadata and writers are injected so the CLI daemon can
 * reuse it. Writers are matched by the sourceType and settingKey they declare;
 * this file does not name providers. Nothing here throws.
 */

import type { Project } from '../../../shared/types';
import type { IssueWritebackSettings } from '../../../shared/types/settings';
import { DEFAULT_APP_SETTINGS } from '../../../shared/constants/config';
import type { WebhookEvent } from '../../task-webhook-core';
import type { OutcomeWriter } from '../forge/types';
import { buildOutcomeComment } from './common';

export function normalizeIssueWritebackSettings(
  raw: unknown,
  writers: readonly OutcomeWriter[]
): IssueWritebackSettings {
  const def = DEFAULT_APP_SETTINGS.issueWriteback;
  const stored = (raw as { issueWriteback?: Partial<IssueWritebackSettings> } | null | undefined)?.issueWriteback ?? {};
  const settings = { ...def };
  for (const writer of writers) {
    settings[writer.settingKey] = stored[writer.settingKey] === true ? true : def[writer.settingKey];
  }
  return settings;
}

export async function dispatchIssueOutcomeWith(input: {
  title?: string;
  prUrl?: string;
  project: Project;
  event: WebhookEvent;
  meta: Record<string, unknown> | null;
  settings: IssueWritebackSettings;
  writers: readonly OutcomeWriter[];
}): Promise<void> {
  try {
    const { title, prUrl, project, event, meta, settings, writers } = input;
    if (event === 'pr_opened' || !meta) return;
    const writer = writers.find((w) => w.sourceType === String(meta.sourceType));
    if (!writer || settings[writer.settingKey] !== true) return;
    const text = buildOutcomeComment(event, title, prUrl);
    await writer.postOutcome({ meta, project, event, text });
  } catch {
    // never let write-back problems affect task flow
  }
}
