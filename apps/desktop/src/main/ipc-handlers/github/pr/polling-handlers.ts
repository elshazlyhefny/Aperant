/**
 * PR polling IPC handlers: status polling and workflow approval.
 */

import { ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import { getGitHubConfig, githubFetch } from "../utils";
import { withProjectOrNull } from "../utils/project-middleware";
import { getPRStatusPoller } from "../../../services/pr-status-poller";
import type {
  StartPollingRequest,
  StopPollingRequest,
  PollingMetadata,
} from "../../../../shared/types/pr-status";
import { debugLog } from "./shared";

/**
 * Register PR polling and workflow approval handlers
 */
export function registerPRPollingHandlers(getMainWindow: () => BrowserWindow | null): void {
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
}
