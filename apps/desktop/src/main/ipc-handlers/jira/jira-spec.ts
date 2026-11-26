/**
 * Creates task specs from Jira issues. Does not start the agent.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import path from 'path';
import { AUTO_BUILD_PATHS } from '../../../shared/constants';
import type { TaskMetadata } from '../../../shared/types';
import { sanitizeText, sanitizeUrl, sanitizeStringArray } from '../shared/sanitize';
import { allocateSpecDir } from '../../utils/spec-number-lock';
import { applyDefaultTaskAgent } from '../../utils/default-task-agent';
import { readSettingsFile } from '../../settings-utils';
import { normalizeJiraSiteUrl, isValidIssueKey } from './jira-client';
import type { JiraIssueData } from './jira-client';

export interface JiraSpecResult {
  specId: string;
  specDir: string;
  description: string;
  metadata: TaskMetadata;
}

/**
 * Map of Jira issue key -> spec id for specs already imported from this site.
 * Scans every spec dir (archived specs live in the same dir with archivedAt metadata).
 */
export function findExistingJiraSpecs(specsDir: string, siteUrl: string): Map<string, string> {
  const result = new Map<string, string>();
  const site = normalizeJiraSiteUrl(siteUrl);
  if (!site || !existsSync(specsDir)) return result;

  let entries: string[];
  try {
    entries = readdirSync(specsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  } catch {
    return result;
  }

  for (const name of entries) {
    try {
      const raw = readFileSync(path.join(specsDir, name, 'task_metadata.json'), 'utf-8');
      const meta = JSON.parse(raw) as Partial<TaskMetadata> | null;
      if (!meta || typeof meta !== 'object') continue;
      if (meta.sourceType !== 'jira') continue;
      if (typeof meta.jiraIssueKey !== 'string' || typeof meta.jiraSiteUrl !== 'string') continue;
      if (normalizeJiraSiteUrl(meta.jiraSiteUrl) !== site) continue;
      if (!result.has(meta.jiraIssueKey)) result.set(meta.jiraIssueKey, name);
    } catch {
      // Unreadable or malformed metadata: ignore this spec
    }
  }
  return result;
}

export async function createSpecFromJiraIssue(
  project: { path: string; autoBuildPath?: string },
  siteUrl: string,
  issue: JiraIssueData
): Promise<JiraSpecResult> {
  const site = normalizeJiraSiteUrl(siteUrl);
  if (!site) throw new Error('Invalid Jira site URL');
  const key = sanitizeText(issue.key, 50);
  if (!isValidIssueKey(key)) throw new Error('Invalid Jira issue key');

  const title = sanitizeText(issue.summary, 500) || key;
  const issueId = sanitizeText(issue.id, 100);
  const issueType = sanitizeText(issue.issueType, 100);
  const priority = sanitizeText(issue.priorityName, 100);
  const status = sanitizeText(issue.statusName, 100);
  const labels = sanitizeStringArray(issue.labels, 50, 200);
  const body = sanitizeText(issue.description, 50000, true);
  const jiraUrl = sanitizeUrl(`${site}/browse/${key}`);

  const lines = [`# ${title}`, '', `**Jira Issue:** [${key}](${jiraUrl})`];
  if (issueType) lines.push(`**Type:** ${issueType}`);
  if (priority) lines.push(`**Priority:** ${priority}`);
  if (status) lines.push(`**Status:** ${status}`);
  if (labels.length > 0) lines.push(`**Labels:** ${labels.join(', ')}`);
  lines.push('', '## Description', '', body || 'No description provided.', '');
  const description = lines.join('\n');

  const { specId, specDir } = await allocateSpecDir(project, title);

  const now = new Date().toISOString();
  const category = issueType.toLowerCase() === 'bug' ? 'bug_fix' : 'feature';

  writeFileSync(
    path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN),
    JSON.stringify({ feature: title, description, created_at: now, updated_at: now, status: 'pending', phases: [] }, null, 2),
    'utf-8'
  );
  writeFileSync(
    path.join(specDir, AUTO_BUILD_PATHS.REQUIREMENTS),
    JSON.stringify({ task_description: description, workflow_type: 'feature' }, null, 2),
    'utf-8'
  );

  // zeenha fork: tasks created here get the Settings default task agent, like tasks created by hand.
  const metadata: TaskMetadata = applyDefaultTaskAgent({
    sourceType: 'jira',
    jiraIssueKey: key,
    jiraIssueId: issueId,
    jiraSiteUrl: site,
    jiraUrl,
    category,
  }, readSettingsFile());
  writeFileSync(path.join(specDir, 'task_metadata.json'), JSON.stringify(metadata, null, 2), 'utf-8');

  return { specId, specDir, description, metadata };
}
