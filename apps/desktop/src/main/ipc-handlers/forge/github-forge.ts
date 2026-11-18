/**
 * zeenha fork: GitHub implementation of the Forge interface, wrapping the
 * existing PR feedback and issue comment code.
 */

import { getGitHubConfig } from '../github/utils';
import { fetchPRFeedback, parsePRNumberFromUrl } from '../github/pr/task-feedback';
import type { Forge } from './types';
import { createGitHubWriter } from './github-writer';

const NOT_CONFIGURED = 'GitHub is not configured for this project (token or repository missing).';

const githubWriter = createGitHubWriter((project) => getGitHubConfig(project));

export const githubForge: Forge = {
  providerId: 'github',
  sourceType: 'github',
  settingKey: 'github',
  notConfiguredMessage: NOT_CONFIGURED,

  resolvePR(prUrl) {
    const number = parsePRNumberFromUrl(prUrl);
    return number ? { provider: 'github', number } : null;
  },

  async loadFeedback(project, _prUrl, ref) {
    const config = getGitHubConfig(project);
    if (!config) return { ok: false, code: 'not_configured', error: NOT_CONFIGURED };
    return { ok: true, fetched: await fetchPRFeedback(config, ref.number) };
  },

  postOutcome: githubWriter.postOutcome
};
