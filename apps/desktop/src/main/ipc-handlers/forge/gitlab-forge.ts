/**
 * zeenha fork: GitLab implementation of the Forge interface, wrapping the
 * existing MR feedback and issue note code.
 */

import { getGitLabConfig, normalizeProjectReference } from '../gitlab/utils';
import { fetchMRFeedback, parseMRIidFromUrl, parseMergeRequestUrl } from '../gitlab/mr-feedback';
import type { Forge } from './types';
import { createGitLabWriter } from './gitlab-writer';

const NOT_CONFIGURED = 'GitLab is not configured for this project (token or project missing).';
const NOT_ON_CONFIGURED_PROJECT = 'This merge request is not on the GitLab project configured for this project.';

const gitlabWriter = createGitLabWriter((project) => getGitLabConfig(project));

export const gitlabForge: Forge = {
  providerId: 'gitlab',
  sourceType: 'gitlab',
  settingKey: 'gitlab',
  notConfiguredMessage: NOT_CONFIGURED,

  resolvePR(prUrl) {
    const mr = parseMergeRequestUrl(prUrl);
    return mr ? { provider: 'gitlab', number: mr.iid } : null;
  },

  async loadFeedback(project, prUrl, ref) {
    const config = await getGitLabConfig(project);
    if (!config) return { ok: false, code: 'not_configured', error: NOT_CONFIGURED };
    const notConfigured = { ok: false as const, code: 'not_configured' as const, error: NOT_ON_CONFIGURED_PROJECT };
    if (parseMRIidFromUrl(prUrl, config.instanceUrl) !== ref.number) return notConfigured;
    const configured = normalizeProjectReference(config.project, config.instanceUrl);
    if (!/^\d+$/.test(configured)) {
      const urlPath = parseMergeRequestUrl(prUrl)?.projectPath ?? '';
      if (urlPath.toLowerCase() !== configured.toLowerCase()) return notConfigured;
    }
    return { ok: true, fetched: await fetchMRFeedback(config, ref.number) };
  },

  postOutcome: gitlabWriter.postOutcome
};
