/**
 * zeenha fork: the one place providers are registered. PR feedback and issue
 * writeback look providers up here instead of branching on provider names.
 */

import { githubForge } from './github-forge';
import { gitlabForge } from './gitlab-forge';
import { linearWriter } from './linear-writer';
import type { Forge, OutcomeWriter, PRRef } from './types';

export interface ForgeRegistry {
  forges: readonly Forge[];
  writers: readonly OutcomeWriter[];
  getForgeForPrUrl(prUrl: string): { forge: Forge; ref: PRRef } | null;
  getForgeById(id: string): Forge | undefined;
  getOutcomeWriter(sourceType: string): OutcomeWriter | undefined;
}

export function createForgeRegistry(
  forges: readonly Forge[],
  extraWriters: readonly OutcomeWriter[] = []
): ForgeRegistry {
  const writers: readonly OutcomeWriter[] = [...forges, ...extraWriters];
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

/** GitHub is tried before GitLab when resolving a PR URL. */
export const FORGES: readonly Forge[] = [githubForge, gitlabForge];
export const OUTCOME_WRITERS: readonly OutcomeWriter[] = [...FORGES, linearWriter];

const defaultRegistry = createForgeRegistry(FORGES, [linearWriter]);

export const getForgeForPrUrl = (prUrl: string): { forge: Forge; ref: PRRef } | null =>
  defaultRegistry.getForgeForPrUrl(prUrl);
export const getForgeById = (id: string): Forge | undefined => defaultRegistry.getForgeById(id);
export const getOutcomeWriter = (sourceType: string): OutcomeWriter | undefined =>
  defaultRegistry.getOutcomeWriter(sourceType);
