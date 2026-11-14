/**
 * zeenha fork: the seam between PR feedback / outcome writeback and the code
 * hosts and trackers behind them. Adding a provider = one implementation file
 * plus one entry in registry.ts.
 */

import type { Project } from '../../../shared/types';
import type { IssueWritebackSettings } from '../../../shared/types/settings';
import type { WebhookEvent } from '../../task-webhook';
import type { PRFeedbackFetchResult } from '../github/pr/task-feedback';

export type PRRef = { provider: string; number: number };

export type ForgeLoadResult =
  | { ok: true; fetched: PRFeedbackFetchResult }
  | { ok: false; code: 'not_configured'; error: string };

/** Posts a task outcome comment to the issue a task came from. Fire-and-forget, never throws. */
export interface OutcomeWriter {
  /** Value of task_metadata.json `sourceType` this writer handles. */
  sourceType: string;
  /** Key of the opt-in flag in IssueWritebackSettings. */
  settingKey: keyof IssueWritebackSettings;
  postOutcome(input: {
    meta: Record<string, unknown>;
    project: Project;
    event: WebhookEvent;
    text: string;
  }): void;
}

/** A code host: resolves its PR/MR URLs, loads CI + review feedback, and can post outcomes. */
export interface Forge extends OutcomeWriter {
  providerId: string;
  resolvePR(prUrl: string): PRRef | null;
  loadFeedback(project: Project, prUrl: string, ref: PRRef): Promise<ForgeLoadResult>;
  /** Shown when the project has no usable credentials for this forge. */
  notConfiguredMessage: string;
}
