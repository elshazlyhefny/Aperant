/**
 * zeenha fork: pick the code host (GitHub or GitLab) for a task's PR/MR URL and
 * load its CI + review feedback in the shared PRFeedbackFetchResult shape.
 */

import type { Project } from '../../../shared/types';
import { getGitHubConfig } from '../github/utils';
import {
  fetchPRFeedback,
  parsePRNumberFromUrl,
  PRFeedbackError,
  type PRFeedbackFetchResult,
} from '../github/pr/task-feedback';
import { getGitLabConfig, normalizeProjectReference } from '../gitlab/utils';
import { fetchMRFeedback, parseMRIidFromUrl, parseMergeRequestUrl } from '../gitlab/mr-feedback';

export type PRRef = { provider: 'github' | 'gitlab'; number: number };

export type LoadPRFeedbackResult =
  | { ok: true; fetched: PRFeedbackFetchResult }
  | { ok: false; code: 'no_github_config' | 'no_gitlab_config' | 'fetch_failed'; error: string };

const NOT_ON_CONFIGURED_PROJECT = 'This merge request is not on the GitLab project configured for this project.';

/** GitHub PR URL -> github; GitLab MR URL -> gitlab (number = iid); else null. */
export function resolvePRRef(prUrl: string): PRRef | null {
  const ghNumber = parsePRNumberFromUrl(prUrl);
  if (ghNumber) return { provider: 'github', number: ghNumber };
  const mr = parseMergeRequestUrl(prUrl);
  if (mr) return { provider: 'gitlab', number: mr.iid };
  return null;
}

export async function loadPRFeedback(project: Project, prUrl: string, ref: PRRef): Promise<LoadPRFeedbackResult> {
  try {
    if (ref.provider === 'github') {
      const config = getGitHubConfig(project);
      if (!config) {
        return {
          ok: false,
          code: 'no_github_config',
          error: 'GitHub is not configured for this project (token or repository missing).',
        };
      }
      return { ok: true, fetched: await fetchPRFeedback(config, ref.number) };
    }

    const config = await getGitLabConfig(project);
    if (!config) {
      return {
        ok: false,
        code: 'no_gitlab_config',
        error: 'GitLab is not configured for this project (token or project missing).',
      };
    }
    const notConfigured = { ok: false as const, code: 'no_gitlab_config' as const, error: NOT_ON_CONFIGURED_PROJECT };
    if (parseMRIidFromUrl(prUrl, config.instanceUrl) !== ref.number) return notConfigured;
    const configured = normalizeProjectReference(config.project, config.instanceUrl);
    if (!/^\d+$/.test(configured)) {
      const urlPath = parseMergeRequestUrl(prUrl)?.projectPath ?? '';
      if (urlPath.toLowerCase() !== configured.toLowerCase()) return notConfigured;
    }
    return { ok: true, fetched: await fetchMRFeedback(config, ref.number) };
  } catch (error) {
    return {
      ok: false,
      code: 'fetch_failed',
      error: error instanceof PRFeedbackError ? error.message : 'Failed to load pull request feedback',
    };
  }
}
