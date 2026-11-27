/**
 * zeenha fork: Electron-free GitLab outcome writer. The desktop passes a config
 * resolver with the glab CLI token fallback; the CLI passes an env-only one.
 */

import { GitLabAPIError, encodeProjectPath, gitlabFetch, normalizeProjectReference } from '../gitlab/gitlab-api';
import type { GitLabConfig } from '../gitlab/types';
import type { OutcomeWriter } from './types';
import { classifyWritebackError, isPositiveSafeInt, parseUrl, skipWriteback, trackWriteback, warn } from './writeback-utils';

export function createGitLabWriter(
  resolveConfig: (project: Parameters<OutcomeWriter['postOutcome']>[0]['project']) => Promise<GitLabConfig | null>
): OutcomeWriter {
  return {
    sourceType: 'gitlab',
    settingKey: 'gitlab',

    postOutcome({ meta, project, event, text, recorder }) {
      const operation = { operation: 'issue_comment', provider: 'gitlab', event } as const;
      const iid = meta.gitlabIssueIid;
      if (!isPositiveSafeInt(iid)) return skipWriteback(recorder, operation, 'invalid_reference');
      const ref = `#${iid}`;
      const run = async (): Promise<void> => {
        try {
          const config = await resolveConfig(project);
          if (!config) return skipWriteback(recorder, operation, 'missing_configuration');
          const issueUrl = parseUrl(meta.gitlabUrl);
          if (!issueUrl) return skipWriteback(recorder, operation, 'invalid_reference');
          const instance = parseUrl(config.instanceUrl);
          if (!instance) return skipWriteback(recorder, operation, 'missing_configuration');
          if (issueUrl.host.toLowerCase() !== instance.host.toLowerCase()) {
            return skipWriteback(recorder, operation, 'target_mismatch');
          }
          const projectPath = encodeProjectPath(normalizeProjectReference(config.project, config.instanceUrl));
          await trackWriteback(recorder, operation, async () => {
            try {
              await gitlabFetch(config.token, config.instanceUrl, `/projects/${projectPath}/issues/${iid}/notes`, {
                method: 'POST',
                body: JSON.stringify({ body: text })
              });
              return { status: 'delivered', attempts: 1 };
            } catch (err) {
              const result = classifyWritebackError(err, err instanceof GitLabAPIError ? err.statusCode : undefined);
              warn('gitlab', event, ref, err);
              return result;
            }
          });
        } catch (err) {
          warn('gitlab', event, ref, err);
        }
      };
      return run();
    }
  };
}
