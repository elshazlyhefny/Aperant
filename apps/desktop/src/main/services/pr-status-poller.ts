/**
 * PR Status Poller Service
 *
 * Main process service for polling GitHub PR status updates at intelligent intervals.
 * Runs in the Electron main process to avoid renderer throttling when backgrounded.
 *
 * Features:
 * - Multi-tier polling intervals (60s for active PRs, 5min for stable)
 * - Coalesced refreshes with bounded concurrency per project
 * - ETag-based conditional requests to minimize API usage
 * - Rate limit monitoring with automatic pause/resume
 * - PR classification based on recent activity
 *
 * @module pr-status-poller
 */

import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type {
  PRStatus,
  PollingMetadata,
  PRStatusUpdate,
  ChecksStatus,
  ReviewsStatus,
  MergeableState,
  PRPollingTier,
  GitHubRateLimitInfo,
} from '../../shared/types/pr-status';
import {
  POLLING_INTERVALS,
  RATE_LIMIT_THRESHOLDS,
  ACTIVITY_THRESHOLD_MS,
} from '../../shared/types/pr-status';
import {
  githubFetchWithETag,
  clearETagCacheForProject,
} from '../ipc-handlers/github/utils';
import { safeSendToRenderer } from '../ipc-handlers/utils';

import { appLog } from '../app-logger';
/**
 * PR data from GitHub API (minimal fields needed for status polling)
 */
interface PRStatusPollData {
  number: number;
  updated_at: string;
  head: { sha: string };
  mergeable_state?: string;
  mergeable?: boolean | null;
}

/**
 * Combined status response from GitHub API
 */
interface CombinedStatusResponse {
  state: 'success' | 'pending' | 'failure' | 'error';
  statuses: Array<{ state: string }>;
}

/**
 * Check runs response from GitHub API
 */
interface CheckRunsResponse {
  total_count: number;
  check_runs: Array<{
    status: 'queued' | 'in_progress' | 'completed';
    conclusion: string | null;
  }>;
}

/**
 * Reviews response from GitHub API
 */
interface ReviewsResponse {
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'PENDING' | 'DISMISSED';
  user: { login: string };
  submitted_at: string;
}

/**
 * Internal PR polling state
 */
interface PRPollingState {
  prNumber: number;
  tier: PRPollingTier;
  lastActivity: Date;
  lastPolled: Date | null;
  checksStatus: ChecksStatus;
  reviewsStatus: ReviewsStatus;
  mergeableState: MergeableState;
  /** Pending retry for unknown mergeable state */
  mergeableRetryTimeout?: NodeJS.Timeout;
}

type RefreshPriority = 'high' | 'normal';

interface RefreshPass {
  remaining: Set<number>;
  statuses: PRStatus[];
  resolve: () => void;
}

interface QueuedRefresh {
  prNumber: number;
  priority: RefreshPriority;
  passes: Set<RefreshPass>;
}

const CONCURRENCY_LIMIT = 5;

/**
 * Project polling context
 */
interface ProjectPollingContext {
  projectId: string;
  owner: string;
  repo: string;
  token: string;
  prStates: Map<number, PRPollingState>;
  // zeenha fork: Coalesce overlapping tier and full-refresh polls by PR.
  queue: Map<number, QueuedRefresh>;
  inFlight: Set<number>;
  inFlightPasses: Map<number, Set<RefreshPass>>;
  rerunAfterFlight: Set<number>;
  stopped: boolean;
  pendingPasses: Set<RefreshPass>;
  highPriorityStreak: number;
  /** Timer for active tier polling */
  activeTimer: NodeJS.Timeout | null;
  /** Timer for stable tier polling */
  stableTimer: NodeJS.Timeout | null;
  /** Timer for full refresh */
  fullRefreshTimer: NodeJS.Timeout | null;
  /** Timestamp of last completed poll cycle */
  lastPollCycle: Date | null;
}

/**
 * PRStatusPoller - Main process service for intelligent PR status polling
 *
 * Singleton service that manages PR status polling across all projects.
 * Runs timers in the main process to avoid Electron's background throttling.
 */
export class PRStatusPoller {
  private static instance: PRStatusPoller | null = null;

  /** Active polling contexts by project ID */
  private contexts: Map<string, ProjectPollingContext> = new Map();

  /** Rate limit state */
  private rateLimitInfo: GitHubRateLimitInfo | null = null;
  private isPausedForRateLimit = false;
  private rateLimitResumeTimeout: NodeJS.Timeout | null = null;
  private staggeredResumeTimeouts: NodeJS.Timeout[] = [];

  /** Main window getter for sending updates */
  private getMainWindow: (() => BrowserWindow | null) | null = null;

  /** Last error for each project */
  private lastErrors: Map<string, string> = new Map();

  /** Consecutive error count per PR (projectId:prNumber → count) for log suppression */
  private consecutiveErrors: Map<string, number> = new Map();

  private constructor() {
    // Private constructor for singleton pattern
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): PRStatusPoller {
    if (!PRStatusPoller.instance) {
      PRStatusPoller.instance = new PRStatusPoller();
    }
    return PRStatusPoller.instance;
  }

  /**
   * Reset the singleton instance (for testing)
   */
  static resetInstance(): void {
    if (PRStatusPoller.instance) {
      PRStatusPoller.instance.stopAllPolling();
      PRStatusPoller.instance = null;
    }
  }

  /**
   * Set the main window getter for sending IPC updates to renderer
   */
  setMainWindowGetter(getter: () => BrowserWindow | null): void {
    this.getMainWindow = getter;
  }

  /**
   * Start polling for a project's PRs
   *
   * @param projectId - Project identifier (owner/repo format)
   * @param prNumbers - PR numbers to poll
   * @param token - GitHub API token
   */
  async startPolling(
    projectId: string,
    prNumbers: number[],
    token: string
  ): Promise<void> {
    // Stop existing polling for this project
    this.stopPolling(projectId);

    // Parse owner/repo from projectId
    const [owner, repo] = projectId.split('/');
    if (!owner || !repo) {
      console.error(`[PRStatusPoller] Invalid project ID format: ${projectId}`);
      return;
    }

    // Initialize polling context
    const context: ProjectPollingContext = {
      projectId,
      owner,
      repo,
      token,
      prStates: new Map(),
      queue: new Map(),
      inFlight: new Set(),
      inFlightPasses: new Map(),
      rerunAfterFlight: new Set(),
      stopped: false,
      pendingPasses: new Set(),
      highPriorityStreak: 0,
      activeTimer: null,
      stableTimer: null,
      fullRefreshTimer: null,
      lastPollCycle: null,
    };

    // Initialize PR states
    for (const prNumber of prNumbers) {
      context.prStates.set(prNumber, {
        prNumber,
        tier: 'stable', // Will be updated on first poll
        lastActivity: new Date(),
        lastPolled: null,
        checksStatus: 'none',
        reviewsStatus: 'none',
        mergeableState: 'unknown',
      });
    }

    this.contexts.set(projectId, context);

    appLog.info(
      `[PRStatusPoller] Started polling for ${projectId} with ${prNumbers.length} PRs`
    );

    // Run initial poll immediately
    await this.pollAllPRs(context);

    // The context may have been stopped or replaced during the initial pass.
    if (this.isCurrentContext(context)) {
      this.startPollingTimers(context);
    }
  }

  /**
   * Stop polling for a project
   */
  stopPolling(projectId: string): void {
    const context = this.contexts.get(projectId);
    if (!context) {
      return;
    }

    context.stopped = true;
    context.queue.clear();
    context.rerunAfterFlight.clear();
    context.inFlightPasses.clear();
    for (const pass of context.pendingPasses) {
      pass.resolve();
    }
    context.pendingPasses.clear();

    // Clear all timers
    if (context.activeTimer) {
      clearInterval(context.activeTimer);
    }
    if (context.stableTimer) {
      clearInterval(context.stableTimer);
    }
    if (context.fullRefreshTimer) {
      clearInterval(context.fullRefreshTimer);
    }

    // Clear mergeable retry timeouts
    for (const state of context.prStates.values()) {
      if (state.mergeableRetryTimeout) {
        clearTimeout(state.mergeableRetryTimeout);
      }
    }

    // Clear ETag cache for this project's endpoints only
    clearETagCacheForProject(projectId);

    this.contexts.delete(projectId);
    this.lastErrors.delete(projectId);
    for (const prKey of this.consecutiveErrors.keys()) {
      if (prKey.startsWith(`${projectId}:`)) {
        this.consecutiveErrors.delete(prKey);
      }
    }

    appLog.info(`[PRStatusPoller] Stopped polling for ${projectId}`);
  }

  /**
   * Stop all polling (cleanup)
   */
  stopAllPolling(): void {
    for (const projectId of this.contexts.keys()) {
      this.stopPolling(projectId);
    }

    // Clear rate limit resume timeout
    if (this.rateLimitResumeTimeout) {
      clearTimeout(this.rateLimitResumeTimeout);
      this.rateLimitResumeTimeout = null;
    }
    this.clearStaggeredResumeTimeouts();

    this.isPausedForRateLimit = false;
    this.rateLimitInfo = null;
  }

  /**
   * Clear any pending staggered resume timeouts
   */
  private clearStaggeredResumeTimeouts(): void {
    for (const timeout of this.staggeredResumeTimeouts) {
      clearTimeout(timeout);
    }
    this.staggeredResumeTimeouts = [];
  }

  /**
   * Add PRs to an existing polling context
   */
  addPRs(projectId: string, prNumbers: number[]): void {
    const context = this.contexts.get(projectId);
    if (!context) {
      console.warn(
        `[PRStatusPoller] No polling context for ${projectId}, cannot add PRs`
      );
      return;
    }

    for (const prNumber of prNumbers) {
      if (!context.prStates.has(prNumber)) {
        context.prStates.set(prNumber, {
          prNumber,
          tier: 'stable',
          lastActivity: new Date(),
          lastPolled: null,
          checksStatus: 'none',
          reviewsStatus: 'none',
          mergeableState: 'unknown',
        });
      }
    }

    appLog.info(
      `[PRStatusPoller] Added ${prNumbers.length} PRs to ${projectId}`
    );
  }

  /**
   * Remove PRs from an existing polling context
   */
  removePRs(projectId: string, prNumbers: number[]): void {
    const context = this.contexts.get(projectId);
    if (!context) {
      return;
    }

    for (const prNumber of prNumbers) {
      const state = context.prStates.get(prNumber);
      if (state?.mergeableRetryTimeout) {
        clearTimeout(state.mergeableRetryTimeout);
      }
      context.prStates.delete(prNumber);
      this.consecutiveErrors.delete(`${projectId}:${prNumber}`);
      this.dropQueuedRefresh(context, prNumber);

      // Keep the slot reserved until the request settles, but don't deliver its
      // stale result or share it with a subsequent re-add of this PR.
      const passes = context.inFlightPasses.get(prNumber);
      if (passes) {
        context.inFlightPasses.delete(prNumber);
        this.completeRefresh(context, prNumber, passes);
      }
    }

    appLog.info(
      `[PRStatusPoller] Removed ${prNumbers.length} PRs from ${projectId}`
    );
  }

  /**
   * Get current polling metadata for a project
   */
  getPollingMetadata(projectId: string): PollingMetadata {
    const context = this.contexts.get(projectId);
    const lastError = this.lastErrors.get(projectId) ?? null;

    return {
      isPolling: context !== undefined,
      lastPollCycle: context?.lastPollCycle
        ? context.lastPollCycle.toISOString()
        : null,
      rateLimitRemaining: this.rateLimitInfo?.remaining ?? null,
      rateLimitReset: this.rateLimitInfo
        ? new Date(this.rateLimitInfo.reset * 1000).toISOString()
        : null,
      isPausedForRateLimit: this.isPausedForRateLimit,
      lastError,
    };
  }

  /**
   * Check if polling is paused due to rate limit
   */
  isPaused(): boolean {
    return this.isPausedForRateLimit;
  }

  /**
   * Start polling timers for a context
   */
  private startPollingTimers(context: ProjectPollingContext): void {
    // Active tier polling (60s)
    context.activeTimer = setInterval(() => {
      void this.pollPRsByTier(context, 'active');
    }, POLLING_INTERVALS.ACTIVE);

    // Stable tier polling (5min)
    context.stableTimer = setInterval(() => {
      void this.pollPRsByTier(context, 'stable');
    }, POLLING_INTERVALS.STABLE);

    // Full refresh (15min)
    context.fullRefreshTimer = setInterval(() => {
      void this.pollAllPRs(context);
    }, POLLING_INTERVALS.FULL_REFRESH);
  }

  /**
   * Poll all PRs in a context
   */
  private pollAllPRs(context: ProjectPollingContext): Promise<void> {
    return this.enqueueRefresh(context, context.prStates.keys(), { priority: 'normal' });
  }

  /**
   * Poll PRs of a specific tier
   */
  private pollPRsByTier(context: ProjectPollingContext, tier: PRPollingTier): Promise<void> {
    const prNumbers: number[] = [];
    for (const [prNumber, state] of context.prStates) {
      if (state.tier === tier) {
        prNumbers.push(prNumber);
      }
    }

    return prNumbers.length > 0
      ? this.enqueueRefresh(context, prNumbers, { priority: tier === 'active' ? 'high' : 'normal' })
      : Promise.resolve();
  }

  private isCurrentContext(context: ProjectPollingContext): boolean {
    return !context.stopped && this.contexts.get(context.projectId) === context;
  }

  private enqueueRefresh(
    context: ProjectPollingContext,
    prNumbers: Iterable<number>,
    { priority, requireFresh }: { priority: RefreshPriority; requireFresh?: boolean }
  ): Promise<void> {
    if (!this.isCurrentContext(context) || this.isPausedForRateLimit) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const pass: RefreshPass = { remaining: new Set(), statuses: [], resolve };
      context.pendingPasses.add(pass);

      for (const prNumber of prNumbers) {
        if (!context.prStates.has(prNumber)) {
          continue;
        }
        pass.remaining.add(prNumber);

        const queued = context.queue.get(prNumber);
        if (queued) {
          queued.passes.add(pass);
          if (priority === 'high') {
            queued.priority = 'high';
          }
          continue;
        }

        const inFlightPasses = context.inFlightPasses.get(prNumber);
        if (inFlightPasses && !requireFresh) {
          inFlightPasses.add(pass);
          continue;
        }

        if (context.inFlight.has(prNumber)) {
          context.rerunAfterFlight.add(prNumber);
        }
        context.queue.set(prNumber, { prNumber, priority, passes: new Set([pass]) });
      }

      if (pass.remaining.size === 0) {
        this.finishPass(context, pass);
      }
      this.drain(context);
    });
  }

  /** Start ready refreshes without awaiting them; each completion frees a slot. */
  private drain(context: ProjectPollingContext): void {
    while (!context.stopped && !this.isPausedForRateLimit && context.inFlight.size < CONCURRENCY_LIMIT) {
      const entry = this.nextRefresh(context);
      if (!entry) {
        break;
      }
      context.queue.delete(entry.prNumber);
      context.inFlight.add(entry.prNumber);
      context.inFlightPasses.set(entry.prNumber, entry.passes);
      context.highPriorityStreak = entry.priority === 'high'
        ? Math.min(context.highPriorityStreak + 1, CONCURRENCY_LIMIT)
        : 0;
      void this.runRefresh(context, entry.prNumber);
    }
  }

  private nextRefresh(context: ProjectPollingContext): QueuedRefresh | undefined {
    const preferredPriority = context.highPriorityStreak >= CONCURRENCY_LIMIT ? 'normal' : 'high';
    let fallback: QueuedRefresh | undefined;
    for (const entry of context.queue.values()) {
      if (context.rerunAfterFlight.has(entry.prNumber)) {
        continue;
      }
      if (entry.priority === preferredPriority) {
        return entry;
      }
      fallback ??= entry;
    }
    return fallback;
  }

  private async runRefresh(context: ProjectPollingContext, prNumber: number): Promise<void> {
    let result: PromiseSettledResult<PRStatus | null>;
    try {
      result = { status: 'fulfilled', value: await this.fetchPRStatus(context, prNumber) };
    } catch (reason) {
      result = { status: 'rejected', reason };
    }
    this.settleRefresh(context, prNumber, result);
    this.drain(context);
  }

  private settleRefresh(
    context: ProjectPollingContext,
    prNumber: number,
    result: PromiseSettledResult<PRStatus | null>
  ): void {
    context.inFlight.delete(prNumber);
    const passes = context.inFlightPasses.get(prNumber);
    context.inFlightPasses.delete(prNumber);
    if (!this.isCurrentContext(context)) {
      return;
    }

    if (passes) {
      const prKey = `${context.projectId}:${prNumber}`;
      const status = result.status === 'fulfilled' ? result.value : null;
      if (status) {
        this.consecutiveErrors.delete(prKey);
      } else if (result.status === 'rejected') {
        const message = result.reason instanceof Error ? result.reason.message : 'Unknown error';
        const errorCount = (this.consecutiveErrors.get(prKey) ?? 0) + 1;
        this.consecutiveErrors.set(prKey, errorCount);
        // Only log first error and then every 10th to avoid spam.
        if (errorCount === 1 || errorCount % 10 === 0) {
          console.error(`[PRStatusPoller] Error polling PR #${prNumber} (x${errorCount}): ${message}`);
        }
        this.lastErrors.set(context.projectId, message);
      }
      this.completeRefresh(context, prNumber, passes, status);
    }

    if (context.rerunAfterFlight.delete(prNumber)) {
      const rerun = context.queue.get(prNumber);
      if (rerun) {
        // Join the back of the high-priority queue now that the PR can run again.
        context.queue.delete(prNumber);
        context.queue.set(prNumber, { ...rerun, priority: 'high' });
      }
    }
  }

  private dropQueuedRefresh(context: ProjectPollingContext, prNumber: number): void {
    context.rerunAfterFlight.delete(prNumber);
    const entry = context.queue.get(prNumber);
    if (entry) {
      context.queue.delete(prNumber);
      this.completeRefresh(context, prNumber, entry.passes);
    }
  }

  private completeRefresh(
    context: ProjectPollingContext,
    prNumber: number,
    passes: Set<RefreshPass>,
    status: PRStatus | null = null
  ): void {
    for (const pass of passes) {
      pass.remaining.delete(prNumber);
      if (status) {
        pass.statuses.push(status);
      }
      if (pass.remaining.size === 0) {
        this.finishPass(context, pass);
      }
    }
  }

  private finishPass(context: ProjectPollingContext, pass: RefreshPass): void {
    context.pendingPasses.delete(pass);
    if (this.isCurrentContext(context)) {
      context.lastPollCycle = new Date();
      if (pass.statuses.length > 0) {
        this.sendStatusUpdate(context.projectId, pass.statuses);
      }
    }
    pass.resolve();
  }

  private isCurrentRefresh(context: ProjectPollingContext, state: PRPollingState): boolean {
    return this.isCurrentContext(context) && context.prStates.get(state.prNumber) === state;
  }

  /**
   * Fetch status for a single PR
   */
  private async fetchPRStatus(
    context: ProjectPollingContext,
    prNumber: number
  ): Promise<PRStatus | null> {
    const state = context.prStates.get(prNumber);
    if (!state) {
      return null;
    }

    const { owner, repo, token } = context;

    try {
      // Fetch PR data (for updated_at and mergeable state)
      const prEndpoint = `/repos/${owner}/${repo}/pulls/${prNumber}`;
      const prResult = await githubFetchWithETag(token, prEndpoint);
      if (!this.isCurrentRefresh(context, state)) {
        return null;
      }
      this.updateGitHubRateLimitInfo(prResult.rateLimitInfo);

      const prData = prResult.data as PRStatusPollData;

      // Update last activity and classify tier
      const lastActivity = new Date(prData.updated_at);
      const tier = this.classifyPR(lastActivity);
      state.lastActivity = lastActivity;
      state.tier = tier;

      // Fetch CI status (pass headSha to avoid duplicate PR fetch)
      const checksStatus = await this.fetchChecksStatus(context, state, prData.head.sha);
      if (!this.isCurrentRefresh(context, state)) {
        return null;
      }

      // Fetch review status
      const reviewsStatus = await this.fetchReviewsStatus(context, state);
      if (!this.isCurrentRefresh(context, state)) {
        return null;
      }

      // Determine mergeable state
      const mergeableState = this.determineMergeableState(
        prData,
        context,
        state
      );

      // Update state
      state.checksStatus = checksStatus;
      state.reviewsStatus = reviewsStatus;
      state.mergeableState = mergeableState;
      state.lastPolled = new Date();

      return {
        prNumber,
        checksStatus,
        reviewsStatus,
        mergeableState,
        lastPolled: state.lastPolled.toISOString(),
        pollingTier: tier,
        lastActivity: lastActivity.toISOString(),
      };
    } catch (error) {
      if (!this.isCurrentRefresh(context, state)) {
        return null;
      }
      // Pause polling on 403 unless we know rate limit remaining is healthy
      // (a permission-denied 403 would still show healthy remaining from prior requests)
      if (
        error instanceof Error &&
        error.message.includes('403') &&
        (!this.rateLimitInfo || this.rateLimitInfo.remaining < RATE_LIMIT_THRESHOLDS.PAUSE_THRESHOLD)
      ) {
        this.pauseForRateLimit();
      }
      throw error;
    }
  }

  /**
   * Fetch CI checks status (combined status + check runs)
   */
  private async fetchChecksStatus(
    context: ProjectPollingContext,
    state: PRPollingState,
    headSha: string
  ): Promise<ChecksStatus> {
    const { owner, repo, token } = context;

    try {
      // Fetch combined status
      const statusEndpoint = `/repos/${owner}/${repo}/commits/${headSha}/status`;
      const statusResult = await githubFetchWithETag(token, statusEndpoint);
      if (!this.isCurrentRefresh(context, state)) {
        return 'none';
      }
      this.updateGitHubRateLimitInfo(statusResult.rateLimitInfo);

      const statusData = statusResult.data as CombinedStatusResponse;

      // Fetch check runs
      const checksEndpoint = `/repos/${owner}/${repo}/commits/${headSha}/check-runs`;
      const checksResult = await githubFetchWithETag(token, checksEndpoint);
      if (!this.isCurrentRefresh(context, state)) {
        return 'none';
      }
      this.updateGitHubRateLimitInfo(checksResult.rateLimitInfo);

      const checksData = checksResult.data as CheckRunsResponse;

      // Aggregate status
      return this.aggregateChecksStatus(statusData, checksData);
    } catch (error) {
      if (this.isCurrentRefresh(context, state)) {
        console.error(
          `[PRStatusPoller] Error fetching checks status for PR #${state.prNumber}:`,
          error
        );
      }
      return 'none';
    }
  }

  /**
   * Aggregate checks status from combined status and check runs
   */
  private aggregateChecksStatus(
    statusData: CombinedStatusResponse,
    checksData: CheckRunsResponse
  ): ChecksStatus {
    const hasStatuses = statusData.statuses.length > 0;
    const hasCheckRuns = checksData.total_count > 0;

    if (!hasStatuses && !hasCheckRuns) {
      return 'none';
    }

    // Check for failures
    const statusFailed = statusData.statuses.some(
      (s) => s.state === 'failure' || s.state === 'error'
    );
    const checksFailed = checksData.check_runs.some(
      (c) => c.status === 'completed' && c.conclusion === 'failure'
    );

    if (statusFailed || checksFailed) {
      return 'failure';
    }

    // Check for pending
    const statusPending = statusData.statuses.some((s) => s.state === 'pending');
    const checksPending = checksData.check_runs.some(
      (c) => c.status === 'queued' || c.status === 'in_progress'
    );

    if (statusPending || checksPending) {
      return 'pending';
    }

    // All passed
    return 'success';
  }

  /**
   * Fetch review status
   */
  private async fetchReviewsStatus(
    context: ProjectPollingContext,
    state: PRPollingState
  ): Promise<ReviewsStatus> {
    const { owner, repo, token } = context;

    try {
      const endpoint = `/repos/${owner}/${repo}/pulls/${state.prNumber}/reviews`;
      const result = await githubFetchWithETag(token, endpoint);
      if (!this.isCurrentRefresh(context, state)) {
        return 'none';
      }
      this.updateGitHubRateLimitInfo(result.rateLimitInfo);

      const reviews = result.data as ReviewsResponse[];

      return this.aggregateReviewsStatus(reviews);
    } catch (error) {
      if (this.isCurrentRefresh(context, state)) {
        console.error(
          `[PRStatusPoller] Error fetching reviews for PR #${state.prNumber}:`,
          error
        );
      }
      return 'none';
    }
  }

  /**
   * Aggregate review status from all reviews
   * Uses latest review per user to determine final status
   */
  private aggregateReviewsStatus(reviews: ReviewsResponse[]): ReviewsStatus {
    if (reviews.length === 0) {
      return 'none';
    }

    // Sort by submitted_at ascending so later entries (newer) overwrite earlier ones
    const sorted = [...reviews].sort(
      (a, b) => new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime()
    );

    // Get latest review per user
    const latestByUser = new Map<string, ReviewsResponse>();
    for (const review of sorted) {
      latestByUser.set(review.user.login, review);
    }

    const latestReviews = Array.from(latestByUser.values());

    // Check for changes requested (takes priority)
    const hasChangesRequested = latestReviews.some(
      (r) => r.state === 'CHANGES_REQUESTED'
    );
    if (hasChangesRequested) {
      return 'changes_requested';
    }

    // Check for approvals
    const hasApproval = latestReviews.some((r) => r.state === 'APPROVED');
    if (hasApproval) {
      return 'approved';
    }

    // Check for pending reviews (APPROVED and CHANGES_REQUESTED already returned above)
    const hasPendingReview = latestReviews.some((r) => r.state === 'PENDING');
    if (hasPendingReview) {
      return 'pending';
    }

    // Only comments/dismissed
    return 'none';
  }

  /**
   * Determine mergeable state from PR data
   */
  private determineMergeableState(
    prData: PRStatusPollData,
    context: ProjectPollingContext,
    state: PRPollingState
  ): MergeableState {
    // Clear any pending retry
    if (state.mergeableRetryTimeout) {
      clearTimeout(state.mergeableRetryTimeout);
      state.mergeableRetryTimeout = undefined;
    }

    // GitHub returns null when still computing
    if (prData.mergeable === null) {
      // Schedule retry after 2s
      state.mergeableRetryTimeout = setTimeout(() => {
        state.mergeableRetryTimeout = undefined;
        void this.enqueueRefresh(context, [state.prNumber], { priority: 'high', requireFresh: true });
      }, POLLING_INTERVALS.MERGEABLE_RETRY);

      return 'unknown';
    }

    // Map GitHub's mergeable_state to our enum
    switch (prData.mergeable_state) {
      case 'clean':
        return 'clean';
      case 'dirty':
      case 'unknown':
        return 'dirty';
      case 'blocked':
        return 'blocked';
      case 'unstable':
        // Has conflicts but might still be mergeable
        return prData.mergeable ? 'clean' : 'dirty';
      case 'behind':
        // Branch is behind base, but mergeable
        return prData.mergeable ? 'clean' : 'dirty';
      default:
        return 'unknown';
    }
  }

  /**
   * Classify PR into polling tier based on activity
   */
  private classifyPR(lastActivity: Date): PRPollingTier {
    const now = new Date();
    const timeSinceActivity = now.getTime() - lastActivity.getTime();

    return timeSinceActivity < ACTIVITY_THRESHOLD_MS ? 'active' : 'stable';
  }

  /**
   * Update rate limit info and check thresholds
   */
  private updateGitHubRateLimitInfo(info: { remaining: number; reset: Date; limit: number } | null): void {
    if (!info) {
      return;
    }

    // Convert Date to Unix timestamp (seconds)
    this.rateLimitInfo = {
      remaining: info.remaining,
      limit: info.limit,
      reset: Math.floor(info.reset.getTime() / 1000),
    };

    // Check if we should pause
    if (info.remaining < RATE_LIMIT_THRESHOLDS.PAUSE_THRESHOLD) {
      this.pauseForRateLimit();
    }
  }

  /**
   * Pause polling due to rate limit
   */
  private pauseForRateLimit(): void {
    if (this.isPausedForRateLimit) {
      return;
    }

    this.isPausedForRateLimit = true;
    console.warn(
      `[PRStatusPoller] Pausing polling due to rate limit (remaining: ${this.rateLimitInfo?.remaining})`
    );

    // Schedule resume after rate limit reset
    if (this.rateLimitInfo) {
      const resetTime = this.rateLimitInfo.reset * 1000;
      const now = Date.now();
      const delayMs = Math.max(0, resetTime - now) + 1000; // Add 1s buffer

      this.rateLimitResumeTimeout = setTimeout(() => {
        this.resumePolling();
      }, delayMs);

      appLog.info(
        `[PRStatusPoller] Will resume polling in ${Math.round(delayMs / 1000)}s`
      );
    }

    // Drop all work that has not started (including deferred retries). In-flight
    // refreshes still settle their passes, and resume will enqueue every PR again.
    for (const context of this.contexts.values()) {
      for (const prNumber of context.queue.keys()) {
        this.dropQueuedRefresh(context, prNumber);
      }
      this.sendStatusUpdate(context.projectId, []);
    }
  }

  /**
   * Resume polling after rate limit reset.
   * Staggers requests across contexts to avoid a burst that re-triggers rate limiting.
   */
  private resumePolling(): void {
    if (!this.isPausedForRateLimit) {
      return;
    }

    this.isPausedForRateLimit = false;
    this.rateLimitResumeTimeout = null;

    appLog.info('[PRStatusPoller] Resuming polling after rate limit reset');

    // Stagger polls across contexts (5s apart) to avoid burst
    this.clearStaggeredResumeTimeouts();
    let delay = 0;
    for (const context of this.contexts.values()) {
      const timeout = setTimeout(() => {
        void this.pollAllPRs(context);
      }, delay);
      this.staggeredResumeTimeouts.push(timeout);
      delay += 5000;
    }
  }

  /**
   * Send status update to renderer via IPC
   */
  private sendStatusUpdate(projectId: string, statuses: PRStatus[]): void {
    if (!this.getMainWindow) {
      return;
    }

    const update: PRStatusUpdate = {
      projectId,
      statuses,
      metadata: this.getPollingMetadata(projectId),
    };

    safeSendToRenderer(
      this.getMainWindow,
      IPC_CHANNELS.GITHUB_PR_STATUS_UPDATE,
      update
    );
  }
}

/**
 * Get the global PRStatusPoller instance
 */
export function getPRStatusPoller(): PRStatusPoller {
  return PRStatusPoller.getInstance();
}
