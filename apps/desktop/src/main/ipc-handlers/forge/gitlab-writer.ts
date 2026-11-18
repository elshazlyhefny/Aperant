/**
 * zeenha fork: Electron-free GitLab outcome writer. The desktop passes a config
 * resolver with the glab CLI token fallback; the CLI passes an env-only one.
 */

import { encodeProjectPath, gitlabFetch, normalizeProjectReference } from '../gitlab/gitlab-api';
import type { GitLabConfig } from '../gitlab/types';
import type { OutcomeWriter } from './types';
import { isPositiveSafeInt, parseUrl, warn } from './writeback-utils';

export function createGitLabWriter(
  resolveConfig: (project: Parameters<OutcomeWriter['postOutcome']>[0]['project']) => Promise<GitLabConfig | null>
): OutcomeWriter {
  return {
    sourceType: 'gitlab',
    settingKey: 'gitlab',

    postOutcome({ meta, project, event, text }) {
      const iid = meta.gitlabIssueIid;
      if (!isPositiveSafeInt(iid)) return;
      const ref = `#${iid}`;
      const run = async (): Promise<void> => {
        try {
          const config = await resolveConfig(project);
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
      return run().catch(() => undefined);
    }
  };
}
