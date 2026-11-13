/**
 * Report a Jira-imported task's outcome back to the issue it came from.
 *
 * zeenha fork: reports to the same Jira site/issue the user imported from, using
 * the credentials already used for import. The switch lives in user settings only
 * (default off). Comments are built from allow-listed fields only; errors, paths,
 * logs and tokens are never sent or logged. Nothing here throws.
 */

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import type { Project, Task } from '../../../shared/types';
import type { JiraWritebackSettings } from '../../../shared/types/settings';
import { DEFAULT_APP_SETTINGS } from '../../../shared/constants/config';
import { getSpecsDir } from '../../../shared/constants';
import { appLog } from '../../app-logger';
import { readSettingsFile } from '../../settings-utils';
import { taskSpecDirs } from '../../task-failure-facts';
import type { WebhookEvent } from '../../task-webhook';
import { sanitizeUrl } from '../shared/sanitize';
import { JiraAPIError, addIssueComment, isValidIssueKey, normalizeJiraSiteUrl, transitionIssue } from './jira-client';
import { getJiraConfig } from './jira-config';

const MAX_TITLE_LENGTH = 200;

// zeenha fork: pr_opened is webhook-only; Jira already gets the PR link in review comments.
type JiraEvent = Exclude<WebhookEvent, 'pr_opened'>;

const EVENT_LABELS: Record<JiraEvent, string> = {
  review_ready: 'Aperant: task is ready for review.',
  failed: 'Aperant: task failed.',
  blocked: 'Aperant: task is blocked and needs attention.'
};

function cleanTitle(value: unknown): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping control chars
  const cleaned = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  return cleaned.length > MAX_TITLE_LENGTH ? `${cleaned.slice(0, MAX_TITLE_LENGTH - 1)}…` : cleaned;
}

export function buildJiraComment(input: { event: JiraEvent; taskTitle?: string; prUrl?: string }): string {
  const lines = [EVENT_LABELS[input.event]];
  const title = cleanTitle(input.taskTitle);
  if (title) lines.push(`Task: ${title}`);
  const url = sanitizeUrl(input.prUrl);
  if (url?.startsWith('https://')) lines.push(`Pull request: ${url}`);
  return lines.join('\n');
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

function readMetadata(dirs: string[]): Record<string, unknown> | null {
  for (const dir of dirs) {
    const file = path.join(dir, 'task_metadata.json');
    try {
      if (!existsSync(file)) continue;
      const parsed = JSON.parse(readFileSync(file, 'utf-8'));
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      // try next location
    }
  }
  return null;
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
