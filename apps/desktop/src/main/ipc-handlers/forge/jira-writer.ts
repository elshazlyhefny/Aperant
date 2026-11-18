/**
 * zeenha fork: Jira is a writeback-only tracker with its own settings block
 * (jiraWriteback), so it implements OutcomeWriter with isEnabled instead of a
 * settingKey in issueWriteback. Electron-free: the desktop passes a settings
 * loader that reads the settings file; the CLI passes its config's settings.
 * Errors, paths, logs and tokens are never sent or logged.
 */

import type { JiraWritebackSettings } from '../../../shared/types/settings';
import { appLogPort } from '../../log-port';
import type { WebhookEvent } from '../../task-webhook-core';
import { JiraAPIError, addIssueComment, isValidIssueKey, normalizeJiraSiteUrl, transitionIssue } from '../jira/jira-client';
import { type JiraConfig, getJiraConfig } from '../jira/jira-config';
import type { OutcomeWriter } from './types';

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

export function createJiraWriter(
  loadSettings: () => JiraWritebackSettings,
  getConfig: (project: Parameters<OutcomeWriter['postOutcome']>[0]['project']) => JiraConfig | null = getJiraConfig
): OutcomeWriter {
  return {
    sourceType: 'jira',
    isEnabled: (raw) => raw.jiraWriteback?.enabled === true,

    postOutcome({ meta, project, event, text }) {
      try {
        if ((event as WebhookEvent) === 'pr_opened') return;
        const settings = loadSettings();
        const issueKey = meta.jiraIssueKey;
        if (!isValidIssueKey(issueKey)) return;
        const config = getConfig(project);
        if (!config) return;
        if (normalizeJiraSiteUrl(meta.jiraSiteUrl) !== config.siteUrl) return;

        const statusName = settings.transitionStatusName.trim();
        const doTransition = event === 'review_ready' && settings.transitionOnReview && statusName.length > 0;
        if (!settings.comment && !doTransition) return;

        const run = async (): Promise<void> => {
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
        };
        return run().catch(() => undefined);
      } catch {
        // never let Jira problems affect task flow
      }
    }
  };
}
