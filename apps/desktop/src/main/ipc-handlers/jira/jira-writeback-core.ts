/**
 * Electron-free core of the Jira write-back dispatcher.
 *
 * zeenha fork: reports to the same Jira site/issue the user imported from, using
 * the credentials already used for import. Settings and metadata are injected so
 * the CLI daemon can reuse it. Comments are built from allow-listed fields only;
 * errors, paths, logs and tokens are never sent or logged. Nothing here throws.
 */

import type { Project } from '../../../shared/types';
import type { JiraWritebackSettings } from '../../../shared/types/settings';
import { DEFAULT_APP_SETTINGS } from '../../../shared/constants/config';
import { appLogPort } from '../../log-port';
import type { WebhookEvent } from '../../task-webhook-core';
import { type OutcomeEvent, buildOutcomeComment } from '../issue-writeback/common';
import { JiraAPIError, addIssueComment, isValidIssueKey, normalizeJiraSiteUrl, transitionIssue } from './jira-client';
import { type JiraConfig, getJiraConfig } from './jira-config';

export function buildJiraComment(input: { event: OutcomeEvent; taskTitle?: string; prUrl?: string }): string {
  return buildOutcomeComment(input.event, input.taskTitle, input.prUrl);
}

export function normalizeJiraWritebackSettings(raw: unknown): JiraWritebackSettings {
  const def = DEFAULT_APP_SETTINGS.jiraWriteback;
  const w = (raw as { jiraWriteback?: Partial<JiraWritebackSettings> } | null | undefined)?.jiraWriteback ?? {};
  return {
    enabled: w.enabled === true,
    comment: typeof w.comment === 'boolean' ? w.comment : def.comment,
    transitionOnReview: w.transitionOnReview === true,
    transitionStatusName: typeof w.transitionStatusName === 'string' ? w.transitionStatusName : def.transitionStatusName
  };
}

function warn(event: string, issueKey: string, what: string, err: unknown): void {
  try {
    const detail = err instanceof JiraAPIError
      ? `${err.message}${err.statusCode ? ` (HTTP ${err.statusCode})` : ''}`
      : err instanceof Error ? err.name : 'UnknownError';
    appLogPort.warn(`[JiraWriteback] ${what} failed event=${event} issue=${issueKey} reason=${detail}`);
  } catch {
    // never throw from logging
  }
}

export async function dispatchJiraOutcomeWith(input: {
  title?: string;
  prUrl?: string;
  project: Project;
  event: WebhookEvent;
  meta: Record<string, unknown> | null;
  settings: JiraWritebackSettings;
  getConfig?: (project: Project) => JiraConfig | null;
}): Promise<void> {
  try {
    const { title, prUrl, project, event, meta, settings, getConfig = getJiraConfig } = input;
    if (event === 'pr_opened') return;
    if (settings.enabled !== true) return;
    if (!meta || meta.sourceType !== 'jira') return;
    const issueKey = meta.jiraIssueKey;
    if (!isValidIssueKey(issueKey)) return;
    const config = getConfig(project);
    if (!config) return;
    if (normalizeJiraSiteUrl(meta.jiraSiteUrl) !== config.siteUrl) return;

    const text = buildJiraComment({ event, taskTitle: title, prUrl });
    const statusName = settings.transitionStatusName.trim();
    const doTransition = event === 'review_ready' && settings.transitionOnReview && statusName.length > 0;
    if (!settings.comment && !doTransition) return;

    if (settings.comment) {
      try {
        await addIssueComment(config.siteUrl, config.email, config.token, issueKey, text);
      } catch (err) {
        warn(event, issueKey, 'comment', err);
      }
    }
    if (doTransition) {
      try {
        await transitionIssue(config.siteUrl, config.email, config.token, issueKey, statusName);
      } catch (err) {
        warn(event, issueKey, 'transition', err);
      }
    }
  } catch {
    // never let Jira problems affect task flow
  }
}
