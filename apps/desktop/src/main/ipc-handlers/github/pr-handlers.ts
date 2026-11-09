/**
 * GitHub PR Review IPC handlers
 *
 * Handles AI-powered PR review:
 * 1. List and fetch PRs
 * 2. Run AI review with code analysis
 * 3. Post review comments
 * 4. Apply fixes
 */

import { ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import path from "path";
import fs from "fs";
import {
  IPC_CHANNELS,
} from "../../../shared/constants";
import { getGitHubConfig, githubFetch, } from "./utils";
import { getAugmentedEnv } from "../../env-utils";
import { withProjectOrNull } from "./utils/project-middleware";
import { landsThroughPullRequestsOnly } from "../../../shared/utils/landing-policy";
import { getPRStatusPoller } from "../../services/pr-status-poller";
import { PRReviewStateManager } from "../../pr-review-state-manager";
import type {
  StartPollingRequest,
  StopPollingRequest,
  PollingMetadata,
} from "../../../shared/types/pr-status";
import type {
  PRReviewResult,
  NewCommitsCheck,
  MergeReadiness,
} from "./pr/types";
import {
  debugLog,
  sanitizeNetworkData,
} from "./pr/shared";
import { registerPRQueryHandlers } from "./pr/query-handlers";
import { registerPRPostingHandlers } from "./pr/posting-handlers";
import { registerPRReviewHandlers } from "./pr/review-handlers";

export type {
  PRReviewFinding,
  PRReviewResult,
  NewCommitsCheck,
  MergeReadiness,
  PRData,
  PRListResult,
  PRReviewProgress,
} from "./pr/types";

/**
 * Register PR-related handlers
 */
export function registerPRHandlers(getMainWindow: () => BrowserWindow | null): void {
  debugLog("Registering PR handlers");

  const stateManager = new PRReviewStateManager(getMainWindow);

  registerPRQueryHandlers(stateManager);
  registerPRPostingHandlers(getMainWindow);

  registerPRReviewHandlers(getMainWindow, stateManager);

  // Merge PR
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_MERGE,
    async (
      _,
      projectId: string,
      prNumber: number,
      mergeMethod: "merge" | "squash" | "rebase" = "squash"
    ): Promise<boolean> => {
      debugLog("mergePR handler called", { projectId, prNumber, mergeMethod });
      const mergeResult = await withProjectOrNull(projectId, async (project) => {
        try {
          const { execFileSync } = await import("child_process");
          // zeenha fork: an in-app merge would put the PR on the base branch
          // without the merge queue. Refused while PR-only landing is on.
          if (landsThroughPullRequestsOnly(project.settings)) {
            debugLog("PR merge refused: project lands through the merge queue only", { prNumber });
            return false;
          }
          debugLog("Merging PR", { prNumber, method: mergeMethod });

          // Validate prNumber to prevent command injection
          if (!Number.isInteger(prNumber) || prNumber <= 0) {
            throw new Error("Invalid PR number");
          }

          // Validate mergeMethod to prevent command injection
          const validMethods = ["merge", "squash", "rebase"];
          if (!validMethods.includes(mergeMethod)) {
            throw new Error("Invalid merge method");
          }

          // Use execFileSync with arguments array to prevent command injection
          execFileSync("gh", ["pr", "merge", String(prNumber), `--${mergeMethod}`], {
            cwd: project.path,
            env: getAugmentedEnv(),
          });
          debugLog("PR merged successfully", { prNumber });
          return true;
        } catch (error) {
          debugLog("Failed to merge PR", {
            prNumber,
            error: error instanceof Error ? error.message : error,
          });
          return false;
        }
      });
      return mergeResult ?? false;
    }
  );

  // Check for new commits since last review
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_CHECK_NEW_COMMITS,
    async (_, projectId: string, prNumber: number): Promise<NewCommitsCheck> => {
      debugLog("checkNewCommits handler called", { projectId, prNumber });

      const result = await withProjectOrNull(projectId, async (project) => {
        // Check if review exists and has reviewed_commit_sha
        const githubDir = path.join(project.path, ".auto-claude", "github");
        const reviewPath = path.join(githubDir, "pr", `review_${prNumber}.json`);

        let review: PRReviewResult;
        try {
          const rawData = fs.readFileSync(reviewPath, "utf-8");
          const sanitizedData = sanitizeNetworkData(rawData);
          review = JSON.parse(sanitizedData);
        } catch {
          // File doesn't exist or couldn't be read
          return { hasNewCommits: false, newCommitCount: 0 };
        }

        // Normalize snake_case to camelCase for backwards compatibility with old saved files
        const reviewedCommitSha = review.reviewedCommitSha ?? (review as any).reviewed_commit_sha;
        if (!reviewedCommitSha) {
          debugLog("No reviewedCommitSha in review", { prNumber });
          return { hasNewCommits: false, newCommitCount: 0 };
        }

        // Get current PR HEAD
        const config = getGitHubConfig(project);
        if (!config) {
          return { hasNewCommits: false, newCommitCount: 0 };
        }

        // Fetch PR data to get current HEAD (before try block so it's accessible in catch)
        let currentHeadSha: string;
        try {
          const prData = (await githubFetch(
            config.token,
            `/repos/${config.repo}/pulls/${prNumber}`
          )) as { head: { sha: string }; commits: number };
          currentHeadSha = prData.head.sha;
        } catch (error) {
          debugLog("Error fetching PR data", {
            prNumber,
            error: error instanceof Error ? error.message : error,
          });
          return { hasNewCommits: false, newCommitCount: 0 };
        }

        // Early return if SHAs match - no new commits
        if (reviewedCommitSha === currentHeadSha) {
          return {
            hasNewCommits: false,
            newCommitCount: 0,
            lastReviewedCommit: reviewedCommitSha,
            currentHeadCommit: currentHeadSha,
            hasCommitsAfterPosting: false,
          };
        }

        // Try to get detailed comparison
        try {
          // Get comparison to count new commits and see what files changed
          const comparison = (await githubFetch(
            config.token,
            `/repos/${config.repo}/compare/${reviewedCommitSha}...${currentHeadSha}`
          )) as {
            ahead_by?: number;
            total_commits?: number;
            commits?: Array<{
              commit: { committer: { date: string }; message: string };
              parents?: Array<{ sha: string }>;
            }>;
            files?: Array<{ filename: string }>;
          };

          // Check if findings have been posted and if new commits are after the posting date
          const postedAt = review.postedAt || (review as any).posted_at;
          let hasCommitsAfterPosting = true; // Default to true if we can't determine

          if (postedAt && comparison.commits && comparison.commits.length > 0) {
            const postedAtDate = new Date(postedAt);
            // Check if any commit is newer than when findings were posted
            hasCommitsAfterPosting = comparison.commits.some((c) => {
              const commitDate = new Date(c.commit.committer.date);
              return commitDate > postedAtDate;
            });
            debugLog("Comparing commit dates with posted_at", {
              prNumber,
              postedAt,
              latestCommitDate:
                comparison.commits[comparison.commits.length - 1]?.commit.committer.date,
              hasCommitsAfterPosting,
            });
          } else if (!postedAt) {
            // If findings haven't been posted yet, we can't determine "after posting"
            // Follow-up should only be available after initial review is posted to GitHub
            hasCommitsAfterPosting = false;
          }

          // Check if this looks like a merge from base branch (develop/main)
          // Merge commits always have 2+ parents, so we check for that AND a merge-like message
          // Pattern matches: "Merge branch", "Merge pull request", "Merge remote-tracking",
          // "Merge 'develop' into", "Merge develop into", GitHub's "Update branch" button, etc.
          const isMergeFromBase = comparison.commits?.some((c) => {
            const hasTwoParents = (c.parents?.length ?? 0) >= 2;
            const isMergeMessage = /^merge\s+/i.test(c.commit.message);
            return hasTwoParents && isMergeMessage;
          }) ?? false;

          // Get files that had findings from the review
          const findingFiles = new Set<string>(
            (review.findings || []).map((f) => f.file).filter(Boolean)
          );

          // Get files changed in the new commits
          const newCommitFiles = (comparison.files || []).map((f) => f.filename);

          // Check for overlap between new commit files and finding files
          const overlappingFiles = newCommitFiles.filter((f) => findingFiles.has(f));
          const hasOverlapWithFindings = overlappingFiles.length > 0;

          debugLog("File overlap check", {
            prNumber,
            findingFilesCount: findingFiles.size,
            newCommitFilesCount: newCommitFiles.length,
            overlappingFiles,
            hasOverlapWithFindings,
            isMergeFromBase,
          });

          return {
            hasNewCommits: true,
            newCommitCount: comparison.ahead_by || comparison.total_commits || 1,
            lastReviewedCommit: reviewedCommitSha,
            currentHeadCommit: currentHeadSha,
            hasCommitsAfterPosting,
            hasOverlapWithFindings,
            overlappingFiles: overlappingFiles.length > 0 ? overlappingFiles : undefined,
            isMergeFromBase,
          };
        } catch (error) {
          // Comparison failed (e.g., force push made old commit unreachable)
          // Since we already verified SHAs differ, treat as having new commits
          debugLog(
            "Comparison failed but SHAs differ - likely force push, treating as new commits",
            {
              prNumber,
              reviewedCommitSha,
              currentHeadSha,
              error: error instanceof Error ? error.message : error,
            }
          );
          // Note: hasOverlapWithFindings, overlappingFiles, isMergeFromBase intentionally omitted
          // since we can't determine them without the comparison API. UI defaults to safe behavior
          // (hasOverlapWithFindings ?? true) which prompts user to verify.
          return {
            hasNewCommits: true,
            newCommitCount: 1, // Unknown count due to force push
            lastReviewedCommit: reviewedCommitSha,
            currentHeadCommit: currentHeadSha,
            hasCommitsAfterPosting: true, // Assume yes for force push scenarios
          };
        }
      });

      return result ?? { hasNewCommits: false, newCommitCount: 0 };
    }
  );

  // Check merge readiness (lightweight freshness check for verdict validation)
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_CHECK_MERGE_READINESS,
    async (_, projectId: string, prNumber: number): Promise<MergeReadiness> => {
      debugLog("checkMergeReadiness handler called", { projectId, prNumber });

      const defaultResult: MergeReadiness = {
        isDraft: false,
        mergeable: "UNKNOWN",
        isBehind: false,
        ciStatus: "none",
        blockers: [],
      };

      const result = await withProjectOrNull(projectId, async (project) => {
        const config = getGitHubConfig(project);
        if (!config) {
          debugLog("No GitHub config found for checkMergeReadiness");
          return defaultResult;
        }

        try {
          // Fetch PR data including mergeable status
          const pr = (await githubFetch(
            config.token,
            `/repos/${config.repo}/pulls/${prNumber}`
          )) as {
            draft: boolean;
            mergeable: boolean | null;
            mergeable_state: string;
            head: { sha: string };
          };

          // Determine mergeable status
          let mergeable: MergeReadiness["mergeable"] = "UNKNOWN";
          if (pr.mergeable === true) {
            mergeable = "MERGEABLE";
          } else if (pr.mergeable === false || pr.mergeable_state === "dirty") {
            mergeable = "CONFLICTING";
          }

          // Check if branch is behind base (out of date)
          // GitHub's mergeable_state can be: 'behind', 'blocked', 'clean', 'dirty', 'has_hooks', 'unknown', 'unstable'
          const isBehind = pr.mergeable_state === "behind";

          // Fetch combined commit status for CI
          let ciStatus: MergeReadiness["ciStatus"] = "none";
          try {
            const status = (await githubFetch(
              config.token,
              `/repos/${config.repo}/commits/${pr.head.sha}/status`
            )) as {
              state: "success" | "pending" | "failure" | "error";
              total_count: number;
            };

            if (status.total_count === 0) {
              // No status checks, check for check runs (GitHub Actions)
              const checkRuns = (await githubFetch(
                config.token,
                `/repos/${config.repo}/commits/${pr.head.sha}/check-runs`
              )) as {
                total_count: number;
                check_runs: Array<{ conclusion: string | null; status: string }>;
              };

              if (checkRuns.total_count > 0) {
                const hasFailing = checkRuns.check_runs.some(
                  (cr) => cr.conclusion === "failure" || cr.conclusion === "cancelled"
                );
                const hasPending = checkRuns.check_runs.some((cr) => cr.status !== "completed");

                if (hasFailing) {
                  ciStatus = "failing";
                } else if (hasPending) {
                  ciStatus = "pending";
                } else {
                  ciStatus = "passing";
                }
              }
            } else {
              // Use combined status
              if (status.state === "success") {
                ciStatus = "passing";
              } else if (status.state === "pending") {
                ciStatus = "pending";
              } else {
                ciStatus = "failing";
              }
            }
          } catch (err) {
            debugLog("Failed to fetch CI status", {
              prNumber,
              error: err instanceof Error ? err.message : err,
            });
            // Continue without CI status
          }

          // Build blockers list
          const blockers: string[] = [];
          if (pr.draft) {
            blockers.push("PR is in draft mode");
          }
          if (mergeable === "CONFLICTING") {
            blockers.push("Merge conflicts detected");
          }
          if (isBehind) {
            blockers.push("Branch is out of date with base branch. Update to check for conflicts.");
          }
          if (ciStatus === "failing") {
            blockers.push("CI checks are failing");
          }

          debugLog("checkMergeReadiness result", {
            prNumber,
            isDraft: pr.draft,
            mergeable,
            isBehind,
            ciStatus,
            blockers,
          });

          return {
            isDraft: pr.draft,
            mergeable,
            isBehind,
            ciStatus,
            blockers,
          };
        } catch (error) {
          debugLog("Failed to check merge readiness", {
            prNumber,
            error: error instanceof Error ? error.message : error,
          });
          return defaultResult;
        }
      });

      return result ?? defaultResult;
    }
  );

  // Update PR branch (sync with base branch)
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_UPDATE_BRANCH,
    async (_, projectId: string, prNumber: number): Promise<{ success: boolean; error?: string }> => {
      debugLog("updateBranch handler called", { projectId, prNumber });

      const updateResult = await withProjectOrNull(projectId, async (project) => {
        try {
          const { execFile } = await import("child_process");
          const { promisify } = await import("util");
          const execFileAsync = promisify(execFile);
          debugLog("Updating PR branch", { prNumber });

          // Validate prNumber to prevent command injection
          if (!Number.isInteger(prNumber) || prNumber <= 0) {
            throw new Error("Invalid PR number");
          }

          // Use gh pr update-branch to sync with base branch (async to avoid blocking main process)
          // --rebase is not used to avoid force-push requirements
          await execFileAsync("gh", ["pr", "update-branch", String(prNumber)], {
            cwd: project.path,
            env: getAugmentedEnv(),
          });

          debugLog("PR branch updated successfully", { prNumber });
          return { success: true };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          debugLog("Failed to update PR branch", { prNumber, error: errorMessage });

          // Map common error patterns to user-friendly messages
          let friendlyError = errorMessage;
          if (errorMessage.includes("permission") || errorMessage.includes("403")) {
            friendlyError = "You don't have permission to update this branch.";
          } else if (errorMessage.includes("401") || errorMessage.toLowerCase().includes("auth") || errorMessage.toLowerCase().includes("token")) {
            friendlyError = "Authentication failed. Try running 'gh auth login' to re-authenticate.";
          } else if (errorMessage.includes("404") || errorMessage.includes("not found")) {
            friendlyError = "Pull request not found. It may have been closed or deleted.";
          } else if (errorMessage.includes("429") || errorMessage.toLowerCase().includes("rate limit")) {
            friendlyError = "GitHub API rate limit exceeded. Please wait and try again.";
          } else if (errorMessage.includes("conflict")) {
            friendlyError = "Cannot update branch due to merge conflicts. Resolve conflicts manually.";
          } else if (errorMessage.toLowerCase().includes("protected") || errorMessage.toLowerCase().includes("branch protection")) {
            friendlyError = "Branch protection rules prevent this update.";
          } else if (errorMessage.includes("ENOTFOUND") || errorMessage.includes("ECONNREFUSED") || errorMessage.includes("ETIMEDOUT")) {
            friendlyError = "Network error. Check your internet connection and try again.";
          } else if (errorMessage.toLowerCase().includes("already up to date")) {
            return { success: true }; // Not an error
          }

          return { success: false, error: friendlyError };
        }
      });

      return updateResult ?? { success: false, error: "Project not found" };
    }
  );

  // Get workflows awaiting approval for a PR (fork PRs)
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_WORKFLOWS_AWAITING_APPROVAL,
    async (
      _,
      projectId: string,
      prNumber: number
    ): Promise<{
      awaiting_approval: number;
      workflow_runs: Array<{ id: number; name: string; html_url: string; workflow_name: string }>;
      can_approve: boolean;
      error?: string;
    }> => {
      debugLog("getWorkflowsAwaitingApproval handler called", { projectId, prNumber });
      const result = await withProjectOrNull(projectId, async (project) => {
        const config = getGitHubConfig(project);
        if (!config) {
          return {
            awaiting_approval: 0,
            workflow_runs: [],
            can_approve: false,
            error: "No GitHub config",
          };
        }

        try {
          // First get the PR's head SHA
          const prData = (await githubFetch(
            config.token,
            `/repos/${config.repo}/pulls/${prNumber}`
          )) as { head?: { sha?: string } };

          const headSha = prData?.head?.sha;
          if (!headSha) {
            return { awaiting_approval: 0, workflow_runs: [], can_approve: false };
          }

          // Query workflow runs with action_required status
          const runsData = (await githubFetch(
            config.token,
            `/repos/${config.repo}/actions/runs?status=action_required&per_page=100`
          )) as {
            workflow_runs?: Array<{
              id: number;
              name: string;
              html_url: string;
              head_sha: string;
              workflow?: { name?: string };
            }>;
          };

          const allRuns = runsData?.workflow_runs || [];

          // Filter to only runs for this PR's head SHA
          const prRuns = allRuns
            .filter((run) => run.head_sha === headSha)
            .map((run) => ({
              id: run.id,
              name: run.name,
              html_url: run.html_url,
              workflow_name: run.workflow?.name || "Unknown",
            }));

          debugLog("Found workflows awaiting approval", { prNumber, count: prRuns.length });

          return {
            awaiting_approval: prRuns.length,
            workflow_runs: prRuns,
            can_approve: true, // Assume token has permission; will fail if not
          };
        } catch (error) {
          debugLog("Failed to get workflows awaiting approval", {
            prNumber,
            error: error instanceof Error ? error.message : error,
          });
          return {
            awaiting_approval: 0,
            workflow_runs: [],
            can_approve: false,
            error: error instanceof Error ? error.message : "Unknown error",
          };
        }
      });

      return result ?? { awaiting_approval: 0, workflow_runs: [], can_approve: false };
    }
  );

  // Approve a workflow run
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_WORKFLOW_APPROVE,
    async (_, projectId: string, runId: number): Promise<boolean> => {
      debugLog("approveWorkflow handler called", { projectId, runId });
      const result = await withProjectOrNull(projectId, async (project) => {
        const config = getGitHubConfig(project);
        if (!config) {
          debugLog("No GitHub config found");
          return false;
        }

        try {
          // Approve the workflow run
          await githubFetch(config.token, `/repos/${config.repo}/actions/runs/${runId}/approve`, {
            method: "POST",
          });

          debugLog("Workflow approved successfully", { runId });
          return true;
        } catch (error) {
          debugLog("Failed to approve workflow", {
            runId,
            error: error instanceof Error ? error.message : error,
          });
          return false;
        }
      });

      return result ?? false;
    }
  );

  // ============================================================================
  // PR Status Polling Handlers
  // ============================================================================

  // Initialize PRStatusPoller with main window getter for IPC updates
  const prStatusPoller = getPRStatusPoller();
  prStatusPoller.setMainWindowGetter(getMainWindow);

  // Start polling PR status for a project
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_STATUS_POLL_START,
    async (
      _,
      request: StartPollingRequest
    ): Promise<{ success: boolean; error?: string }> => {
      debugLog("startStatusPolling handler called", {
        projectId: request.projectId,
        prCount: request.prNumbers.length,
      });

      const result = await withProjectOrNull(request.projectId, async (project) => {
        const config = getGitHubConfig(project);
        if (!config) {
          debugLog("No GitHub config found for project, cannot start polling");
          return { success: false, error: "No GitHub configuration found" };
        }

        try {
          await prStatusPoller.startPolling(
            request.projectId,
            request.prNumbers,
            config.token
          );
          debugLog("Status polling started successfully", {
            projectId: request.projectId,
          });
          return { success: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          debugLog("Failed to start status polling", {
            projectId: request.projectId,
            error: message,
          });
          return { success: false, error: message };
        }
      });
      return result ?? { success: false, error: "Project not found" };
    }
  );

  // Stop polling PR status for a project
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_STATUS_POLL_STOP,
    async (
      _,
      request: StopPollingRequest
    ): Promise<{ success: boolean }> => {
      debugLog("stopStatusPolling handler called", {
        projectId: request.projectId,
      });

      try {
        prStatusPoller.stopPolling(request.projectId);
        debugLog("Status polling stopped successfully", {
          projectId: request.projectId,
        });
        return { success: true };
      } catch (error) {
        debugLog("Failed to stop status polling", {
          projectId: request.projectId,
          error: error instanceof Error ? error.message : error,
        });
        return { success: false };
      }
    }
  );

  // Get current polling metadata for a project
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_STATUS_UPDATE,
    async (_, projectId: string): Promise<PollingMetadata> => {
      debugLog("getPollingMetadata handler called", { projectId });
      return prStatusPoller.getPollingMetadata(projectId);
    }
  );

  debugLog("PR handlers registered");
}
