/**
 * zeenha fork: the seam between PR feedback / outcome writeback and the code
 * hosts and trackers behind them. Adding a provider = one implementation file
 * plus one entry in registry.ts.
 */

import type { Project } from '../../../shared/types';
import type { IssueWritebackSettings } from '../../../shared/types/settings';
import type { WebhookEvent } from '../../task-webhook';
import type { PRFeedbackFetchResult } from '../github/pr/task-feedback';

/** Provider-neutral names for the shared feedback error and result shape. */
export { PRFeedbackError } from '../github/pr/task-feedback';
export type { PRFeedbackFetchResult };

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

/** A code host's pull requests: resolves its PR/MR URLs and loads CI + review feedback. */
export interface PRHost {
  providerId: string;
  resolvePR(prUrl: string): PRRef | null;
  loadFeedback(project: Project, prUrl: string, ref: PRRef): Promise<ForgeLoadResult>;
  /** Shown when the project has no usable credentials for this forge. */
  notConfiguredMessage: string;
}

/** A code host that can also post task outcomes to its issues. */
export interface Forge extends PRHost, OutcomeWriter {}

/** True when a code host also writes task outcomes back (Bitbucket does not). */
export function isOutcomeWriter(host: PRHost): host is Forge {
  return typeof (host as Partial<Forge>).postOutcome === 'function';
}
