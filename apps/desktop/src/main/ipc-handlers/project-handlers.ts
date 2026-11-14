import { ipcMain } from 'electron';
import { existsSync } from 'fs';
import { IPC_CHANNELS } from '../../shared/constants';
import type {
  Project,
  ProjectSettings,
  IPCResult,
  InitializationResult,
  AutoBuildVersionInfo,
  GitStatus,
  GitBranchDetail
} from '../../shared/types';
import { projectStore } from '../project-store';
import { taskQueueManager } from '../task-queue-manager';
import { ensureQueueLock } from '../desktop-queue-lock';
import {
  initializeProject,
  isInitialized,
  checkGitStatus,
  initializeGit
} from '../project-initializer';
import {
  getGitBranches,
  getGitBranchesWithInfo,
  getCurrentGitBranch,
  getDefaultRemoteBranchRef,
  scheduleBackgroundFetch
} from './git-branches';
import { readProjectRepoConfig } from '../ai/worktree/project-repo-config';
import type { BrowserWindow } from 'electron';

import { appLog } from '../app-logger';
// ============================================
// Git Helper Functions
// ============================================

/**
 * Tell the renderer that a background fetch finished and branch lists may be stale.
 */
function makeBranchesUpdatedNotifier(getMainWindow: () => BrowserWindow | null) {
  return (projectPath: string): void => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.GIT_BRANCHES_UPDATED, projectPath);
    }
  };
}

/**
 * Detect the main branch for a git repository
 * Checks for common main branch names in order of preference
 */
async function detectMainBranch(projectPath: string): Promise<string | null> {
  const branches = await getGitBranches(projectPath);
  if (branches.length === 0) return null;

  // zeenha fork: a repository that names its base branch is not guessed at.
  const declared = readProjectRepoConfig(projectPath).baseBranch;
  if (declared && (branches.includes(declared) || branches.includes(`origin/${declared}`))) {
    return declared;
  }

  // Check for common main branch names in order of preference
  const mainBranchCandidates = ['main', 'master', 'develop', 'dev', 'trunk'];
  for (const candidate of mainBranchCandidates) {
    if (branches.includes(candidate)) {
      return candidate;
    }
  }

  // If none of the common names found, check for origin/HEAD reference
  const ref = await getDefaultRemoteBranchRef(projectPath);
  // Extract branch name from refs/remotes/origin/main
  const match = ref?.match(/refs\/remotes\/origin\/(.+)/);
  if (match && branches.includes(match[1])) {
    return match[1];
  }

  // Fallback: return the first branch (usually the current one)
  return branches[0] || null;
}

/**
 * Register all project-related IPC handlers
 */
export function registerProjectHandlers(
  getMainWindow: () => BrowserWindow | null
): void {
  const notifyBranchesUpdated = makeBranchesUpdatedNotifier(getMainWindow);

  // ============================================
  // Project Operations
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_ADD,
    async (_, projectPath: string): Promise<IPCResult<Project>> => {
      try {
        // Validate path exists
        if (!existsSync(projectPath)) {
          return { success: false, error: 'Directory does not exist' };
        }

        const project = projectStore.addProject(projectPath);
        // zeenha fork: take the queue lock as soon as the project is known
        ensureQueueLock(project);
        return { success: true, data: project };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_REMOVE,
    async (_, projectId: string): Promise<IPCResult> => {
      const success = projectStore.removeProject(projectId);
      return { success };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_LIST,
    async (): Promise<IPCResult<Project[]>> => {
      // Validate that .auto-claude folders still exist for all projects
      // If a folder was deleted, reset autoBuildPath so UI prompts for reinitialization
      const resetIds = projectStore.validateProjects();
      if (resetIds.length > 0) {
        console.warn('[IPC] PROJECT_LIST: Detected missing .auto-claude folders for', resetIds.length, 'project(s)');
      }

      const projects = projectStore.getProjects();
      console.warn('[IPC] PROJECT_LIST returning', projects.length, 'projects');
      return { success: true, data: projects };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_UPDATE_SETTINGS,
    async (
      _,
      projectId: string,
      settings: Partial<ProjectSettings>
    ): Promise<IPCResult> => {
      const project = projectStore.updateProjectSettings(projectId, settings);
      if (project) {
        // zeenha fork: raising the parallel limit should start queued tasks right away
        if (settings.maxParallelTasks !== undefined) {
          void taskQueueManager.requestProcess(projectId);
        }
        return { success: true };
      }
      return { success: false, error: 'Project not found' };
    }
  );

  // ============================================
  // Tab State Operations (persisted in main process)
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.TAB_STATE_GET,
    async (): Promise<IPCResult<{ openProjectIds: string[]; activeProjectId: string | null; tabOrder: string[] }>> => {
      const tabState = projectStore.getTabState();
      return { success: true, data: tabState };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TAB_STATE_SAVE,
    async (
      _,
      tabState: { openProjectIds: string[]; activeProjectId: string | null; tabOrder: string[] }
    ): Promise<IPCResult> => {
      appLog.debug('[IPC] TAB_STATE_SAVE called with:', tabState);
      projectStore.saveTabState(tabState);
      return { success: true };
    }
  );

  // ============================================
  // Kanban Preferences Operations (persisted in main process)
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.KANBAN_PREFS_GET,
    async (_, projectId: string): Promise<IPCResult<Record<string, { width: number; isCollapsed: boolean; isLocked: boolean }> | null>> => {
      try {
        const preferences = projectStore.getKanbanPreferences(projectId);
        return { success: true, data: preferences };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.KANBAN_PREFS_SAVE,
    async (
      _,
      projectId: string,
      preferences: Record<string, { width: number; isCollapsed: boolean; isLocked: boolean }>
    ): Promise<IPCResult> => {
      try {
        projectStore.saveKanbanPreferences(projectId, preferences);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );

  // ============================================
  // Project Initialization Operations
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_INITIALIZE,
    async (_, projectId: string): Promise<IPCResult<InitializationResult>> => {
      try {
        const project = projectStore.getProject(projectId);
        if (!project) {
          return { success: false, error: 'Project not found' };
        }

        const result = initializeProject(project.path);

        if (result.success) {
          // Update project's autoBuildPath
          projectStore.updateAutoBuildPath(projectId, '.auto-claude');
        }

        return { success: result.success, data: result, error: result.error };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );

  // PROJECT_CHECK_VERSION now just checks if project is initialized
  // Version tracking for .auto-claude is removed since it only contains data
  ipcMain.handle(
    IPC_CHANNELS.PROJECT_CHECK_VERSION,
    async (_, projectId: string): Promise<IPCResult<AutoBuildVersionInfo>> => {
      try {
        const project = projectStore.getProject(projectId);
        if (!project) {
          return { success: false, error: 'Project not found' };
        }

        return {
          success: true,
          data: {
            isInitialized: isInitialized(project.path),
            updateAvailable: false // No updates for .auto-claude - it's just data
          }
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );

  // ============================================
  // Git Operations
  // ============================================

  // Get all branches for a project (legacy - returns string[])
  ipcMain.handle(
    IPC_CHANNELS.GIT_GET_BRANCHES,
    async (_, projectPath: string): Promise<IPCResult<string[]>> => {
      try {
        if (!existsSync(projectPath)) {
          return { success: false, error: 'Directory does not exist' };
        }
        const branches = await getGitBranches(projectPath);
        scheduleBackgroundFetch(projectPath, notifyBranchesUpdated);
        return { success: true, data: branches };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );

  // Get all branches with structured type information (local vs remote)
  ipcMain.handle(
    IPC_CHANNELS.GIT_GET_BRANCHES_WITH_INFO,
    async (_, projectPath: string): Promise<IPCResult<GitBranchDetail[]>> => {
      try {
        if (!existsSync(projectPath)) {
          return { success: false, error: 'Directory does not exist' };
        }
        const branches = await getGitBranchesWithInfo(projectPath);
        scheduleBackgroundFetch(projectPath, notifyBranchesUpdated);
        return { success: true, data: branches };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );

  // Get current branch for a project
  ipcMain.handle(
    IPC_CHANNELS.GIT_GET_CURRENT_BRANCH,
    async (_, projectPath: string): Promise<IPCResult<string | null>> => {
      try {
        if (!existsSync(projectPath)) {
          return { success: false, error: 'Directory does not exist' };
        }
        const branch = await getCurrentGitBranch(projectPath);
        return { success: true, data: branch };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );

  // Auto-detect main branch for a project
  ipcMain.handle(
    IPC_CHANNELS.GIT_DETECT_MAIN_BRANCH,
    async (_, projectPath: string, options?: { declaredOnly?: boolean }): Promise<IPCResult<string | null>> => {
      try {
        if (!existsSync(projectPath)) {
          return { success: false, error: 'Directory does not exist' };
        }
        if (options?.declaredOnly) {
          return { success: true, data: readProjectRepoConfig(projectPath).baseBranch ?? null };
        }
        const mainBranch = await detectMainBranch(projectPath);
        return { success: true, data: mainBranch };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );

  // Check git status for a project (is it a repo? has commits?)
  ipcMain.handle(
    IPC_CHANNELS.GIT_CHECK_STATUS,
    async (_, projectPath: string): Promise<IPCResult<GitStatus>> => {
      try {
        if (!existsSync(projectPath)) {
          return { success: false, error: 'Directory does not exist' };
        }
        const gitStatus = checkGitStatus(projectPath);
        return { success: true, data: gitStatus };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );

  // Initialize git in a project (run git init and create initial commit)
  ipcMain.handle(
    IPC_CHANNELS.GIT_INITIALIZE,
    async (_, projectPath: string): Promise<IPCResult<InitializationResult>> => {
      try {
        if (!existsSync(projectPath)) {
          return { success: false, error: 'Directory does not exist' };
        }
        const result = initializeGit(projectPath);
        return { success: result.success, data: result, error: result.error };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );
}
