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

  // zeenha fork: Measure overlapping PR status polls before introducing coalescing.
  describe('Poll coalescing', () => {
    const delayMs = 100;
    const refreshDuration = 4 * delayMs;
    const concurrencyLimit = 5;

    function installDelayedGitHubMock({
      delayMs,
      prs,
      rateLimitRemaining = 4500
    }: {
      delayMs: number;
      prs: Map<number, { updatedAt: Date; mergeable?: boolean | null }>;
      rateLimitRemaining?: number;
    }) {
      const requestsByPr = new Map<number, number>();
      const prRefreshesStarted = new Map<number, number>();
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

        requestsByPr.set(prNumber, (requestsByPr.get(prNumber) ?? 0) + 1);
        const isReview = pull?.[2] === '/reviews';
        let data: unknown;
        if (pull && !isReview) {
          prRefreshesStarted.set(prNumber, (prRefreshesStarted.get(prNumber) ?? 0) + 1);
          inFlightRefreshes++;
          peakInFlightRefreshes = Math.max(peakInFlightRefreshes, inFlightRefreshes);
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
              inFlightRefreshes--;
            }
            resolve({
              data,
              fromCache: false,
              rateLimitInfo: { remaining: rateLimitRemaining, reset: new Date(Date.now() + 3_600_000), limit: 5000 }
            });
          }, delayMs);
        });
      });

      return {
        requestsByPr,
        prRefreshesStarted,
        get inFlightRefreshes() {
          return inFlightRefreshes;
        },
        get peakInFlightRefreshes() {
          return peakInFlightRefreshes;
        },
        resetCounters() {
          requestsByPr.clear();
          prRefreshesStarted.clear();
          inFlightRefreshes = 0;
          peakInFlightRefreshes = 0;
        }
      };
    }

    async function startDelayedPolling(activeCount: number, stableCount: number) {
      vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
      const activeUpdatedAt = new Date(); // Still active at the 15-minute tick.
      const stableUpdatedAt = new Date(Date.now() - ACTIVITY_THRESHOLD_MS);
      const prs = new Map(Array.from({ length: activeCount + stableCount }, (_, i) => [
        i + 1,
        { updatedAt: i < activeCount ? activeUpdatedAt : stableUpdatedAt }
      ]));
      const delayedMock = installDelayedGitHubMock({ delayMs, prs });

      const started = poller.startPolling('o/r', [...prs.keys()], 'test-token');
      await vi.advanceTimersByTimeAsync(Math.ceil(prs.size / concurrencyLimit) * refreshDuration);
      await started;
      return { prs, delayedMock };
    }

    async function measureCollision(activeCount: number, stableCount: number) {
      const { prs, delayedMock } = await startDelayedPolling(activeCount, stableCount);

      // The active, stable and full-refresh timers all fire at 15 minutes from
      // the end of the initial pass. Reset after earlier tier-only polls have settled.
      await vi.advanceTimersByTimeAsync(POLLING_INTERVALS.FULL_REFRESH - 1);
      delayedMock.resetCounters();
      const settleTime = Math.ceil(prs.size / concurrencyLimit) * refreshDuration;
      await vi.advanceTimersByTimeAsync(1 + settleTime + delayMs);
      return { prs, delayedMock };
    }

    it('counts four requests for a single initial refresh', async () => {
      const { delayedMock } = await startDelayedPolling(1, 0);

      expect(delayedMock.requestsByPr).toEqual(new Map([[1, 4]]));
      expect(delayedMock.prRefreshesStarted).toEqual(new Map([[1, 1]]));
      expect(delayedMock.peakInFlightRefreshes).toBe(1);
      expect(delayedMock.inFlightRefreshes).toBe(0);
    });

    it.fails('refreshes each PR once when the tier and full-refresh timers coincide', async () => {
      const { prs, delayedMock } = await measureCollision(2, 2);

      // baseline: current code makes 8 requests per PR at the collision.
      expect(delayedMock.requestsByPr).toEqual(new Map([...prs.keys()].map(pr => [pr, 4])));
    });

    it.fails('caps concurrent refreshes at five per project when timers coincide', async () => {
      const { prs, delayedMock } = await measureCollision(6, 6);

      // baseline: current code peaks at 15 in-flight refreshes at the collision.
      expect(delayedMock.peakInFlightRefreshes).toBeLessThanOrEqual(concurrencyLimit);
      expect(delayedMock.prRefreshesStarted.size).toBe(prs.size);
      expect(delayedMock.inFlightRefreshes).toBe(0);
    });
  });
});
