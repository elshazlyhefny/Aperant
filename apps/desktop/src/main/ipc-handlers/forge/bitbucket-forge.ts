/**
 * zeenha fork: Bitbucket Cloud pull requests for the forge registry, wrapping
 * the Bitbucket PR feedback code (failed pipeline steps and comment threads).
 * Bitbucket has no issue writeback here, so this is a PRHost, not a full Forge.
 */

import { getBitbucketConfig } from '../bitbucket/utils';
import { fetchBitbucketPRFeedback, parseBitbucketPullRequestUrl } from '../bitbucket/pr-feedback';
import type { PRHost } from './types';

const NOT_CONFIGURED = 'Bitbucket is not configured for this project (username, token or repository missing).';
const NOT_ON_CONFIGURED_REPOSITORY =
  'This pull request is not on the Bitbucket repository configured for this project.';

export const bitbucketForge: PRHost = {
  providerId: 'bitbucket',
  notConfiguredMessage: NOT_CONFIGURED,

  resolvePR(prUrl) {
    const pr = parseBitbucketPullRequestUrl(prUrl);
    return pr ? { provider: 'bitbucket', number: pr.id } : null;
  },

  async loadFeedback(project, prUrl, ref) {
    const config = await getBitbucketConfig(project);
    if (!config) return { ok: false, code: 'not_configured', error: NOT_CONFIGURED };
    const parsed = parseBitbucketPullRequestUrl(prUrl);
    if (
      !parsed ||
      parsed.id !== ref.number ||
      `${parsed.workspace}/${parsed.repoSlug}`.toLowerCase() !== config.repository.toLowerCase()
    ) {
      return { ok: false, code: 'not_configured', error: NOT_ON_CONFIGURED_REPOSITORY };
    }
    return { ok: true, fetched: await fetchBitbucketPRFeedback(config, ref.number) };
  },
};
