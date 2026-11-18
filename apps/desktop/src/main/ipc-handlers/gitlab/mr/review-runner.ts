/**
 * GitLab MR review runner: one entry point for initial and follow-up reviews.
 */

import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../../../shared/constants';
import { getGitLabConfig, gitlabFetch, encodeProjectPath } from '../utils';
import type { Project } from '../../../../shared/types';
import type { MRReviewResult, MRReviewProgress } from '../types';
import { prepareMRReviewCheckout, type PRReviewCheckout } from '../../../ai/runners/github/pr-review-checkout';
import { getApprovals } from '../../../mcp-approval-store';
import { createPRReviewMcpSession, type PRReviewMcpSession } from '../../../ai/runners/github/pr-review-mcp';
import { createContextLogger } from '../../github/utils/logger';
import { createIPCCommunicators } from '../../github/utils/ipc-communicator';
import {
  MRReviewEngine,
  type MRContext,
  type MRReviewEngineConfig,
} from '../../../ai/runners/gitlab/mr-review-engine';
import type { ModelShorthand, ThinkingLevel } from '../../../ai/config/types';
import { verdictToOverallStatus } from '../../shared/review-verdict';
import { getGitLabMRSettings, saveMRReviewResultToDisk } from './review-results';

const { debug: debugLog } = createContextLogger('GitLab MR');

/**
 * Registry of running MR review abort controllers
 * Key format: `${projectId}:${mrIid}`
 */
export const runningReviews = new Map<string, AbortController>();

/**
 * Get the registry key for an MR review
 */
export function getReviewKey(projectId: string, mrIid: number): string {
  return `${projectId}:${mrIid}`;
}

/** IPC communicators for the MR review channels. */
export function reviewChannels(mainWindow: BrowserWindow, projectId: string) {
  return createIPCCommunicators<MRReviewProgress, MRReviewResult>(
    mainWindow,
    {
      progress: IPC_CHANNELS.GITLAB_MR_REVIEW_PROGRESS,
      error: IPC_CHANNELS.GITLAB_MR_REVIEW_ERROR,
      complete: IPC_CHANNELS.GITLAB_MR_REVIEW_COMPLETE,
    },
    projectId
  );
}

/**
 * Fetch MR context from GitLab API for TypeScript review engine.
 */
export async function fetchMRContext(
  config: { token: string; instanceUrl: string; project: string },
  mrIid: number
): Promise<MRContext> {
  const encodedProject = encodeProjectPath(config.project);

  // Fetch MR metadata
  const mr = await gitlabFetch(
    config.token,
    config.instanceUrl,
    `/projects/${encodedProject}/merge_requests/${mrIid}`
  ) as {
    iid: number;
    title: string;
    description?: string;
    author: { username: string };
    source_branch: string;
    target_branch: string;
    changes_count?: string;
    diff_refs?: { head_sha?: string };
    sha?: string;
  };

  // Fetch changed files
  const changes = await gitlabFetch(
    config.token,
    config.instanceUrl,
    `/projects/${encodedProject}/merge_requests/${mrIid}/changes`
  ) as { changes: Array<{ new_path?: string; old_path?: string; diff: string; new_file?: boolean; deleted_file?: boolean }> };

  // Build diff from changes
  let diff = changes.changes
    .map((c) => {
      const filePath = c.new_path ?? c.old_path ?? 'unknown';
      return `diff --git a/${filePath} b/${filePath}\n${c.diff}`;
    })
    .join('\n');

  if (diff.length > 200000) {
    diff = diff.slice(0, 200000);
  }

  // Count additions/deletions from diff
  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) totalAdditions++;
    else if (line.startsWith('-') && !line.startsWith('---')) totalDeletions++;
  }

  return {
    mrIid: mr.iid,
    title: mr.title,
    description: mr.description,
    author: mr.author.username,
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    changedFiles: changes.changes,
    diff,
    totalAdditions,
    totalDeletions,
  };
}

/**
 * zeenha fork: fetch the MR head into a detached worktree so the reviewer reads
 * the MR's own code. Falls back to a 'base' result (diff-only review) on failure.
 */
export async function prepareCheckoutForMR(
  project: Project,
  mrIid: number,
  sendProgress: (update: MRReviewProgress) => void
): Promise<PRReviewCheckout> {
  const checkout = await prepareMRReviewCheckout(project.path, mrIid);
  const message =
    checkout.kind === 'pr-head'
      ? `Reviewing a checkout of the MR head ${checkout.sha.slice(0, 12)}`
      : `Could not check out the MR; reviewing the diff only: ${checkout.reason}`;
  debugLog('MR review checkout prepared', { mrIid, kind: checkout.kind });
  sendProgress({ phase: 'analyzing', mrIid, progress: 32, message });
  return checkout;
}

/** zeenha fork: release a checkout; a cleanup failure must never mask the review outcome. */
export async function cleanupCheckout(checkout: PRReviewCheckout | null): Promise<void> {
  if (checkout?.kind !== 'pr-head') return;
  try {
    await checkout.cleanup();
  } catch (err) {
    debugLog('MR review checkout cleanup failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Run the TypeScript MR reviewer using MRReviewEngine.
 * Returns null when a review for this MR is already running. Does not send the
 * final 'complete' progress or the complete event; the caller does.
 */
export async function runMRReview(
  project: Project,
  mrIid: number,
  mainWindow: BrowserWindow,
  { followup }: { followup: boolean }
): Promise<MRReviewResult | null> {
  const reviewKey = getReviewKey(project.id, mrIid);
  if (runningReviews.has(reviewKey)) {
    debugLog('MR review already running', { reviewKey });
    return null;
  }

  // Registered before any await so a second start sees this review as running
  const abortController = new AbortController();
  runningReviews.set(reviewKey, abortController);
  debugLog('Registered review abort controller', { reviewKey });

  const { sendProgress } = reviewChannels(mainWindow, project.id);

  // zeenha fork: review a checkout of the MR head, released in the finally below
  let checkout: PRReviewCheckout | null = null;
  let mcp: PRReviewMcpSession | null = null;
  try {
    const config = await getGitLabConfig(project);
    if (!config) {
      throw new Error('No GitLab configuration found for project');
    }

    const { model, thinkingLevel } = getGitLabMRSettings();
    debugLog('Starting TypeScript MR review', { model, thinkingLevel, mrIid, followup });

    sendProgress({ phase: 'fetching', mrIid, progress: 15, message: 'Fetching MR data from GitLab...' });

    const context = await fetchMRContext(config, mrIid);

    sendProgress({
      phase: 'analyzing',
      mrIid,
      progress: 30,
      message: followup ? 'Starting follow-up AI review...' : 'Starting AI review...',
    });

    const reviewConfig: MRReviewEngineConfig = {
      model: model as ModelShorthand,
      thinkingLevel: thinkingLevel as ThinkingLevel,
    };

    checkout = await prepareCheckoutForMR(project, mrIid, sendProgress);
    mcp = createPRReviewMcpSession(project.path, project.autoBuildPath || '.auto-claude', (line) => debugLog(line), getApprovals(project.path));

    const engine = new MRReviewEngine(reviewConfig, (update) => {
      sendProgress({ phase: 'analyzing', mrIid, progress: update.progress, message: update.message });
    });

    const reviewResult = await engine.runReview(context, abortController.signal, { checkout, mcp });

    const result: MRReviewResult = {
      mrIid,
      project: config.project,
      success: true,
      findings: reviewResult.findings,
      summary: reviewResult.summary,
      overallStatus: verdictToOverallStatus(reviewResult.verdict),
      reviewedAt: new Date().toISOString(),
      ...(followup && { isFollowupReview: true }),
    };

    saveMRReviewResultToDisk(project, mrIid, result);
    debugLog('MR review result saved to disk', { findingsCount: result.findings.length });

    return result;
  } catch (err) {
    if ((err instanceof Error && err.name === 'AbortError') || abortController.signal.aborted) {
      throw new Error('Review cancelled');
    }
    throw err;
  } finally {
    await mcp?.close().catch(() => undefined);
    await cleanupCheckout(checkout);
    if (runningReviews.get(reviewKey) === abortController) {
      runningReviews.delete(reviewKey);
      debugLog('Unregistered review abort controller', { reviewKey });
    }
  }
}
