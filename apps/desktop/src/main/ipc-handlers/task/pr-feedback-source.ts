/**
 * zeenha fork: pick the code host for a task's PR/MR URL through the forge
 * registry and load its CI + review feedback in the shared PRFeedbackFetchResult shape.
 */

import type { Project } from '../../../shared/types';
import { PRFeedbackError, type PRFeedbackFetchResult } from '../github/pr/task-feedback';
import { getForgeById, getForgeForPrUrl } from '../forge/registry';
import type { PRRef } from '../forge/types';

export type { PRRef };

export type LoadPRFeedbackResult =
  | { ok: true; fetched: PRFeedbackFetchResult }
  | { ok: false; code: 'not_configured'; provider: string; error: string }
  | { ok: false; code: 'fetch_failed'; error: string };

/** PR/MR URL -> the owning forge's reference, or null when no forge recognises it. */
export function resolvePRRef(prUrl: string): PRRef | null {
  return getForgeForPrUrl(prUrl)?.ref ?? null;
}

export async function loadPRFeedback(project: Project, prUrl: string, ref: PRRef): Promise<LoadPRFeedbackResult> {
  try {
    const forge = getForgeById(ref.provider);
    if (!forge) return { ok: false, code: 'fetch_failed', error: 'Failed to load pull request feedback' };
    const result = await forge.loadFeedback(project, prUrl, ref);
    if (result.ok) return result;
    return { ok: false, code: 'not_configured', provider: ref.provider, error: result.error };
  } catch (error) {
    return {
      ok: false,
      code: 'fetch_failed',
      error: error instanceof PRFeedbackError ? error.message : 'Failed to load pull request feedback',
    };
  }
}
