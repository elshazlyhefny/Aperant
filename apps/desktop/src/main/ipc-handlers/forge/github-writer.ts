/**
 * zeenha fork: Electron-free GitHub outcome writer. The desktop passes a config
 * resolver with the gh CLI token fallback; the CLI passes an env-only one.
 */

import { GitHubAPIError, githubFetch, normalizeRepoReference } from '../github/github-api';
import type { GitHubConfig } from '../github/types';
import type { OutcomeWriter } from './types';
import { classifyWritebackError, isPositiveSafeInt, parseUrl, skipWriteback, trackWriteback, warn } from './writeback-utils';

export function createGitHubWriter(
  resolveConfig: (project: Parameters<OutcomeWriter['postOutcome']>[0]['project']) => GitHubConfig | null
): OutcomeWriter {
  return {
    sourceType: 'github',
    settingKey: 'github',

    postOutcome({ meta, project, event, text, recorder }) {
      const operation = { operation: 'issue_comment', provider: 'github', event } as const;
      try {
        const issueNumber = meta.githubIssueNumber;
        if (!isPositiveSafeInt(issueNumber)) return skipWriteback(recorder, operation, 'invalid_reference');
        const config = resolveConfig(project);
        if (!config) return skipWriteback(recorder, operation, 'missing_configuration');
        const repo = normalizeRepoReference(config.repo);
        const url = parseUrl(meta.githubUrl);
        if (!url) return skipWriteback(recorder, operation, 'invalid_reference');
        const [owner, name] = url.pathname.split('/').filter(Boolean);
        if (url.host.toLowerCase() !== 'github.com' || !owner || !name || `${owner}/${name}`.toLowerCase() !== repo.toLowerCase()) {
          return skipWriteback(recorder, operation, 'target_mismatch');
        }

        return trackWriteback(recorder, operation, async () => {
          try {
            await githubFetch(config.token, `/repos/${repo}/issues/${issueNumber}/comments`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ body: text })
            });
            return { status: 'delivered', attempts: 1 };
          } catch (err) {
            const result = classifyWritebackError(err, err instanceof GitHubAPIError ? err.statusCode : undefined);
            warn('github', event, `#${issueNumber}`, err);
            return result;
          }
        }).catch(() => undefined);
      } catch {
        // Never let a writer failure affect task flow.
      }
    }
  };
}
