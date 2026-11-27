/**
 * Creates task specs from Azure Boards work items. Does not start the agent.
 *
 * zeenha fork: modeled on jira/jira-spec.ts. Only organization and project are read
 * from the config; the PAT is never written to disk.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import path from 'path';
import { AUTO_BUILD_PATHS, getSpecsDir } from '../../../shared/constants';
import type { TaskMetadata } from '../../../shared/types';
import { sanitizeText, sanitizeUrl, sanitizeStringArray } from '../shared/sanitize';
import { withSpecNumberLock } from '../../utils/spec-number-lock';
import { buildSpecId } from '../../utils/spec-slug';
import { applyDefaultTaskAgent } from '../../utils/default-task-agent';
import { readSettingsFile } from '../../settings-utils';
import { htmlToMarkdown, type AzureBoardsWorkItemData } from './boards-client';
import type { AzureDevOpsConfig } from './types';

export type BoardsSpecResult =
  | { kind: 'existing'; specId: string }
  | { kind: 'created'; specId: string; specDir: string; description: string; metadata: TaskMetadata };

type SpecConfig = Pick<AzureDevOpsConfig, 'organization' | 'project'>;

/**
 * Map of work item id -> spec id for specs already imported from this organization/project.
 * Scans every spec dir (archived specs live in the same dir with archivedAt metadata).
 */
export function findExistingBoardsSpecs(
  specsDir: string,
  organization: string,
  project: string
): Map<number, string> {
  const result = new Map<number, string>();
  const org = organization.trim().toLowerCase();
  const proj = project.trim().toLowerCase();
  if (!org || !proj || !existsSync(specsDir)) return result;

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
      if (meta.sourceType !== 'azure_boards') continue;
      if (typeof meta.azureBoardsWorkItemId !== 'number' || !Number.isFinite(meta.azureBoardsWorkItemId)) continue;
      if (typeof meta.azureBoardsOrganization !== 'string' || typeof meta.azureBoardsProject !== 'string') continue;
      if (meta.azureBoardsOrganization.trim().toLowerCase() !== org) continue;
      if (meta.azureBoardsProject.trim().toLowerCase() !== proj) continue;
      if (!result.has(meta.azureBoardsWorkItemId)) result.set(meta.azureBoardsWorkItemId, name);
    } catch {
      // Unreadable or malformed metadata: ignore this spec
    }
  }
  return result;
}

function prepareWorkItem(item: AzureBoardsWorkItemData) {
  const id = item.id;
  const title = sanitizeText(item.title, 500) || `AB#${id}`;
  const workItemType = sanitizeText(item.workItemType, 100);
  const state = sanitizeText(item.state, 100);
  const areaPath = sanitizeText(item.areaPath, 500);
  const tags = sanitizeStringArray(item.tags, 50, 200);
  const isBug = workItemType.toLowerCase() === 'bug';
  const itemUrl = sanitizeUrl(item.url);

  let body = sanitizeText(htmlToMarkdown(item.description), 50000, true);
  if (!body && isBug) body = sanitizeText(htmlToMarkdown(item.reproSteps), 50000, true);
  const acceptance = sanitizeText(htmlToMarkdown(item.acceptanceCriteria), 50000, true);

  const lines = [`# ${title}`, '', `**Azure Boards Work Item:** [AB#${id}](${itemUrl})`];
  if (workItemType) lines.push(`**Type:** ${workItemType}`);
  if (state) lines.push(`**State:** ${state}`);
  if (areaPath) lines.push(`**Area Path:** ${areaPath}`);
  if (tags.length > 0) lines.push(`**Tags:** ${tags.join(', ')}`);
  if (body) lines.push('', '## Description', '', body);
  if (acceptance) lines.push('', '## Acceptance Criteria', '', acceptance);
  lines.push('');
  return { title, description: lines.join('\n'), isBug, itemUrl };
}

export async function createSpecFromWorkItem(
  project: { path: string; autoBuildPath?: string },
  config: SpecConfig,
  id: number,
  item: AzureBoardsWorkItemData | undefined,
  allowDuplicates = false
): Promise<BoardsSpecResult> {
  const organization = sanitizeText(config.organization, 200);
  const azureProject = sanitizeText(config.project, 200);
  if (!organization || !azureProject) throw new Error('Invalid Azure DevOps organization or project');
  if (!Number.isSafeInteger(id) || id <= 0 || (item && item.id !== id)) throw new Error('Invalid work item id');

  const prepared = item ? prepareWorkItem(item) : undefined;
  const specsDir = path.join(project.path, getSpecsDir(project.autoBuildPath));

  return withSpecNumberLock<BoardsSpecResult>(project.path, lock => {
    if (allowDuplicates !== true) {
      const existingSpecId = findExistingBoardsSpecs(specsDir, organization, azureProject).get(id);
      if (existingSpecId) return { kind: 'existing', specId: existingSpecId };
    }
    if (!prepared) throw new Error('work item not found in Azure DevOps');

    const { title, description, isBug, itemUrl } = prepared;
    const specNumber = lock.getNextSpecNumber(project.autoBuildPath);
    const specId = buildSpecId(specNumber, title);
    const specDir = path.join(specsDir, specId);
    mkdirSync(specDir, { recursive: true });

    const now = new Date().toISOString();

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
      sourceType: 'azure_boards',
      azureBoardsWorkItemId: id,
      azureBoardsUrl: itemUrl,
      azureBoardsOrganization: organization,
      azureBoardsProject: azureProject,
      category: isBug ? 'bug_fix' : 'feature',
    }, readSettingsFile());
    // Publish the identity last, before another import can acquire the lock.
    writeFileSync(path.join(specDir, 'task_metadata.json'), JSON.stringify(metadata, null, 2), 'utf-8');

    return { kind: 'created', specId, specDir, description, metadata };
  });
}
