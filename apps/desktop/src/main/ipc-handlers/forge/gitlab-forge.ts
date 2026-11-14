/**
 * zeenha fork: GitLab implementation of the Forge interface, wrapping the
 * existing MR feedback and issue note code.
 */

import {
  encodeProjectPath,
  getGitLabConfig,
  gitlabFetch,
  normalizeProjectReference
} from '../gitlab/utils';
import { fetchMRFeedback, parseMRIidFromUrl, parseMergeRequestUrl } from '../gitlab/mr-feedback';
import type { Forge } from './types';
import { isPositiveSafeInt, parseUrl, warn } from './writeback-utils';

const NOT_CONFIGURED = 'GitLab is not configured for this project (token or project missing).';
const NOT_ON_CONFIGURED_PROJECT = 'This merge request is not on the GitLab project configured for this project.';

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

  postOutcome({ meta, project, event, text }) {
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
};
