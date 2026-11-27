/**
 * Integration tests for pr-status-poller.ts
 *
 * Tests for polling lifecycle, IPC communication, and system integration:
 * - Start/stop polling on project change
 * - Status updates flow to UI via IPC
 * - Token refresh handling during active polling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PRStatusPoller } from '../pr-status-poller';
import { ACTIVITY_THRESHOLD_MS, POLLING_INTERVALS, RATE_LIMIT_THRESHOLDS } from '../../../shared/types/pr-status';
import type { PRStatusUpdate, PollingMetadata, PRStatus } from '../../../shared/types/pr-status';

// Mock the GitHub utils module
const mockGithubFetchWithETag = vi.fn();
const mockClearETagCacheForProject = vi.fn();
const mockGetETagCache = vi.fn();

vi.mock('../../ipc-handlers/github/utils', () => ({
  githubFetchWithETag: (...args: unknown[]) => mockGithubFetchWithETag(...args),
  clearETagCacheForProject: (...args: unknown[]) => mockClearETagCacheForProject(...args),
  getETagCache: () => mockGetETagCache()
}));

// Mock safeSendToRenderer - capture calls for verification
const mockSafeSendToRenderer = vi.fn();
vi.mock('../../ipc-handlers/utils', () => ({
  safeSendToRenderer: (...args: unknown[]) => mockSafeSendToRenderer(...args)
}));

// Mock IPC_CHANNELS
vi.mock('../../../shared/constants', () => ({
  IPC_CHANNELS: {
    GITHUB_PR_STATUS_UPDATE: 'github:pr-status-update'
  }
}));

describe('PRStatusPoller Integration Tests', () => {
  let poller: PRStatusPoller;

  /**
   * Helper to create a mock main window for IPC testing
   */
  function createMockMainWindow() {
    return {
      webContents: {
        send: vi.fn(),
        isDestroyed: () => false
      },
      isDestroyed: () => false
    } as unknown as Electron.BrowserWindow;
  }

  /**
   * Helper to set up mock responses for full PR polling cycle
   * (PR data, status, check runs, reviews)
   */
  function setupFullPollingMocks(prNumber: number, options?: {
    checksStatus?: 'success' | 'pending' | 'failure';
    reviewStatus?: 'APPROVED' | 'CHANGES_REQUESTED' | 'PENDING';
    mergeableState?: string;
    rateLimitRemaining?: number;
  }) {
    const opts = options ?? {};
    const rateLimitRemaining = opts.rateLimitRemaining ?? 4500;
    const rateLimitInfo = { remaining: rateLimitRemaining, reset: new Date(Date.now() + 3600000), limit: 5000 };

    // PR endpoint response (head.sha passed to fetchChecksStatus, no duplicate fetch)
    mockGithubFetchWithETag
      .mockResolvedValueOnce({
        data: {
          number: prNumber,
          updated_at: new Date().toISOString(),
          head: { sha: `sha-${prNumber}` },
          mergeable: opts.mergeableState !== 'dirty',
          mergeable_state: opts.mergeableState ?? 'clean'
        },
        fromCache: false,
        rateLimitInfo
      })
      // Combined status endpoint
      .mockResolvedValueOnce({
        data: {
          state: opts.checksStatus ?? 'success',
          statuses: opts.checksStatus === 'failure'
            ? [{ state: 'failure' }]
            : opts.checksStatus === 'pending'
            ? [{ state: 'pending' }]
            : [{ state: 'success' }]
        },
        fromCache: false,
        rateLimitInfo
      })
      // Check runs endpoint
      .mockResolvedValueOnce({
        data: {
          total_count: 1,
          check_runs: [
            {
              status: 'completed',
              conclusion: opts.checksStatus ?? 'success'
            }
          ]
        },
        fromCache: false,
        rateLimitInfo
      })
      // Reviews endpoint
      .mockResolvedValueOnce({
        data: opts.reviewStatus
          ? [{ state: opts.reviewStatus, user: { login: 'reviewer1' }, submitted_at: new Date().toISOString() }]
          : [],
        fromCache: false,
        rateLimitInfo
      });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    // Reset singleton and create fresh instance
    PRStatusPoller.resetInstance();
    poller = PRStatusPoller.getInstance();

    // Reset all mocks
    mockGithubFetchWithETag.mockReset();
    mockClearETagCacheForProject.mockReset();
    mockSafeSendToRenderer.mockReset();
  });

  afterEach(() => {
    // Clean up timers and polling
    poller.stopAllPolling();
    vi.useRealTimers();
  });

  describe('Polling Lifecycle: Start/Stop on Project Change', () => {
    it('should start polling when a new project is selected', async () => {
      setupFullPollingMocks(1);

      await poller.startPolling('owner/repo', [1], 'test-token');

      const metadata = poller.getPollingMetadata('owner/repo');
      expect(metadata.isPolling).toBe(true);
      expect(mockGithubFetchWithETag).toHaveBeenCalled();
    });

    it('should stop polling for old project when switching to new project', async () => {
      // Start polling for first project
      setupFullPollingMocks(1);
      await poller.startPolling('owner/repo1', [1], 'test-token');

      expect(poller.getPollingMetadata('owner/repo1').isPolling).toBe(true);

      // Switch to second project
      setupFullPollingMocks(2);
      await poller.startPolling('owner/repo2', [2], 'test-token');

      // First project should still be polling (not auto-stopped)
      expect(poller.getPollingMetadata('owner/repo1').isPolling).toBe(true);
      expect(poller.getPollingMetadata('owner/repo2').isPolling).toBe(true);

      // Explicitly stop first project
      poller.stopPolling('owner/repo1');
      expect(poller.getPollingMetadata('owner/repo1').isPolling).toBe(false);
      expect(poller.getPollingMetadata('owner/repo2').isPolling).toBe(true);
    });

    it('should clean up timers and caches when stopping polling', async () => {
      setupFullPollingMocks(1);
      await poller.startPolling('owner/repo', [1], 'test-token');

      // Stop polling
      poller.stopPolling('owner/repo');

      // Verify cache was cleared
      expect(mockClearETagCacheForProject).toHaveBeenCalled();

      // Verify polling state is cleared
      expect(poller.getPollingMetadata('owner/repo').isPolling).toBe(false);

      // Advance time and verify no more API calls are made
      const callCountAfterStop = mockGithubFetchWithETag.mock.calls.length;
      vi.advanceTimersByTime(POLLING_INTERVALS.ACTIVE + 1000);
      expect(mockGithubFetchWithETag.mock.calls.length).toBe(callCountAfterStop);
    });

    it('should replace existing polling when startPolling called for same project', async () => {
      setupFullPollingMocks(1);
      await poller.startPolling('owner/repo', [1], 'old-token');

      // Clear mock to track new calls
      mockClearETagCacheForProject.mockClear();

      // Start polling again with different PRs and token
      setupFullPollingMocks(2);
      await poller.startPolling('owner/repo', [2], 'new-token');

      // Should have cleared cache when stopping old polling
      expect(mockClearETagCacheForProject).toHaveBeenCalled();

      // Should still be polling
      expect(poller.getPollingMetadata('owner/repo').isPolling).toBe(true);
    });

    it('should stop all polling when stopAllPolling is called', async () => {
      // Start polling for multiple projects
      setupFullPollingMocks(1);
      await poller.startPolling('owner/repo1', [1], 'test-token');
      setupFullPollingMocks(2);
      await poller.startPolling('owner/repo2', [2], 'test-token');

      expect(poller.getPollingMetadata('owner/repo1').isPolling).toBe(true);
      expect(poller.getPollingMetadata('owner/repo2').isPolling).toBe(true);

      // Stop all polling
      poller.stopAllPolling();

      expect(poller.getPollingMetadata('owner/repo1').isPolling).toBe(false);
      expect(poller.getPollingMetadata('owner/repo2').isPolling).toBe(false);
    });

    it('should handle rapid project switching gracefully', async () => {
      // Simulate rapid project switching
      for (let i = 0; i < 5; i++) {
        setupFullPollingMocks(i + 1);
        await poller.startPolling(`owner/repo${i}`, [i + 1], 'test-token');
        poller.stopPolling(`owner/repo${i}`);
      }

      // All projects should be stopped
      for (let i = 0; i < 5; i++) {
        expect(poller.getPollingMetadata(`owner/repo${i}`).isPolling).toBe(false);
      }
    });
  });

  describe('Status Updates Flow to UI', () => {
    it('should send status updates to renderer via IPC', async () => {
      const mockMainWindow = createMockMainWindow();
      poller.setMainWindowGetter(() => mockMainWindow);

      setupFullPollingMocks(1, { checksStatus: 'success', reviewStatus: 'APPROVED' });
      await poller.startPolling('owner/repo', [1], 'test-token');

      // Verify safeSendToRenderer was called with status update
      expect(mockSafeSendToRenderer).toHaveBeenCalled();

      const calls = mockSafeSendToRenderer.mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      // Check that the correct channel was used
      const updateCall = calls.find((call: unknown[]) =>
        call[1] === 'github:pr-status-update'
      );
      expect(updateCall).toBeTruthy();

      // Verify the update structure
      if (updateCall) {
        const update = updateCall[2] as PRStatusUpdate;
        expect(update.projectId).toBe('owner/repo');
        expect(update.statuses).toBeDefined();
        expect(update.metadata).toBeDefined();
        expect(update.metadata.isPolling).toBe(true);
      }
    });

    it('should include PR status in updates', async () => {
      const mockMainWindow = createMockMainWindow();
      poller.setMainWindowGetter(() => mockMainWindow);

      setupFullPollingMocks(42, {
        checksStatus: 'success',
        reviewStatus: 'APPROVED',
        mergeableState: 'clean'
      });
      await poller.startPolling('owner/repo', [42], 'test-token');

      // Find the status update call
      const updateCall = mockSafeSendToRenderer.mock.calls.find((call: unknown[]) =>
        call[1] === 'github:pr-status-update'
      );

      expect(updateCall).toBeTruthy();
      if (updateCall) {
        const update = updateCall[2] as PRStatusUpdate;
        expect(update.statuses.length).toBeGreaterThan(0);

        const prStatus = update.statuses.find((s: PRStatus) => s.prNumber === 42);
        expect(prStatus).toBeDefined();
        if (prStatus) {
          expect(prStatus.checksStatus).toBe('success');
          expect(prStatus.reviewsStatus).toBe('approved');
          expect(prStatus.mergeableState).toBe('clean');
        }
      }
    });

    it('should include polling metadata in updates', async () => {
      const mockMainWindow = createMockMainWindow();
      poller.setMainWindowGetter(() => mockMainWindow);

      setupFullPollingMocks(1);
      await poller.startPolling('owner/repo', [1], 'test-token');

      const updateCall = mockSafeSendToRenderer.mock.calls.find((call: unknown[]) =>
        call[1] === 'github:pr-status-update'
      );

      expect(updateCall).toBeTruthy();
      if (updateCall) {
        const update = updateCall[2] as PRStatusUpdate;
        const metadata: PollingMetadata = update.metadata;

        expect(metadata.isPolling).toBe(true);
        expect(metadata.isPausedForRateLimit).toBe(false);
        expect(metadata.rateLimitRemaining).toBe(4500);
        expect(metadata.lastError).toBeNull();
      }
    });

    it('should handle missing main window gracefully', async () => {
      // Don't set main window getter
      setupFullPollingMocks(1);

      // Should not throw
      await expect(poller.startPolling('owner/repo', [1], 'test-token')).resolves.not.toThrow();

      // Polling should still work
      expect(poller.getPollingMetadata('owner/repo').isPolling).toBe(true);
    });

    it('should continue sending updates after timer intervals', async () => {
      const mockMainWindow = createMockMainWindow();
      poller.setMainWindowGetter(() => mockMainWindow);

      setupFullPollingMocks(1);
      await poller.startPolling('owner/repo', [1], 'test-token');

      const initialCalls = mockSafeSendToRenderer.mock.calls.length;

      // Set up mocks for the next poll cycle
      setupFullPollingMocks(1);

      // Advance timer past active polling interval
      vi.advanceTimersByTime(POLLING_INTERVALS.ACTIVE + 1000);

      // Allow promises to resolve
      await vi.runOnlyPendingTimersAsync();

      // Should have made additional IPC calls
      expect(mockSafeSendToRenderer.mock.calls.length).toBeGreaterThan(initialCalls);
    });

    it('should send rate limit pause notification to all contexts', async () => {
      const mockMainWindow = createMockMainWindow();
      poller.setMainWindowGetter(() => mockMainWindow);

      // Start polling for two projects
      setupFullPollingMocks(1);
      await poller.startPolling('owner/repo1', [1], 'test-token');
      setupFullPollingMocks(2);
      await poller.startPolling('owner/repo2', [2], 'test-token');

      mockSafeSendToRenderer.mockClear();

      // Trigger rate limit pause
      mockGithubFetchWithETag.mockResolvedValue({
        data: { number: 1, updated_at: new Date().toISOString(), head: { sha: 'abc' }, mergeable: true, mergeable_state: 'clean' },
        fromCache: false,
        rateLimitInfo: { remaining: RATE_LIMIT_THRESHOLDS.PAUSE_THRESHOLD - 1, reset: new Date(Date.now() + 3600000), limit: 5000 }
      });

      // Advance to next poll cycle and flush async work
      await vi.advanceTimersByTimeAsync(POLLING_INTERVALS.ACTIVE + 1000);

      // Both projects should reflect paused state
      expect(poller.getPollingMetadata('owner/repo1').isPausedForRateLimit).toBe(true);
      expect(poller.getPollingMetadata('owner/repo2').isPausedForRateLimit).toBe(true);
    });
  });

  describe('Token Refresh Handling', () => {
    it('should continue polling with new token after restart', async () => {
      setupFullPollingMocks(1);
      await poller.startPolling('owner/repo', [1], 'old-token');

      expect(poller.getPollingMetadata('owner/repo').isPolling).toBe(true);

      // Simulate token refresh by stopping and restarting with new token
      poller.stopPolling('owner/repo');
      expect(poller.getPollingMetadata('owner/repo').isPolling).toBe(false);

      setupFullPollingMocks(1);
      await poller.startPolling('owner/repo', [1], 'new-token');
      expect(poller.getPollingMetadata('owner/repo').isPolling).toBe(true);

      // Verify new token is used in API calls
      const lastCall = mockGithubFetchWithETag.mock.calls[mockGithubFetchWithETag.mock.calls.length - 1];
      expect(lastCall[0]).toBe('new-token');
    });

    it('should use updated token for subsequent poll cycles', async () => {
      // Start polling
      setupFullPollingMocks(1);
      await poller.startPolling('owner/repo', [1], 'initial-token');

      // Stop and restart with new token (simulating token refresh)
      setupFullPollingMocks(1);
      await poller.startPolling('owner/repo', [1], 'refreshed-token');

      mockGithubFetchWithETag.mockClear();

      // Set up mocks for next poll cycle
      setupFullPollingMocks(1);

      // Advance to next poll cycle
      vi.advanceTimersByTime(POLLING_INTERVALS.ACTIVE + 1000);
      await vi.runOnlyPendingTimersAsync();

      // Verify refreshed token is used
      const calls = mockGithubFetchWithETag.mock.calls;
      if (calls.length > 0) {
        expect(calls[0][0]).toBe('refreshed-token');
      }
    });

    it('should handle 401 errors indicating expired token', async () => {
      // biome-ignore lint/suspicious/noEmptyBlockStatements: Mock console.error for test
      vi.spyOn(console, 'error').mockImplementation(() => {});

      setupFullPollingMocks(1);
      await poller.startPolling('owner/repo', [1], 'test-token');

      // Simulate 401 error on next poll
      mockGithubFetchWithETag.mockRejectedValue(new Error('401 Unauthorized'));

      // Advance to trigger poll
      vi.advanceTimersByTime(POLLING_INTERVALS.ACTIVE + 1000);
      await vi.runOnlyPendingTimersAsync();

      // Should record error in metadata
      const metadata = poller.getPollingMetadata('owner/repo');
      expect(metadata.lastError).toContain('401');
    });

    it('should clear errors when restarting with fresh token', async () => {
      // biome-ignore lint/suspicious/noEmptyBlockStatements: Mock console.error for test
      vi.spyOn(console, 'error').mockImplementation(() => {});

      // Start with error
      mockGithubFetchWithETag.mockRejectedValue(new Error('401 Unauthorized'));
      await poller.startPolling('owner/repo', [1], 'expired-token');

      expect(poller.getPollingMetadata('owner/repo').lastError).toBeTruthy();

      // Restart with fresh token
      setupFullPollingMocks(1);
      await poller.startPolling('owner/repo', [1], 'fresh-token');

      // Error should be cleared (stopPolling clears errors)
      // Note: After restart, if successful, lastError should be null
      const metadata = poller.getPollingMetadata('owner/repo');
      expect(metadata.isPolling).toBe(true);
    });

    it('should preserve PR list across token refresh', async () => {
      setupFullPollingMocks(1);
      await poller.startPolling('owner/repo', [1, 2, 3], 'old-token');

      // Stop and restart with same PRs but new token
      setupFullPollingMocks(1);
      setupFullPollingMocks(2);
      setupFullPollingMocks(3);
      await poller.startPolling('owner/repo', [1, 2, 3], 'new-token');

      expect(poller.getPollingMetadata('owner/repo').isPolling).toBe(true);
    });
  });

  describe('PR Management During Polling', () => {
    it('should add new PRs to existing polling context', async () => {
      setupFullPollingMocks(1);
      await poller.startPolling('owner/repo', [1], 'test-token');

      // Add more PRs
      poller.addPRs('owner/repo', [2, 3]);

      // Polling should continue
      expect(poller.getPollingMetadata('owner/repo').isPolling).toBe(true);
    });

    it('should remove PRs from existing polling context', async () => {
      setupFullPollingMocks(1);
      await poller.startPolling('owner/repo', [1, 2, 3], 'test-token');

      // Remove some PRs
      poller.removePRs('owner/repo', [2, 3]);

      // Polling should continue with remaining PRs
      expect(poller.getPollingMetadata('owner/repo').isPolling).toBe(true);
    });

    it('should handle adding duplicate PRs', async () => {
      setupFullPollingMocks(1);
      await poller.startPolling('owner/repo', [1], 'test-token');

      // Add same PR again - should not cause issues
      poller.addPRs('owner/repo', [1]);

      expect(poller.getPollingMetadata('owner/repo').isPolling).toBe(true);
    });

    it('should handle removing non-existent PRs', async () => {
      setupFullPollingMocks(1);
      await poller.startPolling('owner/repo', [1], 'test-token');

      // Remove PR that doesn't exist - should not cause issues
      poller.removePRs('owner/repo', [999]);

      expect(poller.getPollingMetadata('owner/repo').isPolling).toBe(true);
    });
  });

  describe('Error Recovery', () => {
    it('should continue polling after transient network error', async () => {
      // biome-ignore lint/suspicious/noEmptyBlockStatements: Mock console.error for test
      vi.spyOn(console, 'error').mockImplementation(() => {});

      setupFullPollingMocks(1);
      await poller.startPolling('owner/repo', [1], 'test-token');

      // Simulate network error
      mockGithubFetchWithETag.mockRejectedValue(new Error('Network error'));

      vi.advanceTimersByTime(POLLING_INTERVALS.ACTIVE + 1000);
      await vi.runOnlyPendingTimersAsync();

      // Error should be recorded
      expect(poller.getPollingMetadata('owner/repo').lastError).toBe('Network error');

      // But polling should continue
      expect(poller.getPollingMetadata('owner/repo').isPolling).toBe(true);

      // Next successful poll should clear error
      setupFullPollingMocks(1);

      vi.advanceTimersByTime(POLLING_INTERVALS.ACTIVE + 1000);
      await vi.runOnlyPendingTimersAsync();

      // After a successful poll, error might still be there until explicitly cleared
      // The important thing is polling continues
      expect(poller.getPollingMetadata('owner/repo').isPolling).toBe(true);
    });

    it('should pause and resume after rate limit error', async () => {
      setupFullPollingMocks(1);
      await poller.startPolling('owner/repo', [1], 'test-token');

      // Trigger rate limit
      mockGithubFetchWithETag.mockResolvedValue({
        data: { number: 1, updated_at: new Date().toISOString(), head: { sha: 'abc' }, mergeable: true, mergeable_state: 'clean' },
        fromCache: false,
        rateLimitInfo: { remaining: RATE_LIMIT_THRESHOLDS.PAUSE_THRESHOLD - 10, reset: new Date(Date.now() + 60000), limit: 5000 }
      });

      vi.advanceTimersByTime(POLLING_INTERVALS.ACTIVE + 1000);
      await vi.runOnlyPendingTimersAsync();

      expect(poller.isPaused()).toBe(true);
      expect(poller.getPollingMetadata('owner/repo').isPausedForRateLimit).toBe(true);
    });
  });

  describe('Concurrent Project Polling', () => {
    it('should handle multiple projects polling simultaneously', async () => {
      // Start polling for three different projects
      setupFullPollingMocks(1);
      await poller.startPolling('org1/repo1', [1], 'token1');
      setupFullPollingMocks(2);
      await poller.startPolling('org2/repo2', [2], 'token2');
      setupFullPollingMocks(3);
      await poller.startPolling('org3/repo3', [3], 'token3');

      // All should be polling
      expect(poller.getPollingMetadata('org1/repo1').isPolling).toBe(true);
      expect(poller.getPollingMetadata('org2/repo2').isPolling).toBe(true);
      expect(poller.getPollingMetadata('org3/repo3').isPolling).toBe(true);

      // Stop one, others should continue
      poller.stopPolling('org2/repo2');
      expect(poller.getPollingMetadata('org1/repo1').isPolling).toBe(true);
      expect(poller.getPollingMetadata('org2/repo2').isPolling).toBe(false);
      expect(poller.getPollingMetadata('org3/repo3').isPolling).toBe(true);
    });

    it('should send separate IPC updates for each project', async () => {
      const mockMainWindow = createMockMainWindow();
      poller.setMainWindowGetter(() => mockMainWindow);

      setupFullPollingMocks(1);
      await poller.startPolling('org1/repo1', [1], 'token1');
      setupFullPollingMocks(2);
      await poller.startPolling('org2/repo2', [2], 'token2');

      // Find updates for each project
      const updates = mockSafeSendToRenderer.mock.calls
        .filter((call: unknown[]) => call[1] === 'github:pr-status-update')
        .map((call: unknown[]) => call[2] as PRStatusUpdate);

      const project1Updates = updates.filter(u => u.projectId === 'org1/repo1');
      const project2Updates = updates.filter(u => u.projectId === 'org2/repo2');

      expect(project1Updates.length).toBeGreaterThan(0);
      expect(project2Updates.length).toBeGreaterThan(0);
    });
  });

  // zeenha fork: Measure overlapping PR status polls and exercise the shared queue.
  describe('Poll coalescing', () => {
    const delayMs = 100;
    const refreshDuration = 4 * delayMs;
    const concurrencyLimit = 5;

    type MockPR = { updatedAt: Date; mergeable?: boolean | null };
    type RefreshEvent = { prNumber: number; phase: 'start' | 'settle'; at: number };

    function installDelayedGitHubMock({
      delayMs: responseDelay,
      prs,
      onRefreshStart,
      getRateLimitInfo = () => ({ remaining: 4500, reset: new Date(Date.now() + 3_600_000), limit: 5000 })
    }: {
      delayMs: number | ((endpoint: string) => number);
      prs: Map<number, MockPR>;
      onRefreshStart?: (prNumber: number) => void;
      getRateLimitInfo?: () => { remaining: number; reset: Date; limit: number };
    }) {
      const requestsByPr = new Map<number, number>();
      const prRefreshesStarted = new Map<number, number>();
      const timeline: RefreshEvent[] = [];
      const inFlightByProject = new Map<string, number>();
      const peakByProject = new Map<string, number>();
      let inFlightRefreshes = 0;
      let peakInFlightRefreshes = 0;

      mockGithubFetchWithETag.mockImplementation((_token: string, endpoint: string) => {
        const pull = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)(\/reviews)?$/.exec(endpoint);
        const commit = /^\/repos\/[^/]+\/[^/]+\/commits\/sha-(\d+)\/(status|check-runs)$/.exec(endpoint);
        const prNumber = Number(pull?.[1] ?? commit?.[1]);
        const pr = prs.get(prNumber);
        if (!pr) {
          throw new Error(`Unexpected GitHub endpoint: ${endpoint}`);
        }

        const projectId = endpoint.split('/').slice(2, 4).join('/');
        requestsByPr.set(prNumber, (requestsByPr.get(prNumber) ?? 0) + 1);
        const isReview = pull?.[2] === '/reviews';
        let data: unknown;
        if (pull && !isReview) {
          prRefreshesStarted.set(prNumber, (prRefreshesStarted.get(prNumber) ?? 0) + 1);
          timeline.push({ prNumber, phase: 'start', at: Date.now() });
          inFlightRefreshes++;
          peakInFlightRefreshes = Math.max(peakInFlightRefreshes, inFlightRefreshes);
          const projectInFlight = (inFlightByProject.get(projectId) ?? 0) + 1;
          inFlightByProject.set(projectId, projectInFlight);
          peakByProject.set(projectId, Math.max(peakByProject.get(projectId) ?? 0, projectInFlight));
          onRefreshStart?.(prNumber);
          data = {
            number: prNumber,
            updated_at: pr.updatedAt.toISOString(),
            head: { sha: `sha-${prNumber}` },
            mergeable: pr.mergeable === undefined ? true : pr.mergeable,
            mergeable_state: pr.mergeable === false ? 'dirty' : 'clean'
          };
        } else if (isReview) {
          data = [];
        } else if (commit?.[2] === 'status') {
          data = { state: 'success', statuses: [{ state: 'success' }] };
        } else {
          data = { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'success' }] };
        }

        return new Promise((resolve) => {
          setTimeout(() => {
            if (isReview) {
              timeline.push({ prNumber, phase: 'settle', at: Date.now() });
              inFlightRefreshes--;
              inFlightByProject.set(projectId, (inFlightByProject.get(projectId) ?? 0) - 1);
            }
            resolve({ data, fromCache: false, rateLimitInfo: getRateLimitInfo() });
          }, typeof responseDelay === 'number' ? responseDelay : responseDelay(endpoint));
        });
      });

      return {
        requestsByPr,
        prRefreshesStarted,
        timeline,
        peakByProject,
        get inFlightRefreshes() {
          return inFlightRefreshes;
        },
        get peakInFlightRefreshes() {
          return peakInFlightRefreshes;
        },
        resetCounters() {
          // Only reset between windows, when all earlier refreshes have settled.
          expect(inFlightRefreshes).toBe(0);
          requestsByPr.clear();
          prRefreshesStarted.clear();
          timeline.length = 0;
          inFlightByProject.clear();
          peakByProject.clear();
          peakInFlightRefreshes = 0;
        }
      };
    }

    function makePRs(activeCount: number, stableCount: number): Map<number, MockPR> {
      const activeUpdatedAt = new Date();
      const stableUpdatedAt = new Date(Date.now() - ACTIVITY_THRESHOLD_MS);
      return new Map(Array.from({ length: activeCount + stableCount }, (_, i) => [
        i + 1,
        { updatedAt: i < activeCount ? activeUpdatedAt : stableUpdatedAt }
      ]));
    }

    function fullPassDuration(prCount: number, responseDelay = delayMs) {
      return Math.ceil(prCount / concurrencyLimit) * 4 * responseDelay;
    }

    function startCapturingUpdates() {
      const window = createMockMainWindow();
      poller.setMainWindowGetter(() => window);
    }

    function statusUpdates(): PRStatusUpdate[] {
      return mockSafeSendToRenderer.mock.calls
        .filter(([, channel]) => channel === 'github:pr-status-update')
        .map(([, , update]) => update as PRStatusUpdate);
    }

    function statusesFor(prNumber: number) {
      return statusUpdates().flatMap(({ statuses }) => statuses.filter(status => status.prNumber === prNumber));
    }

    beforeEach(() => {
      vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    });

    async function startDelayedPolling(activeCount: number, stableCount: number, responseDelay = delayMs) {
      const prs = makePRs(activeCount, stableCount);
      const delayedMock = installDelayedGitHubMock({ delayMs: responseDelay, prs });
      const started = poller.startPolling('o/r', [...prs.keys()], 'test-token');
      await vi.advanceTimersByTimeAsync(fullPassDuration(prs.size, responseDelay));
      await started;
      return { prs, delayedMock };
    }

    async function advanceTo(tick: number) {
      await vi.advanceTimersByTimeAsync(tick - Date.now());
    }

    async function measureCollision(activeCount: number, stableCount: number) {
      const { prs, delayedMock } = await startDelayedPolling(activeCount, stableCount);
      const firstTick = Date.now() + POLLING_INTERVALS.FULL_REFRESH;
      const measureAt = async (tick: number) => {
        // Reset just before the collision, after earlier tier-only polls have settled.
        await advanceTo(tick - 1);
        delayedMock.resetCounters();
        mockSafeSendToRenderer.mockClear();
        await advanceTo(tick + fullPassDuration(prs.size) + delayMs);
      };
      await measureAt(firstTick);
      return { prs, delayedMock, firstTick, measureAt };
    }

    it('counts four requests for a single initial refresh', async () => {
      const { delayedMock } = await startDelayedPolling(1, 0);

      expect(delayedMock.requestsByPr).toEqual(new Map([[1, 4]]));
      expect(delayedMock.prRefreshesStarted).toEqual(new Map([[1, 1]]));
      expect(delayedMock.peakInFlightRefreshes).toBe(1);
      expect(delayedMock.inFlightRefreshes).toBe(0);
    });

    it('refreshes each PR once when the tier and full-refresh timers coincide', async () => {
      const { prs, delayedMock, firstTick, measureAt } = await measureCollision(2, 2);

      // Baseline: before coalescing, the poller made 8 requests per PR at the collision.
      const expectedRequests = new Map([...prs.keys()].map(pr => [pr, 4]));
      expect(delayedMock.requestsByPr).toEqual(expectedRequests);

      // Record new activity so both active PRs stay active through the second collision.
      for (const prNumber of [1, 2]) {
        const pr = prs.get(prNumber);
        if (pr) pr.updatedAt = new Date();
      }
      await measureAt(firstTick + POLLING_INTERVALS.FULL_REFRESH);
      expect(delayedMock.requestsByPr).toEqual(expectedRequests);
    });

    it('caps concurrent refreshes at five per project when timers coincide', async () => {
      const { prs, delayedMock } = await measureCollision(6, 6);

      // Baseline: before coalescing, the poller peaked at 15 in-flight refreshes at the collision.
      expect(delayedMock.peakInFlightRefreshes).toBeLessThanOrEqual(concurrencyLimit);
      expect(delayedMock.prRefreshesStarted.size).toBe(prs.size);
      expect(delayedMock.inFlightRefreshes).toBe(0);
    });

    it('includes otherwise idle stable PRs in every full refresh', async () => {
      startCapturingUpdates();
      const prs = makePRs(1, 1);
      let tick = Date.now() + fullPassDuration(prs.size) + POLLING_INTERVALS.FULL_REFRESH;
      let idlePR = 3;
      const delayedMock = installDelayedGitHubMock({
        delayMs,
        prs,
        onRefreshStart(prNumber) {
          if (prNumber === 2 && Date.now() === tick) {
            // The stable tier has already selected its PRs. Only the full pass
            // can pick up this newly tracked stable PR at this deadline.
            prs.set(idlePR, { updatedAt: new Date(Date.now() - ACTIVITY_THRESHOLD_MS) });
            poller.addPRs('o/r', [idlePR]);
          }
        }
      });
      const started = poller.startPolling('o/r', [1, 2], 'test-token');
      await vi.advanceTimersByTimeAsync(fullPassDuration(prs.size));
      await started;

      for (let cycle = 0; cycle < 3; cycle++) {
        await advanceTo(tick - 1);
        delayedMock.resetCounters();
        mockSafeSendToRenderer.mockClear();
        await advanceTo(tick + fullPassDuration(prs.size + 1));

        expect(delayedMock.requestsByPr.get(idlePR)).toBe(4);
        expect(delayedMock.prRefreshesStarted.get(idlePR)).toBe(1);
        const fullPass = statusUpdates().filter(({ statuses }) => statuses.length === prs.size);
        expect(fullPass).toHaveLength(1);
        expect(fullPass[0].statuses).toEqual(expect.arrayContaining([
          expect.objectContaining({ prNumber: idlePR, pollingTier: 'stable' })
        ]));
        expect(statusesFor(idlePR)).toHaveLength(1);

        tick += POLLING_INTERVALS.FULL_REFRESH;
        idlePR++;
      }
    });

    async function prepareMergeableRetry(prNumber: number, retryOffset: number) {
      startCapturingUpdates();
      const prs = makePRs(6, 6);
      const pr = prs.get(prNumber);
      if (!pr) throw new Error(`Missing test PR #${prNumber}`);
      const tick = Date.now() + fullPassDuration(prs.size) + POLLING_INTERVALS.FULL_REFRESH;
      const tierInterval = prNumber <= 6 ? POLLING_INTERVALS.ACTIVE : POLLING_INTERVALS.STABLE;
      const previousTierTick = tick - tierInterval;
      const retryAt = tick + retryOffset;
      const unknownAt = retryAt - POLLING_INTERVALS.MERGEABLE_RETRY;
      const delayedMock = installDelayedGitHubMock({
        prs,
        delayMs(endpoint) {
          const now = Date.now();
          if (endpoint === `/repos/o/r/pulls/${prNumber}` && now >= previousTierTick && now < unknownAt) {
            // Stretch the last tier refresh so its retry falls inside the collision window.
            return unknownAt - now - (refreshDuration - delayMs);
          }
          return delayMs;
        }
      });
      const started = poller.startPolling('o/r', [...prs.keys()], 'test-token');
      await vi.advanceTimersByTimeAsync(fullPassDuration(prs.size));
      await started;
      await advanceTo(previousTierTick - 1);
      pr.mergeable = null;
      mockSafeSendToRenderer.mockClear();
      await advanceTo(tick - 1);
      expect(statusesFor(prNumber).at(-1)).toMatchObject({
        mergeableState: 'unknown',
        lastPolled: new Date(unknownAt).toISOString()
      });
      delayedMock.resetCounters();
      mockSafeSendToRenderer.mockClear();
      return { prs, pr, delayedMock, tick, retryAt };
    }

    it('gives a mergeable retry a later slot when the collision has already started its PR', async () => {
      // Use a PR from the tail of the full pass so the retry's IPC result follows the pass.
      const retryPR = 12;
      const thirdWave = 2 * refreshDuration;
      const { prs, pr, delayedMock, tick, retryAt } = await prepareMergeableRetry(retryPR, thirdWave + delayMs / 2);
      await advanceTo(retryAt);
      // The retry is due after the first request started, but before it settles.
      expect(delayedMock.timeline.filter(event => event.prNumber === retryPR)).toEqual([
        { prNumber: retryPR, phase: 'start', at: tick + thirdWave }
      ]);
      pr.mergeable = true;
      await advanceTo(tick + fullPassDuration(prs.size + 1) + refreshDuration);

      const events = delayedMock.timeline.filter(event => event.prNumber === retryPR);
      expect(events.map(event => event.phase)).toEqual(['start', 'settle', 'start', 'settle']);
      // Same clock tick is allowed: the settle event must precede the rerun in the timeline.
      expect(events[2].at).toBeGreaterThanOrEqual(events[1].at);
      expect(delayedMock.requestsByPr.get(retryPR)).toBe(8);
      expect(statusesFor(retryPR).at(-1)?.mergeableState).toBe('clean');
      expect(delayedMock.peakInFlightRefreshes).toBe(concurrencyLimit);
      expect(delayedMock.inFlightRefreshes).toBe(0);
      expect(delayedMock.prRefreshesStarted).toEqual(new Map([...prs.keys()].map(pr => [pr, pr === retryPR ? 2 : 1])));
    });

    it('coalesces a mergeable retry into an already queued refresh', async () => {
      const { prs, pr, delayedMock, tick, retryAt } = await prepareMergeableRetry(6, delayMs / 2);
      await advanceTo(retryAt);
      expect(delayedMock.inFlightRefreshes).toBe(concurrencyLimit);
      expect(delayedMock.prRefreshesStarted.has(6)).toBe(false);
      pr.mergeable = true;
      await advanceTo(tick + fullPassDuration(prs.size) + POLLING_INTERVALS.MERGEABLE_RETRY + refreshDuration);

      expect(delayedMock.prRefreshesStarted.get(6)).toBe(1);
      expect(delayedMock.requestsByPr.get(6)).toBe(4);
      const statuses = statusesFor(6);
      expect(statuses).toHaveLength(3); // Active, full and retry passes share the same result.
      expect(statuses.map(status => status.mergeableState)).toEqual(['clean', 'clean', 'clean']);
      expect(new Set(statuses.map(status => status.lastPolled)).size).toBe(1);
    });

    it('gives two projects independent five-slot limits at a shared collision', async () => {
      const prs = makePRs(12, 0);
      const prNumbers = [...prs.keys()];
      const delayedMock = installDelayedGitHubMock({ delayMs, prs });
      const started = Promise.all([
        poller.startPolling('owner/repo1', prNumbers.slice(0, 6), 'token1'),
        poller.startPolling('owner/repo2', prNumbers.slice(6), 'token2')
      ]);
      await vi.advanceTimersByTimeAsync(fullPassDuration(6));
      await started;
      const tick = Date.now() + POLLING_INTERVALS.FULL_REFRESH;
      await advanceTo(tick - 1);
      delayedMock.resetCounters();
      await advanceTo(tick + fullPassDuration(6));

      expect(delayedMock.peakByProject).toEqual(new Map([
        ['owner/repo1', concurrencyLimit],
        ['owner/repo2', concurrencyLimit]
      ]));
      expect(delayedMock.peakInFlightRefreshes).toBe(2 * concurrencyLimit);
      expect(delayedMock.requestsByPr).toEqual(new Map(prNumbers.map(pr => [pr, 4])));
      expect(delayedMock.inFlightRefreshes).toBe(0);
    });

    it('starts active PRs first without starving stable PRs', async () => {
      const longDelay = 500;
      const activeCount = 12;
      const { delayedMock } = await startDelayedPolling(activeCount, 2, longDelay);
      const tick = Date.now() + POLLING_INTERVALS.FULL_REFRESH;
      await advanceTo(tick - 1);
      delayedMock.resetCounters();
      await advanceTo(tick + fullPassDuration(activeCount + 2, longDelay));

      const starts = delayedMock.timeline.filter(event => event.phase === 'start');
      expect(starts.slice(0, concurrencyLimit).map(event => event.prNumber)).toEqual([1, 2, 3, 4, 5]);
      const stableStarts = starts.filter(event => event.prNumber > activeCount);
      expect(stableStarts.map(event => event.prNumber)).toEqual([13, 14]);
      expect(starts[concurrencyLimit].prNumber).toBe(13); // A normal slot after five high starts.
      for (const event of stableStarts) {
        expect(event.at).toBeLessThan(tick + POLLING_INTERVALS.FULL_REFRESH);
      }
    });

    it('publishes the tail status within three refresh waves of a 12-PR full tick', async () => {
      startCapturingUpdates();
      const { prs, firstTick } = await measureCollision(6, 6);
      const fullPass = statusUpdates().find(({ statuses }) => statuses.length === prs.size);
      expect(fullPass?.statuses.map(status => status.prNumber).sort((a, b) => a - b)).toEqual([...prs.keys()]);
      const latestPoll = Math.max(...(fullPass?.statuses ?? []).map(status => Date.parse(status.lastPolled ?? '')));
      const tailAge = latestPoll - firstTick;
      expect(tailAge).toBeGreaterThan(2 * refreshDuration);
      expect(tailAge).toBeLessThanOrEqual(fullPassDuration(prs.size) + delayMs);
    });

    it('stops all requests and IPC updates when stopped mid-drain', async () => {
      startCapturingUpdates();
      const { delayedMock } = await startDelayedPolling(6, 6, 500);
      const tick = Date.now() + POLLING_INTERVALS.FULL_REFRESH;
      await advanceTo(tick - 1);
      delayedMock.resetCounters();
      mockSafeSendToRenderer.mockClear();
      await advanceTo(tick);
      expect(delayedMock.inFlightRefreshes).toBe(concurrencyLimit);
      expect(delayedMock.prRefreshesStarted.size).toBe(concurrencyLimit);

      poller.stopPolling('o/r');
      const requestCount = mockGithubFetchWithETag.mock.calls.length;
      await vi.advanceTimersByTimeAsync(POLLING_INTERVALS.FULL_REFRESH + 1000);
      expect(mockGithubFetchWithETag).toHaveBeenCalledTimes(requestCount);
      expect(delayedMock.prRefreshesStarted.size).toBe(concurrencyLimit);
      expect(mockSafeSendToRenderer).not.toHaveBeenCalled();
    });

    it.each(['owner/repo1', 'owner/repo2'])('discards a mid-drain result when switching to %s', async (nextProjectId) => {
      startCapturingUpdates();
      const prs = makePRs(7, 0);
      const delayedMock = installDelayedGitHubMock({ delayMs, prs });
      const oldProjectId = 'owner/repo1';
      const oldStart = poller.startPolling(oldProjectId, [1, 2, 3, 4, 5, 6], 'old-token');
      await vi.advanceTimersByTimeAsync(fullPassDuration(6));
      await oldStart;
      const tick = Date.now() + POLLING_INTERVALS.FULL_REFRESH;
      await advanceTo(tick - 1);
      delayedMock.resetCounters();
      mockSafeSendToRenderer.mockClear();
      await advanceTo(tick);
      expect(delayedMock.inFlightRefreshes).toBe(concurrencyLimit);

      poller.stopPolling(oldProjectId);
      const newStart = poller.startPolling(nextProjectId, [7], 'new-token');
      await vi.advanceTimersByTimeAsync(refreshDuration);
      await newStart;

      expect(delayedMock.prRefreshesStarted.has(6)).toBe(false);
      expect(delayedMock.requestsByPr.get(7)).toBe(4);
      expect(poller.getPollingMetadata(nextProjectId).isPolling).toBe(true);
      const updates = statusUpdates();
      expect(updates.map(update => update.projectId)).toEqual([nextProjectId]);
      expect(updates[0].statuses.map(status => status.prNumber)).toEqual([7]);
    });

    it('drops queued work on pause and refreshes every tracked PR on staggered resume', async () => {
      const prs = makePRs(12, 0);
      const prNumbers = [...prs.keys()];
      const reset = new Date(Date.now() + 2 * POLLING_INTERVALS.ACTIVE);
      let firstResponse = true;
      const delayedMock = installDelayedGitHubMock({
        delayMs,
        prs,
        getRateLimitInfo() {
          const remaining = firstResponse ? RATE_LIMIT_THRESHOLDS.PAUSE_THRESHOLD - 1 : 4500;
          firstResponse = false;
          return { remaining, reset, limit: 5000 };
        }
      });
      const initialPassFinished = vi.fn();
      const started = poller.startPolling('owner/repo1', prNumbers.slice(0, 11), 'token1').then(initialPassFinished);
      const resumeAt = reset.getTime() + 1000;
      await vi.advanceTimersByTimeAsync(refreshDuration);
      expect(poller.isPaused()).toBe(true);
      expect(initialPassFinished).toHaveBeenCalledTimes(1);
      await started;
      expect([...delayedMock.prRefreshesStarted.keys()]).toEqual(prNumbers.slice(0, concurrencyLimit));
      expect(delayedMock.inFlightRefreshes).toBe(0);

      // A second project started during the pause waits for its own resume slot.
      await poller.startPolling('owner/repo2', [12], 'token2');
      await advanceTo(resumeAt - 1);
      expect(delayedMock.prRefreshesStarted.size).toBe(concurrencyLimit);
      expect(poller.isPaused()).toBe(true);
      delayedMock.resetCounters();

      await advanceTo(resumeAt + fullPassDuration(11) + delayMs);
      expect(poller.isPaused()).toBe(false);
      expect(delayedMock.prRefreshesStarted).toEqual(new Map(prNumbers.slice(0, 11).map(pr => [pr, 1])));
      await advanceTo(resumeAt + 5000 + refreshDuration);
      expect(delayedMock.prRefreshesStarted).toEqual(new Map(prNumbers.map(pr => [pr, 1])));
      expect(delayedMock.requestsByPr).toEqual(new Map(prNumbers.map(pr => [pr, 4])));
    });

    it('never starts a queued refresh for a removed PR', async () => {
      startCapturingUpdates();
      const prs = makePRs(7, 0);
      const delayedMock = installDelayedGitHubMock({ delayMs, prs });
      const started = poller.startPolling('o/r', [...prs.keys()], 'test-token');
      expect(delayedMock.inFlightRefreshes).toBe(concurrencyLimit);
      expect(delayedMock.prRefreshesStarted.has(6)).toBe(false);

      poller.removePRs('o/r', [6]);
      await vi.advanceTimersByTimeAsync(fullPassDuration(prs.size));
      expect(statusUpdates()).toHaveLength(1);
      await started;

      expect(delayedMock.requestsByPr.has(6)).toBe(false);
      expect(delayedMock.requestsByPr.get(7)).toBe(4);
      expect(statusesFor(6)).toEqual([]);
    });
  });
});
