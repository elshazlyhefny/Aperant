import path from 'path';
import { existsSync, readFileSync } from 'fs';
import type { Project } from '../../../shared/types';
import { parseEnvFile } from '../utils';
import { isValidProjectKey, normalizeJiraSiteUrl } from './jira-client';

export interface JiraConfig {
  siteUrl: string;
  email: string;
  token: string;
  projectKey?: string;
}

/**
 * Read Jira credentials from the project's .env. Returns null when not configured.
 */
export function getJiraConfig(project: Project): JiraConfig | null {
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
