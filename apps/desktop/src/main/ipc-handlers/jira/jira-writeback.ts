/**
 * Report a Jira-imported task's outcome back to the issue it came from.
 *
 * zeenha fork: reports to the same Jira site/issue the user imported from, using
 * the credentials already used for import. The switch lives in user settings only
 * (default off). Comments are built from allow-listed fields only; errors, paths,
 * logs and tokens are never sent or logged. Nothing here throws.
 */

import type { Project, Task } from '../../../shared/types';
import type { JiraWritebackSettings } from '../../../shared/types/settings';
import { DEFAULT_APP_SETTINGS } from '../../../shared/constants/config';
import { getSpecsDir } from '../../../shared/constants';
import { appLog } from '../../app-logger';
import { readSettingsFile } from '../../settings-utils';
import { taskSpecDirs } from '../../task-failure-facts';
import type { WebhookEvent } from '../../task-webhook';
import { type OutcomeEvent, buildOutcomeComment, readMetadata } from '../issue-writeback/common';
import { JiraAPIError, addIssueComment, isValidIssueKey, normalizeJiraSiteUrl, transitionIssue } from './jira-client';
import { getJiraConfig } from './jira-config';

export function buildJiraComment(input: { event: OutcomeEvent; taskTitle?: string; prUrl?: string }): string {
  return buildOutcomeComment(input.event, input.taskTitle, input.prUrl);
}

function loadSettings(): JiraWritebackSettings {
  const raw = readSettingsFile() ?? {};
  const def = DEFAULT_APP_SETTINGS.jiraWriteback;
  const w = ((raw as { jiraWriteback?: Partial<JiraWritebackSettings> }).jiraWriteback ?? {});
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
    appLog.warn(`[JiraWriteback] ${what} failed event=${event} issue=${issueKey} reason=${detail}`);
  } catch {
    // never throw from logging
  }
}

export function dispatchJiraOutcome(input: { task: Task; project: Project; event: WebhookEvent }): void {
  try {
    const { task, project, event } = input;
    if (event === 'pr_opened') return;
    const settings = loadSettings();
    if (settings.enabled !== true) return;

    const meta = readMetadata(taskSpecDirs(project.path, getSpecsDir(project.autoBuildPath), task.specId));
    if (!meta || meta.sourceType !== 'jira') return;
    const issueKey = meta.jiraIssueKey;
    if (!isValidIssueKey(issueKey)) return;
    const config = getJiraConfig(project);
    if (!config) return;
    if (normalizeJiraSiteUrl(meta.jiraSiteUrl) !== config.siteUrl) return;

    const text = buildJiraComment({ event, taskTitle: task.title, prUrl: task.metadata?.prUrl });
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
