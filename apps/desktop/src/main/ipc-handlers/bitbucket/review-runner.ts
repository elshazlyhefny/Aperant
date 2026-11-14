/**
 * zeenha fork: Bitbucket PR review runner.
 *
 * Fetches the PR context from Bitbucket Cloud and runs the same
 * ParallelOrchestratorReviewer the GitHub review uses, so the read-only
 * validator behaviour is inherited rather than copied.
 */

import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { Project } from '../../../shared/types';
import type { PRReviewResult, PRReviewProgress, PRReviewFinding } from '../../../shared/types/pr-review';
import { createIPCCommunicators } from '../shared/ipc-communicator';
import { getBitbucketConfig } from './utils';
import { fetchBitbucketPRContext } from './review-context';
import { saveBitbucketReviewResult } from './review-results';
import { PRLogCollector } from '../github/pr/review-logs';
import { getGitHubPRSettings } from '../github/pr/review-results';
import {
  ParallelOrchestratorReviewer,
  type ParallelOrchestratorConfig
} from '../../ai/runners/github/parallel-orchestrator';
import {
  checkoutNoteFor,
  prepareBitbucketReviewCheckout,
  type PRReviewCheckout
} from '../../ai/runners/github/pr-review-checkout';
import { createPRReviewMcpSession, type PRReviewMcpSession } from '../../ai/runners/github/pr-review-mcp';
import { getApprovals } from '../../mcp-approval-store';
import type { ModelShorthand, ThinkingLevel } from '../../ai/config/types';
import { safeBreadcrumb, safeCaptureException } from '../../sentry';
import { createDebugLog } from '../../../shared/utils/debug-logger';

const debugLog = createDebugLog('Bitbucket PR Review');

/** Running Bitbucket reviews, keyed `${projectId}:${prId}`. */
export const runningBitbucketReviews = new Map<string, AbortController>();

export function getBitbucketReviewKey(projectId: string, prId: number): string {
  return `${projectId}:${prId}`;
}

const ALLOWED_PHASES = new Set(['fetching', 'analyzing', 'generating', 'posting', 'complete']);

const VERDICT_TO_STATUS: Record<string, PRReviewResult['overallStatus']> = {
  ready_to_merge: 'approve',
  merge_with_changes: 'comment',
  needs_revision: 'request_changes',
  blocked: 'request_changes'
};

export async function runBitbucketPRReview(
  project: Project,
  prId: number,
  mainWindow: BrowserWindow
): Promise<PRReviewResult> {
  const { sendProgress } = createIPCCommunicators<PRReviewProgress, PRReviewResult>(
    mainWindow,
    {
      progress: IPC_CHANNELS.BITBUCKET_PR_REVIEW_PROGRESS,
      error: IPC_CHANNELS.BITBUCKET_PR_REVIEW_ERROR,
      complete: IPC_CHANNELS.BITBUCKET_PR_REVIEW_COMPLETE
    },
    project.id
  );

  // Registered before any await so a second start sees this review as running
  const reviewKey = getBitbucketReviewKey(project.id, prId);
  const abortController = new AbortController();
  runningBitbucketReviews.set(reviewKey, abortController);

  let checkout: PRReviewCheckout | null = null;
  let mcp: PRReviewMcpSession | null = null;
  let logCollector: PRLogCollector | null = null;

  try {
    const config = await getBitbucketConfig(project);
    if (!config) {
      throw new Error('No Bitbucket configuration found for project');
    }
    const repo = config.repository;
    const { model, thinkingLevel } = getGitHubPRSettings();

    safeBreadcrumb({
      category: 'pr-review',
      message: 'Starting Bitbucket PR review',
      level: 'info',
      data: { model, thinkingLevel, prId, repo }
    });

    logCollector = new PRLogCollector(project, prId, repo, false, mainWindow, { provider: 'bitbucket' });
    const log = logCollector;

    log.processLine(`[fetching] Fetching PR #${prId} from Bitbucket...`);
    sendProgress({ phase: 'fetching', prNumber: prId, progress: 15, message: 'Fetching PR data from Bitbucket...' });

    const { context, headSha, sourceBranch, sourceRepository } = await fetchBitbucketPRContext(config, prId);
    log.processLine(
      `[Context] Fetched ${context.changedFiles.length} changed files, ${context.commits.length} commits`
    );

    checkout = await prepareBitbucketReviewCheckout(project.path, {
      prId,
      sourceBranch,
      headSha,
      sourceRepository,
      configuredRepository: repo
    });
    log.processLine(
      checkout.kind === 'pr-head'
        ? `[Context] Reviewing a checkout of the PR head ${checkout.sha.slice(0, 12)}`
        : `[Context] WARNING: reviewing the base branch's files, not the PR's: ${checkout.reason}`
    );
    mcp = createPRReviewMcpSession(
      project.path,
      project.autoBuildPath || '.auto-claude',
      (line) => log.processLine(`[Context] ${line}`),
      getApprovals(project.path)
    );

    sendProgress({ phase: 'analyzing', prNumber: prId, progress: 30, message: 'Starting parallel orchestrator review...' });

    const orchestratorConfig: ParallelOrchestratorConfig = {
      repo,
      projectDir: project.path,
      model: model as ModelShorthand,
      thinkingLevel: thinkingLevel as ThinkingLevel,
      reviewDir: checkout.kind === 'pr-head' ? checkout.dir : undefined,
      checkoutNote: checkoutNoteFor(checkout, context.baseBranch),
      mcp
    };

    const orchestrator = new ParallelOrchestratorReviewer(orchestratorConfig, (update) => {
      const phase = (ALLOWED_PHASES.has(update.phase) ? update.phase : 'analyzing') as PRReviewProgress['phase'];
      sendProgress({ phase, prNumber: prId, progress: update.progress, message: update.message });
      log.processLine(update.message.startsWith('[') ? update.message : `[${update.phase}] ${update.message}`);
    });

    const orchestratorResult = await orchestrator.review(context, abortController.signal);

    const result: PRReviewResult = {
      prNumber: prId,
      repo,
      success: true,
      findings: orchestratorResult.findings as PRReviewFinding[],
      summary: orchestratorResult.summary,
      overallStatus: VERDICT_TO_STATUS[orchestratorResult.verdict] ?? 'comment',
      reviewedAt: new Date().toISOString(),
      reviewedCommitSha: headSha
    };

    saveBitbucketReviewResult(project, prId, result);
    debugLog('Review result saved to disk', { findingsCount: result.findings.length });

    log.processLine(`[Summary] ${orchestratorResult.findings.length} findings, verdict: ${orchestratorResult.verdict}`);
    log.processLine(`[Summary] Agents: ${orchestratorResult.agentsInvoked.join(', ')}`);
    log.finalize(true);

    return result;
  } catch (err) {
    logCollector?.finalize(false);

    if (abortController.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      throw new Error('Review cancelled');
    }

    safeCaptureException(err instanceof Error ? err : new Error(String(err)), { extra: { prId } });
    throw err;
  } finally {
    runningBitbucketReviews.delete(reviewKey);
    await mcp?.close().catch(() => undefined);
    if (checkout?.kind === 'pr-head') await checkout.cleanup().catch(() => undefined);
  }
}
