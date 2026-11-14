/**
 * IPC Handlers Module Index
 *
 * This module exports a single setup function that registers all IPC handlers
 * organized by domain into separate handler modules.
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { installIpcSenderGuard } from '../ipc-sender-validation';
import { AgentManager } from '../agent';
import { TerminalManager } from '../terminal-manager';

// Import all handler registration functions
import { registerProjectHandlers } from './project-handlers';
import { registerTaskHandlers } from './task-handlers';
import { registerTerminalHandlers } from './terminal-handlers';
import { registerAgenteventsHandlers } from './agent-events-handlers';
import { registerSettingsHandlers } from './settings-handlers';
import { registerProviderAccountHandlers } from './provider-account-handlers';
import { registerFileHandlers } from './file-handlers';
import { registerRoadmapHandlers } from './roadmap-handlers';
import { registerContextHandlers } from './context-handlers';
import { registerEnvHandlers } from './env-handlers';
import { registerLinearHandlers } from './linear-handlers';
import { registerJiraHandlers } from './jira/jira-handlers';
import { registerGithubHandlers } from './github-handlers';
import { registerGitlabHandlers } from './gitlab-handlers';
import { registerBitbucketHandlers } from './bitbucket-handlers';
import { registerAzureDevOpsHandlers } from './azuredevops-handlers';
import { registerIdeationHandlers } from './ideation-handlers';
import { registerChangelogHandlers } from './changelog-handlers';
import { registerInsightsHandlers } from './insights-handlers';
import { registerMemoryHandlers } from './memory-handlers';
import { registerAppUpdateHandlers } from './app-update-handlers';
import { registerDebugHandlers } from './debug-handlers';
import { registerClaudeCodeHandlers } from './claude-code-handlers';
import { registerSandboxHandlers } from './sandbox-handlers';
import { registerMcpHandlers } from './mcp-handlers';
import { registerProfileHandlers } from './profile-handlers';
import { registerScreenshotHandlers } from './screenshot-handlers';
import { registerTerminalWorktreeIpcHandlers } from './terminal';
import { registerCodexAuthHandlers } from './codex-auth-handlers';
import { registerScheduleHandlers } from './schedule-handlers';
import type { ScheduleService } from '../schedule-service';
import { notificationService } from '../notification-service';
import { setAgentManagerRef, safeSendToRenderer } from './utils';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult, TaskQueueState } from '../../shared/types';
import { projectStore } from '../project-store';
import { taskStateManager } from '../task-state-manager';
import { taskQueueManager } from '../task-queue-manager';
import { applyTaskStatusUpdate } from './task/execution-handlers';

/**
 * Setup all IPC handlers across all domains
 *
 * @param agentManager - The agent manager instance
 * @param terminalManager - The terminal manager instance
 * @param getMainWindow - Function to get the main BrowserWindow
 */
export function setupIpcHandlers(
  agentManager: AgentManager,
  terminalManager: TerminalManager,
  getMainWindow: () => BrowserWindow | null
): ScheduleService {
  // Every channel registered through ipcMain is now checked for a trusted sender
  // before dispatch, so new handlers are guarded by default. The per-handler
  // assertTrustedSender calls in terminal/file/settings handlers stay as belt-and-braces.
  installIpcSenderGuard(ipcMain);

  // Initialize notification service
  notificationService.initialize(getMainWindow);

  // Wire up agent manager for circuit breaker cleanup
  setAgentManagerRef(agentManager);

  // zeenha fork: the task queue runs in main so queued tasks start whichever view
  // (or no window) is open, instead of depending on a renderer component.
  taskQueueManager.configure({
    getProjects: () => projectStore.getProjects(),
    getTasks: (projectId) => projectStore.getTasks(projectId),
    promote: (taskId) => applyTaskStatusUpdate(agentManager, getMainWindow, taskId, 'in_progress'),
    emitState: (_projectId, state) =>
      safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_QUEUE_STATE_CHANGE, state)
  });
  taskStateManager.onStatusEmitted((taskId, status, projectId) => {
    void taskQueueManager.onTaskStatusChanged(taskId, status, projectId);
  });
  ipcMain.handle(
    IPC_CHANNELS.TASK_QUEUE_GET_STATE,
    async (_, projectId: string): Promise<IPCResult<TaskQueueState>> => {
      try {
        return { success: true, data: taskQueueManager.getState(projectId) };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  // Project handlers
  registerProjectHandlers(getMainWindow);

  // Task handlers
  registerTaskHandlers(agentManager, getMainWindow);

  // Terminal and Claude profile handlers
  registerTerminalHandlers(terminalManager, getMainWindow);

  // Terminal worktree handlers (isolated development in worktrees)
  registerTerminalWorktreeIpcHandlers();

  // Agent event handlers (event forwarding from agent manager to renderer)
  registerAgenteventsHandlers(agentManager, getMainWindow);

  // Settings and dialog handlers
  registerSettingsHandlers(agentManager, getMainWindow);
  registerProviderAccountHandlers();

  // File explorer handlers
  registerFileHandlers();

  // Roadmap handlers
  registerRoadmapHandlers(agentManager, getMainWindow);

  // Context and memory handlers
  registerContextHandlers(getMainWindow);

  // Environment configuration handlers
  registerEnvHandlers(getMainWindow);

  // Linear integration handlers
  registerLinearHandlers(agentManager, getMainWindow);

  // Jira integration handlers
  registerJiraHandlers(agentManager, getMainWindow);

  // GitHub integration handlers
  registerGithubHandlers(agentManager, getMainWindow);

  // GitLab integration handlers
  registerGitlabHandlers(agentManager, getMainWindow);

  // Bitbucket integration handlers
  registerBitbucketHandlers(getMainWindow);

  // Azure DevOps integration handlers
  registerAzureDevOpsHandlers();

  // Ideation handlers
  registerIdeationHandlers(agentManager, getMainWindow);

  // Changelog handlers
  registerChangelogHandlers(getMainWindow);

  // Insights handlers
  registerInsightsHandlers(getMainWindow);

  // Memory & infrastructure handlers (for LadybugDB)
  registerMemoryHandlers();

  // App auto-update handlers
  registerAppUpdateHandlers();

  // Debug handlers (logs, debug info, etc.)
  registerDebugHandlers();

  // Claude Code CLI handlers (version checking, installation)
  registerClaudeCodeHandlers();

  // Bash sandbox availability
  registerSandboxHandlers();

  // MCP server health check handlers
  registerMcpHandlers();

  // API Profile handlers (custom Anthropic-compatible endpoints)
  registerProfileHandlers();

  // Screenshot capture handlers
  registerScreenshotHandlers();

  // Codex OAuth authentication handlers
  registerCodexAuthHandlers();

  // zeenha fork: recurring task schedules; the caller starts the returned service
  const scheduleService = registerScheduleHandlers(agentManager, getMainWindow);

  console.warn('[IPC] All handler modules registered successfully');
  return scheduleService;
}

// Re-export all individual registration functions for potential custom usage
export {
  registerProjectHandlers,
  registerTaskHandlers,
  registerTerminalHandlers,
  registerTerminalWorktreeIpcHandlers,
  registerAgenteventsHandlers,
  registerSettingsHandlers,
  registerProviderAccountHandlers,
  registerFileHandlers,
  registerRoadmapHandlers,
  registerContextHandlers,
  registerEnvHandlers,
  registerLinearHandlers,
  registerJiraHandlers,
  registerGithubHandlers,
  registerGitlabHandlers,
  registerBitbucketHandlers,
  registerAzureDevOpsHandlers,
  registerIdeationHandlers,
  registerChangelogHandlers,
  registerInsightsHandlers,
  registerMemoryHandlers,
  registerAppUpdateHandlers,
  registerDebugHandlers,
  registerClaudeCodeHandlers,
  registerSandboxHandlers,
  registerMcpHandlers,
  registerProfileHandlers,
  registerScreenshotHandlers,
  registerCodexAuthHandlers,
  registerScheduleHandlers
};
