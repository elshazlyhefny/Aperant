import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { IPC_CHANNELS, getSpecsDir } from '../../../shared/constants';
import type {
  IPCResult,
  JiraImportResult,
  JiraIssuePage,
  JiraProject,
  JiraSyncStatus,
  Project,
} from '../../../shared/types';
import { projectStore } from '../../project-store';
import { parseEnvFile } from '../utils';
import type { AgentManager } from '../../agent';
import {
  JiraAPIError,
  checkConnection,
  getIssuesByKeys,
  isValidIssueKey,
  isValidProjectKey,
  listProjects,
  normalizeJiraSiteUrl,
  searchIssues,
} from './jira-client';
import type { JiraIssueData } from './jira-client';
import { createSpecFromJiraIssue, findExistingJiraSpecs } from './jira-spec';

interface JiraConfig {
  siteUrl: string;
  email: string;
  token: string;
  projectKey?: string;
}

const MAX_IMPORT_KEYS = 100;

/**
 * Read Jira credentials from the project's .env. Returns null when not configured.
 */
function getJiraConfig(project: Project): JiraConfig | null {
  if (!project.autoBuildPath) return null;
  const envPath = path.join(project.path, project.autoBuildPath, '.env');
  if (!existsSync(envPath)) return null;

  try {
    const vars = parseEnvFile(readFileSync(envPath, 'utf-8'));
    const siteUrl = normalizeJiraSiteUrl(vars['JIRA_SITE_URL']);
    const email = vars['JIRA_EMAIL'];
    const token = vars['JIRA_API_TOKEN'];
    if (!siteUrl || !email || !token) return null;
    const projectKey = vars['JIRA_PROJECT_KEY'];
    return { siteUrl, email, token, projectKey: isValidProjectKey(projectKey) ? projectKey : undefined };
  } catch {
    return null;
  }
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof JiraAPIError) return error.message;
  return error instanceof Error ? error.message : fallback;
}

/**
 * Register all Jira-related IPC handlers
 */
export function registerJiraHandlers(
  agentManager: AgentManager,
  _getMainWindow: () => BrowserWindow | null
): void {
  ipcMain.handle(
    IPC_CHANNELS.JIRA_CHECK_CONNECTION,
    async (_, projectId: string): Promise<IPCResult<JiraSyncStatus>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };

      const config = getJiraConfig(project);
      if (!config) {
        return { success: true, data: { connected: false, error: 'Jira is not configured' } };
      }

      try {
        const info = await checkConnection(config.siteUrl, config.email, config.token);
        return {
          success: true,
          data: {
            connected: true,
            siteName: info.siteName,
            userName: info.userName,
            projectName: config.projectKey,
          },
        };
      } catch (error) {
        return {
          success: true,
          data: { connected: false, error: errorMessage(error, 'Failed to connect to Jira') },
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.JIRA_GET_PROJECTS,
    async (_, projectId: string): Promise<IPCResult<JiraProject[]>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };

      const config = getJiraConfig(project);
      if (!config) return { success: false, error: 'Jira is not configured' };

      try {
        return { success: true, data: await listProjects(config.siteUrl, config.email, config.token) };
      } catch (error) {
        return { success: false, error: errorMessage(error, 'Failed to fetch Jira projects') };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.JIRA_GET_ISSUES,
    async (
      _,
      projectId: string,
      opts?: { projectKey?: string; searchText?: string; nextPageToken?: string }
    ): Promise<IPCResult<JiraIssuePage>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };

      const config = getJiraConfig(project);
      if (!config) return { success: false, error: 'Jira is not configured' };

      const projectKey = opts?.projectKey || config.projectKey;
      if (!isValidProjectKey(projectKey)) {
        return { success: false, error: 'A valid Jira project key is required' };
      }

      try {
        const page = await searchIssues(config.siteUrl, config.email, config.token, {
          projectKey,
          searchText: typeof opts?.searchText === 'string' ? opts.searchText : undefined,
          nextPageToken: typeof opts?.nextPageToken === 'string' ? opts.nextPageToken : undefined,
        });
        const specsDir = path.join(project.path, getSpecsDir(project.autoBuildPath));
        const existing = findExistingJiraSpecs(specsDir, config.siteUrl);
        return {
          success: true,
          data: {
            issues: page.issues.map(issue => ({
              ...issue,
              alreadyImported: existing.has(issue.key),
              existingSpecId: existing.get(issue.key),
            })),
            nextPageToken: page.nextPageToken,
            isLast: page.isLast,
          },
        };
      } catch (error) {
        return { success: false, error: errorMessage(error, 'Failed to fetch Jira issues') };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.JIRA_IMPORT_ISSUES,
    async (
      _,
      projectId: string,
      issueKeys: string[],
      allowDuplicates = false
    ): Promise<IPCResult<JiraImportResult>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };

      const config = getJiraConfig(project);
      if (!config) return { success: false, error: 'Jira is not configured' };

      if (!Array.isArray(issueKeys) || issueKeys.length === 0) {
        return { success: false, error: 'No issues selected' };
      }
      if (issueKeys.length > MAX_IMPORT_KEYS) {
        return { success: false, error: `Too many issues selected (max ${MAX_IMPORT_KEYS})` };
      }
      if (!issueKeys.every(isValidIssueKey)) {
        return { success: false, error: 'Invalid Jira issue key' };
      }

      try {
        const keys = [...new Set(issueKeys)];

        // Group keys by project key (the prefix before the final "-<number>")
        const byProject = new Map<string, string[]>();
        for (const key of keys) {
          const prefix = key.slice(0, key.lastIndexOf('-'));
          byProject.set(prefix, [...(byProject.get(prefix) ?? []), key]);
        }

        // Always refetch from Jira; renderer-supplied content is never trusted
        const fetched = new Map<string, JiraIssueData>();
        for (const [prefix, projectKeys] of byProject) {
          const issues = await getIssuesByKeys(config.siteUrl, config.email, config.token, prefix, projectKeys);
          for (const issue of issues) fetched.set(issue.key, issue);
        }

        const specsDir = path.join(project.path, getSpecsDir(project.autoBuildPath));
        const existing = findExistingJiraSpecs(specsDir, config.siteUrl);

        let imported = 0;
        let failed = 0;
        const skipped: JiraImportResult['skipped'] = [];
        const errors: string[] = [];

        for (const key of keys) {
          const existingSpecId = existing.get(key);
          if (existingSpecId && !allowDuplicates) {
            skipped.push({ key, specId: existingSpecId });
            continue;
          }
          const issue = fetched.get(key);
          if (!issue) {
            failed++;
            errors.push(`Failed to import ${key}: issue not found in Jira`);
            continue;
          }
          try {
            const spec = createSpecFromJiraIssue(specsDir, config.siteUrl, issue);
            agentManager.startSpecCreation(spec.specId, project.path, spec.description, spec.specDir, spec.metadata);
            imported++;
          } catch (err) {
            failed++;
            errors.push(`Failed to import ${key}: ${err instanceof Error ? err.message : 'Unknown error'}`);
          }
        }

        return {
          success: true,
          data: {
            success: failed === 0,
            imported,
            failed,
            skipped,
            errors: errors.length > 0 ? errors : undefined,
          },
        };
      } catch (error) {
        return { success: false, error: errorMessage(error, 'Failed to import issues') };
      }
    }
  );
}
