/**
 * zeenha fork: the one place providers are registered. PR feedback and issue
 * writeback look providers up here instead of branching on provider names.
 */

import { azureDevOpsForge } from './azuredevops-forge';
import { bitbucketForge } from './bitbucket-forge';
import { githubForge } from './github-forge';
import { gitlabForge } from './gitlab-forge';
import { linearWriter } from './linear-writer';
import { isOutcomeWriter, type OutcomeWriter, type PRHost, type PRRef } from './types';

export interface ForgeRegistry {
  forges: readonly PRHost[];
  writers: readonly OutcomeWriter[];
  getForgeForPrUrl(prUrl: string): { forge: PRHost; ref: PRRef } | null;
  getForgeById(id: string): PRHost | undefined;
  getOutcomeWriter(sourceType: string): OutcomeWriter | undefined;
}

export function createForgeRegistry(
  forges: readonly PRHost[],
  extraWriters: readonly OutcomeWriter[] = []
): ForgeRegistry {
  // A code host without issue writeback (Bitbucket, Azure DevOps) is a PRHost only and is not a writer.
  const writers: readonly OutcomeWriter[] = [...forges.filter(isOutcomeWriter), ...extraWriters];
  return {
    forges,
    writers,
    getForgeForPrUrl(prUrl) {
      for (const forge of forges) {
        const ref = forge.resolvePR(prUrl);
        if (ref) return { forge, ref };
      }
      return null;
    },
    getForgeById: (id) => forges.find((forge) => forge.providerId === id),
    getOutcomeWriter: (sourceType) => writers.find((writer) => writer.sourceType === sourceType)
  };
}

/** Tried in this order when resolving a PR URL: GitHub, GitLab, Bitbucket, then Azure DevOps. */
export const FORGES: readonly PRHost[] = [githubForge, gitlabForge, bitbucketForge, azureDevOpsForge];

const defaultRegistry = createForgeRegistry(FORGES, [linearWriter]);

export const OUTCOME_WRITERS: readonly OutcomeWriter[] = defaultRegistry.writers;

export const getForgeForPrUrl = (prUrl: string): { forge: PRHost; ref: PRRef } | null =>
  defaultRegistry.getForgeForPrUrl(prUrl);
export const getForgeById = (id: string): PRHost | undefined => defaultRegistry.getForgeById(id);
export const getOutcomeWriter = (sourceType: string): OutcomeWriter | undefined =>
  defaultRegistry.getOutcomeWriter(sourceType);
