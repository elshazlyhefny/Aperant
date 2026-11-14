/**
 * zeenha fork: GitHub implementation of the Forge interface, wrapping the
 * existing PR feedback and issue comment code.
 */

import { getGitHubConfig, githubFetch, normalizeRepoReference } from '../github/utils';
import { fetchPRFeedback, parsePRNumberFromUrl } from '../github/pr/task-feedback';
import type { Forge } from './types';
import { isPositiveSafeInt, parseUrl, warn } from './writeback-utils';

const NOT_CONFIGURED = 'GitHub is not configured for this project (token or repository missing).';

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

  postOutcome({ meta, project, event, text }) {
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
};
