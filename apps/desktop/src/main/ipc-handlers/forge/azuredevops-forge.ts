/**
 * zeenha fork: Azure DevOps pull requests for the forge registry, wrapping the
 * Azure DevOps PR feedback code (failed build validations and active threads).
 * Azure DevOps has no issue writeback here, so this is a PRHost, not a full Forge.
 */

import { getAzureDevOpsConfig } from '../azuredevops/utils';
import {
  fetchAzureDevOpsPRFeedback,
  parseAzureDevOpsPRIdFromUrl,
  parseAzureDevOpsPullRequestUrl,
} from '../azuredevops/pr-feedback';
import type { PRHost } from './types';

const NOT_CONFIGURED =
  'Azure DevOps is not configured for this project (organization, project, repository or token missing).';
const NOT_ON_CONFIGURED_REPOSITORY =
  'This pull request is not on the Azure DevOps repository configured for this project.';

export const azureDevOpsForge: PRHost = {
  providerId: 'azuredevops',
  notConfiguredMessage: NOT_CONFIGURED,

  resolvePR(prUrl) {
    const pr = parseAzureDevOpsPullRequestUrl(prUrl);
    return pr ? { provider: 'azuredevops', number: pr.id } : null;
  },

  async loadFeedback(project, prUrl, ref) {
    const config = await getAzureDevOpsConfig(project);
    if (!config) return { ok: false, code: 'not_configured', error: NOT_CONFIGURED };
    if (parseAzureDevOpsPRIdFromUrl(prUrl, config) !== ref.number) {
      return { ok: false, code: 'not_configured', error: NOT_ON_CONFIGURED_REPOSITORY };
    }
    return { ok: true, fetched: await fetchAzureDevOpsPRFeedback(config, ref.number) };
  },
};
