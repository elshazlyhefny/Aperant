/**
 * PR query IPC handlers: list, get, saved reviews and review logs.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import { getGitHubConfig, githubFetch } from "../utils";
import { withProjectOrNull } from "../utils/project-middleware";
import type { PRReviewStateManager } from "../../../pr-review-state-manager";
import type { PRData, PRListResult, PRReviewResult } from "./types";
import { debugLog } from "./shared";
import { loadPRLogsIfChanged, type PRLogs, type PRLogsKnownVersion } from "./review-logs";
import { getReviewResult } from "./review-results";
import { fetchPRsFromGraphQL } from "./graphql";

/**
 * Register PR query handlers
 */
export function registerPRQueryHandlers(stateManager: PRReviewStateManager): void {
  // Reset XState actors when GitHub auth changes
  ipcMain.on(IPC_CHANNELS.GITHUB_AUTH_CHANGED, () => {
    stateManager.handleAuthChange();
  });

  // List open PRs - fetches up to 100 open PRs at once, returns hasNextPage and endCursor from API
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_LIST,
    async (_, projectId: string): Promise<PRListResult> => {
      debugLog("listPRs handler called", { projectId });
      const result = await withProjectOrNull(projectId, async (project) => {
        const config = getGitHubConfig(project);
        if (!config) {
          debugLog("No GitHub config found for project");
          return { prs: [], hasNextPage: false, endCursor: null };
        }
        return fetchPRsFromGraphQL(config, null, "initial");
      });
      return result ?? { prs: [], hasNextPage: false, endCursor: null };
    }
  );

  // Load more PRs (pagination) - fetches next page of PRs using cursor
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_LIST_MORE,
    async (_, projectId: string, cursor: string): Promise<PRListResult> => {
      debugLog("listMorePRs handler called", { projectId, cursor });
      const result = await withProjectOrNull(projectId, async (project) => {
        const config = getGitHubConfig(project);
        if (!config) {
          debugLog("No GitHub config found for project");
          return { prs: [], hasNextPage: false, endCursor: null };
        }
        return fetchPRsFromGraphQL(config, cursor, "pagination");
      });
      return result ?? { prs: [], hasNextPage: false, endCursor: null };
    }
  );

  // Get single PR
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_GET,
    async (_, projectId: string, prNumber: number): Promise<PRData | null> => {
      debugLog("getPR handler called", { projectId, prNumber });
      return withProjectOrNull(projectId, async (project) => {
        const config = getGitHubConfig(project);
        if (!config) return null;

        try {
          const pr = (await githubFetch(
            config.token,
            `/repos/${config.repo}/pulls/${prNumber}`
          )) as {
            number: number;
            title: string;
            body?: string;
            state: string;
            user: { login: string };
            head: { ref: string };
            base: { ref: string };
            additions: number;
            deletions: number;
            changed_files: number;
            assignees?: Array<{ login: string }>;
            created_at: string;
            updated_at: string;
            html_url: string;
          };

          const files = (await githubFetch(
            config.token,
            `/repos/${config.repo}/pulls/${prNumber}/files`
          )) as Array<{
            filename: string;
            additions: number;
            deletions: number;
            status: string;
          }>;

          return {
            number: pr.number,
            title: pr.title,
            body: pr.body ?? "",
            state: pr.state,
            author: { login: pr.user.login },
            headRefName: pr.head.ref,
            baseRefName: pr.base.ref,
            additions: pr.additions ?? 0,
            deletions: pr.deletions ?? 0,
            changedFiles: pr.changed_files ?? 0,
            assignees: pr.assignees?.map((a: { login: string }) => ({ login: a.login })) ?? [],
            files: files.map((f) => ({
              path: f.filename,
              additions: f.additions ?? 0,
              deletions: f.deletions ?? 0,
              status: f.status,
            })),
            createdAt: pr.created_at,
            updatedAt: pr.updated_at,
            htmlUrl: pr.html_url,
          };
        } catch {
          return null;
        }
      });
    }
  );

  // Get saved review
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_GET_REVIEW,
    async (_, projectId: string, prNumber: number): Promise<PRReviewResult | null> => {
      return withProjectOrNull(projectId, async (project) => {
        return getReviewResult(project, prNumber);
      });
    }
  );

  // Batch get saved reviews - more efficient than individual calls
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_GET_REVIEWS_BATCH,
    async (
      _,
      projectId: string,
      prNumbers: number[]
    ): Promise<Record<number, PRReviewResult | null>> => {
      debugLog("getReviewsBatch handler called", { projectId, count: prNumbers.length });
      const result = await withProjectOrNull(projectId, async (project) => {
        const reviews: Record<number, PRReviewResult | null> = {};
        for (const prNumber of prNumbers) {
          reviews[prNumber] = getReviewResult(project, prNumber);
        }
        debugLog("Batch loaded reviews", {
          count: Object.values(reviews).filter((r) => r !== null).length,
        });
        return reviews;
      });
      return result ?? {};
    }
  );

  /**
   * Get PR review logs (IPC Handler)
   *
   * Polling is a cheap change check: the frontend passes the version it already
   * holds ({updated_at, entryCount}) and receives 'unchanged' when nothing new
   * exists, so no log data is read or serialized. Live updates arrive as deltas
   * via GITHUB_PR_LOGS_UPDATED; this handler is the initial load / fallback.
   *
   * Polling Strategy (Frontend):
   * ============================
   * 1. **Initial Load**: When logs section expands, loads logs once via this handler
   * 2. **Active Review Polling**: Every 1.5s while review is running (isReviewing = true)
   * 3. **Final Refresh**: One final poll when review completes to capture final status
   * 4. **Fallback Load**: 500ms delayed load after completion if polling missed final logs
   *
   * Why Polling + Push Hybrid?
   * ===========================
   * - Push (IPC events): Fast notifications when logs are saved by PRLogCollector
   * - Pull (polling): Guarantees logs are fetched even if IPC events are missed
   * - File-based: Simple, debuggable, survives app crashes/restarts
   *
   * Returns null if logs file doesn't exist yet (review hasn't started).
   */
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_GET_LOGS,
    async (
      _,
      projectId: string,
      prNumber: number,
      known?: PRLogsKnownVersion
    ): Promise<PRLogs | null | "unchanged"> => {
      return withProjectOrNull(projectId, async (project) => {
        return loadPRLogsIfChanged(project, prNumber, known);
      });
    }
  );
}
