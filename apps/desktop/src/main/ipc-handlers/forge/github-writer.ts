/**
 * zeenha fork: Electron-free GitHub outcome writer. The desktop passes a config
 * resolver with the gh CLI token fallback; the CLI passes an env-only one.
 */

import { githubFetch, normalizeRepoReference } from '../github/github-api';
import type { GitHubConfig } from '../github/types';
import type { OutcomeWriter } from './types';
import { isPositiveSafeInt, parseUrl, warn } from './writeback-utils';

export function createGitHubWriter(
  resolveConfig: (project: Parameters<OutcomeWriter['postOutcome']>[0]['project']) => GitHubConfig | null
): OutcomeWriter {
  return {
    sourceType: 'github',
    settingKey: 'github',

    postOutcome({ meta, project, event, text }) {
      const issueNumber = meta.githubIssueNumber;
      if (!isPositiveSafeInt(issueNumber)) return;
      const config = resolveConfig(project);
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
      return run().catch(() => undefined);
    }
  };
}
