/**
 * zeenha fork: Jira is a writeback-only tracker with its own settings block
 * (jiraWriteback), so it implements OutcomeWriter with isEnabled instead of a
 * settingKey in issueWriteback.
 */

import type { WebhookEvent } from '../../task-webhook';
import { addIssueComment, isValidIssueKey, normalizeJiraSiteUrl, transitionIssue } from '../jira/jira-client';
import { getJiraConfig } from '../jira/jira-config';
import { loadSettings, warn } from '../jira/jira-writeback';
import type { OutcomeWriter } from './types';

export const jiraWriter: OutcomeWriter = {
  sourceType: 'jira',
  isEnabled: (raw) => raw.jiraWriteback?.enabled === true,

  postOutcome({ meta, project, event, text }) {
    try {
      if ((event as WebhookEvent) === 'pr_opened') return;
      const settings = loadSettings();
      const issueKey = meta.jiraIssueKey;
      if (!isValidIssueKey(issueKey)) return;
      const config = getJiraConfig(project);
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
      void run().catch(() => undefined);
    } catch {
      // never let Jira problems affect task flow
    }
  }
};
