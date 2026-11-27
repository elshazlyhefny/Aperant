/**
 * Electron-free core of the issue write-back dispatcher.
 *
 * zeenha fork: raw settings, metadata and writers are injected so the CLI can
 * reuse it. Writers are matched by the sourceType they declare and enabled by
 * their isEnabled hook or settingKey; this file does not name providers.
 * Nothing here throws.
 */

import type { Project } from '../../../shared/types';
import type { AppSettings, IssueWritebackSettings } from '../../../shared/types/settings';
import { normalizeIssueWritebackSettings } from '../../../shared/utils/issue-writeback-settings';
import type { DeliveryReceiptRecorder } from '../../delivery-receipts';
import type { WebhookEvent } from '../../task-webhook-core';
import type { OutcomeWriter } from '../forge/types';
import { buildOutcomeComment, isIssueOutcomeEvent } from './common';

export function isWriterEnabled(
  writer: OutcomeWriter,
  raw: Partial<AppSettings>,
  settings: IssueWritebackSettings
): boolean {
  if (writer.isEnabled) return writer.isEnabled(raw) === true;
  return writer.settingKey !== undefined && settings[writer.settingKey] === true;
}

/** True when at least one writer is switched on, so callers can skip reading metadata. */
export function anyWriterEnabled(writers: readonly OutcomeWriter[], raw: Partial<AppSettings>): boolean {
  const settings = normalizeIssueWritebackSettings(raw.issueWriteback);
  return writers.some((writer) => isWriterEnabled(writer, raw, settings));
}

export async function dispatchIssueOutcomeWith(input: {
  title?: string;
  prUrl?: string;
  project: Project;
  event: WebhookEvent;
  meta: Record<string, unknown> | null;
  /** The raw settings object (desktop settings file, or one built from the headless config). */
  raw: Partial<AppSettings>;
  writers: readonly OutcomeWriter[];
  recorder?: DeliveryReceiptRecorder;
}): Promise<void> {
  try {
    const { title, prUrl, project, event, meta, raw, writers, recorder } = input;
    // zeenha fork: pr_opened and account pauses are never written back (see OutcomeEvent).
    if (!isIssueOutcomeEvent(event)) return;
    const sourceType = meta ? String(meta.sourceType) : undefined;
    const writer = writers.find((w) => w.sourceType === sourceType);
    if (!writer || !meta) {
      // zeenha fork: enabled write-back without a registered source has no provider to report.
      if (recorder && anyWriterEnabled(writers, raw)) {
        const reason = meta?.sourceType == null || !sourceType?.trim() ? 'not_linked' : 'unsupported_source';
        await recorder.skip({ operation: 'issue_comment', event }, reason);
      }
      return;
    }
    const settings = normalizeIssueWritebackSettings(raw.issueWriteback);
    if (!isWriterEnabled(writer, raw, settings)) return;
    const text = buildOutcomeComment(event, title, prUrl);
    await writer.postOutcome({ meta, project, event, text, settings, ...(recorder && { recorder }) });
  } catch {
    // never let write-back problems affect task flow
  }
}
