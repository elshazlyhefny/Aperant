/**
 * Report a task's outcome back to the GitHub / GitLab / Linear issue it came from.
 *
 * zeenha fork: uses the credentials already configured for import. Each provider
 * is opt-in through user settings (default off). Comment text is built from
 * allow-listed fields only; tokens, bodies and response text are never logged.
 * Nothing here throws.
 */

import type { Project, Task } from '../../../shared/types';
import type { IssueWritebackSettings } from '../../../shared/types/settings';
import { DEFAULT_APP_SETTINGS } from '../../../shared/constants/config';
import { getSpecsDir } from '../../../shared/constants';
import { appLog } from '../../app-logger';
import { readSettingsFile } from '../../settings-utils';
import { taskSpecDirs } from '../../task-failure-facts';
import type { WebhookEvent } from '../../task-webhook';
import { getGitHubConfig, githubFetch, normalizeRepoReference } from '../github/utils';
import {
  GitLabAPIError,
  encodeProjectPath,
  getGitLabConfig,
  gitlabFetch,
  normalizeProjectReference
} from '../gitlab/utils';
import { getLinearApiKey, linearGraphQL } from '../linear-client';
import { buildOutcomeComment, readMetadata } from './common';

const LINEAR_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const LINEAR_COMMENT_MUTATION =
  'mutation($input: CommentCreateInput!){ commentCreate(input: $input){ success } }';

function loadSettings(): IssueWritebackSettings {
  const raw = readSettingsFile() ?? {};
  const def = DEFAULT_APP_SETTINGS.issueWriteback;
  const w = (raw as { issueWriteback?: Partial<IssueWritebackSettings> }).issueWriteback ?? {};
  return {
    github: w.github === true ? true : def.github,
    gitlab: w.gitlab === true ? true : def.gitlab,
    linear: w.linear === true ? true : def.linear
  };
}

function warn(provider: string, event: string, ref: string, err: unknown): void {
  try {
    let detail = 'UnknownError';
    if (err instanceof GitLabAPIError) {
      detail = `${err.name}${err.statusCode ? ` (HTTP ${err.statusCode})` : ''}`;
    } else if (err instanceof Error) {
      // githubFetch embeds the response body in its message, so only the name is logged
      detail = err.name;
    }
    appLog.warn(`[IssueWriteback] ${provider} comment failed event=${event} issue=${ref} reason=${detail}`);
  } catch {
    // never throw from logging
  }
}

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function parseUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function dispatchGitHub(meta: Record<string, unknown>, project: Project, event: WebhookEvent, text: string): void {
  const issueNumber = meta.githubIssueNumber;
  if (!isPositiveSafeInt(issueNumber)) return;
  const config = getGitHubConfig(project);
  if (!config) return;
  const repo = normalizeRepoReference(config.repo);
  const url = parseUrl(meta.githubUrl);
  if (!url || url.host.toLowerCase() !== 'github.com') return;
  const [owner, name] = url.pathname.split('/').filter(Boolean);
  if (!owner || !name || `${owner}/${name}`.toLowerCase() !== repo.toLowerCase()) return;

  const ref = `#${issueNumber}`;
  const run = async (): Promise<void> => {
    try {
      await githubFetch(config.token, `/repos/${repo}/issues/${issueNumber}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text })
      });
    } catch (err) {
      warn('github', event, ref, err);
    }
  };
  void run().catch(() => undefined);
}

function dispatchGitLab(meta: Record<string, unknown>, project: Project, event: WebhookEvent, text: string): void {
  const iid = meta.gitlabIssueIid;
  if (!isPositiveSafeInt(iid)) return;
  const ref = `#${iid}`;
  const run = async (): Promise<void> => {
    try {
      const config = await getGitLabConfig(project);
      if (!config) return;
      const issueUrl = parseUrl(meta.gitlabUrl);
      const instance = parseUrl(config.instanceUrl);
      if (!issueUrl || !instance || issueUrl.host.toLowerCase() !== instance.host.toLowerCase()) return;
      const projectPath = encodeProjectPath(normalizeProjectReference(config.project, config.instanceUrl));
      await gitlabFetch(config.token, config.instanceUrl, `/projects/${projectPath}/issues/${iid}/notes`, {
        method: 'POST',
        body: JSON.stringify({ body: text })
      });
    } catch (err) {
      warn('gitlab', event, ref, err);
    }
  };
  void run().catch(() => undefined);
}

function dispatchLinear(meta: Record<string, unknown>, project: Project, event: WebhookEvent, text: string): void {
  const issueId = meta.linearIssueId;
  if (typeof issueId !== 'string' || !LINEAR_ID_PATTERN.test(issueId)) return;
  const apiKey = getLinearApiKey(project);
  if (!apiKey) return;

  const run = async (): Promise<void> => {
    try {
      const data = (await linearGraphQL(apiKey, LINEAR_COMMENT_MUTATION, {
        input: { issueId, body: text }
      })) as { commentCreate?: { success?: boolean } } | null | undefined;
      if (data?.commentCreate?.success === false) {
        throw new Error('LinearCommentRejected');
      }
    } catch (err) {
      warn('linear', event, issueId, err);
    }
  };
  void run().catch(() => undefined);
}

export function dispatchIssueOutcome(input: { task: Task; project: Project; event: WebhookEvent }): void {
  try {
    const { task, project, event } = input;
    const settings = loadSettings();
    if (!settings.github && !settings.gitlab && !settings.linear) return;

    const meta = readMetadata(taskSpecDirs(project.path, getSpecsDir(project.autoBuildPath), task.specId));
    if (!meta) return;
    const text = buildOutcomeComment(event, task.title, task.metadata?.prUrl);

    if (meta.sourceType === 'github' && settings.github) dispatchGitHub(meta, project, event, text);
    else if (meta.sourceType === 'gitlab' && settings.gitlab) dispatchGitLab(meta, project, event, text);
    else if (meta.sourceType === 'linear' && settings.linear) dispatchLinear(meta, project, event, text);
  } catch {
    // never let write-back problems affect task flow
  }
}
