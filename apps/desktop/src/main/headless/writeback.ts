/**
 * zeenha fork: report a headless run's outcome back to the source issue.
 *
 * Electron-free on purpose: only the issue write-back core, the headless writers
 * (Jira included) and the default settings. Nothing here throws, and nothing is logged that could
 * contain a token, a URL or issue text.
 */

import { DEFAULT_APP_SETTINGS } from '../../shared/constants/config';
import type { Project } from '../../shared/types';
import type { AppSettings, IssueWritebackSettings, JiraWritebackSettings } from '../../shared/types/settings';
import { normalizeIssueWritebackSettings } from '../../shared/utils/issue-writeback-settings';
import { createHeadlessWriters } from '../ipc-handlers/forge/headless-writers';
import { readMetadata } from '../ipc-handlers/issue-writeback/common';
import { dispatchIssueOutcomeWith } from '../ipc-handlers/issue-writeback/issue-writeback-core';
import type { WebhookEvent } from '../task-webhook-core';
import type { HeadlessConfig } from './config';
import type { RunOutcome } from './outcome';

export interface HeadlessWritebackSettings {
  issue: IssueWritebackSettings;
  jira: JiraWritebackSettings;
}

/** Defaults come from the app settings constants; every provider is off unless configured. */
export function resolveHeadlessWritebackSettings(config: HeadlessConfig): HeadlessWritebackSettings {
  const jiraDefaults = DEFAULT_APP_SETTINGS.jiraWriteback;
  const wb = config.writeback ?? {};
  const jira = wb.jira ?? {};
  return {
    issue: normalizeIssueWritebackSettings({ github: wb.github, gitlab: wb.gitlab, linear: wb.linear }),
    jira: {
      enabled: jira.enabled ?? jiraDefaults.enabled,
      comment: jira.comment ?? jiraDefaults.comment,
      transitionOnReview: jira.transitionOnReview ?? jiraDefaults.transitionOnReview,
      transitionStatusName: jira.transitionStatusName ?? jiraDefaults.transitionStatusName
    }
  };
}

/** Mirrors eventsForOutcome in webhook.ts; pr_opened is never written back. */
export function writebackEventForOutcome(outcome: RunOutcome): WebhookEvent {
  if (outcome.kind === 'success') return 'review_ready';
  if (outcome.kind === 'qa_failed') return 'blocked';
  return 'failed';
}

export function isWritebackEnabled(settings: HeadlessWritebackSettings): boolean {
  return settings.issue.github || settings.issue.gitlab || settings.issue.linear || settings.jira.enabled;
}

export interface ReportOutcomeToSourceInput {
  settings: HeadlessWritebackSettings;
  project: Project;
  specDirs: string[];
  event: WebhookEvent;
  title: string;
  prUrl?: string;
  env?: NodeJS.ProcessEnv;
  dispatchIssue?: typeof dispatchIssueOutcomeWith;
  warn?: (message: string) => void;
}

/** Write the outcome back to the source issue. Never throws; never changes the run result. */
export async function reportOutcomeToSource(input: ReportOutcomeToSourceInput): Promise<void> {
  const warn = (message: string): void => {
    try {
      input.warn?.(message);
    } catch {
      // never throw from logging
    }
  };
  try {
    const { settings, project, specDirs, event, title, prUrl } = input;
    if (!isWritebackEnabled(settings)) return;
    const meta = readMetadata(specDirs);
    const dispatchIssue = input.dispatchIssue ?? dispatchIssueOutcomeWith;
    const raw: Partial<AppSettings> = { issueWriteback: settings.issue, jiraWriteback: settings.jira };
    try {
      await dispatchIssue({
        title,
        prUrl,
        project,
        event,
        meta,
        raw,
        writers: createHeadlessWriters(input.env ?? process.env, settings.jira)
      });
    } catch {
      warn('issue write-back failed; the run result is unchanged');
    }
  } catch {
    warn('write-back failed; the run result is unchanged');
  }
}
