/**
 * Azure Boards work item import handlers
 *
 * zeenha fork: modeled on jira/jira-handlers.ts. Work item content is always
 * refetched from Azure DevOps; renderer-supplied content is never trusted.
 */

import { ipcMain } from 'electron';
import path from 'path';
import { IPC_CHANNELS, getSpecsDir } from '../../../shared/constants';
import type {
  IPCResult,
  AzureBoardsFilter,
  AzureBoardsImportItemOutcome,
  AzureBoardsImportResult,
  AzureBoardsMetadata,
  AzureBoardsQueryRequest,
  AzureBoardsQueryResult,
  AzureBoardsSavedQuery
} from '../../../shared/types';
import { projectStore } from '../../project-store';
import type { AgentManager } from '../../agent';
import { createDebugLog } from '../../../shared/utils/debug-logger';
import { sanitizeText, sanitizeStringArray } from '../shared/sanitize';
import { AzureDevOpsAPIError, getAzureDevOpsConfig } from './utils';
import { getBoardsMetadata, getWorkItemsByIds, listSavedQueries, runWiql } from './boards-client';
import { createSpecFromWorkItem, findExistingBoardsSpecs } from './boards-spec';

const debugLog = createDebugLog('AzureBoards');

const NOT_CONFIGURED = 'Azure DevOps not configured';
const MAX_IMPORT_IDS = 100;
const MAX_FILTER_LIST = 50;
const MAX_FILTER_STRING = 200;
const MAX_AREA_PATH = 500;

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof AzureDevOpsAPIError) return error.message;
  return error instanceof Error ? error.message : fallback;
}

type RequestValidation = { ok: true; request: AzureBoardsQueryRequest } | { ok: false; error: string };

function validateQueryRequest(raw: unknown): RequestValidation {
  if (raw === undefined || raw === null) return { ok: true, request: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Invalid query request' };
  const input = raw as Record<string, unknown>;

  if (input.savedQueryId !== undefined) {
    if (typeof input.savedQueryId !== 'string') return { ok: false, error: 'Invalid saved query id' };
    return { ok: true, request: { savedQueryId: input.savedQueryId } };
  }

  const rawFilter = input.filter;
  if (rawFilter === undefined || rawFilter === null) return { ok: true, request: { filter: {} } };
  if (typeof rawFilter !== 'object' || Array.isArray(rawFilter)) return { ok: false, error: 'Invalid filter' };
  const f = rawFilter as Record<string, unknown>;

  const filter: AzureBoardsFilter = {};
  if (f.areaPath !== undefined) {
    if (typeof f.areaPath !== 'string') return { ok: false, error: 'Invalid filter' };
    const areaPath = sanitizeText(f.areaPath, MAX_AREA_PATH);
    if (areaPath) filter.areaPath = areaPath;
  }
  for (const key of ['states', 'workItemTypes'] as const) {
    const value = f[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) {
      return { ok: false, error: 'Invalid filter' };
    }
    const list = sanitizeStringArray(value, MAX_FILTER_LIST, MAX_FILTER_STRING);
    if (list.length > 0) filter[key] = list;
  }
  return { ok: true, request: { filter } };
}

/**
 * Register all Azure Boards IPC handlers
 */
export function registerAzureBoardsHandlers(agentManager: AgentManager): void {
  ipcMain.handle(
    IPC_CHANNELS.AZUREBOARDS_GET_SAVED_QUERIES,
    async (_event, projectId: string): Promise<IPCResult<AzureBoardsSavedQuery[]>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      const config = await getAzureDevOpsConfig(project);
      if (!config) return { success: false, error: NOT_CONFIGURED };

      try {
        return { success: true, data: await listSavedQueries(config) };
      } catch (error) {
        debugLog('Failed to list saved queries');
        return { success: false, error: errorMessage(error, 'Failed to fetch saved queries') };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AZUREBOARDS_GET_METADATA,
    async (_event, projectId: string): Promise<IPCResult<AzureBoardsMetadata>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      const config = await getAzureDevOpsConfig(project);
      if (!config) return { success: false, error: NOT_CONFIGURED };

      try {
        return { success: true, data: await getBoardsMetadata(config) };
      } catch (error) {
        debugLog('Failed to fetch metadata');
        return { success: false, error: errorMessage(error, 'Failed to fetch work item metadata') };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AZUREBOARDS_QUERY_WORK_ITEMS,
    async (_event, projectId: string, rawRequest?: unknown): Promise<IPCResult<AzureBoardsQueryResult>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      const config = await getAzureDevOpsConfig(project);
      if (!config) return { success: false, error: NOT_CONFIGURED };

      const validation = validateQueryRequest(rawRequest);
      if (!validation.ok) return { success: false, error: validation.error };

      try {
        const wiql = await runWiql(config, validation.request);
        const items = wiql.ids.length > 0 ? await getWorkItemsByIds(config, wiql.ids) : [];
        const specsDir = path.join(project.path, getSpecsDir(project.autoBuildPath));
        const existing = findExistingBoardsSpecs(specsDir, config.organization, config.project);
        return {
          success: true,
          data: {
            items: items.map(item => ({
              id: item.id,
              title: item.title,
              workItemType: item.workItemType,
              state: item.state,
              areaPath: item.areaPath,
              assignedTo: item.assignedTo,
              tags: item.tags,
              url: item.url,
              alreadyImported: existing.has(item.id),
              existingSpecId: existing.get(item.id)
            })),
            totalCount: wiql.ids.length,
            truncated: wiql.truncated
          }
        };
      } catch (error) {
        debugLog('Work item query failed');
        return { success: false, error: errorMessage(error, 'Failed to query work items') };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AZUREBOARDS_IMPORT_WORK_ITEMS,
    async (
      _event,
      projectId: string,
      workItemIds: unknown,
      allowDuplicates = false
    ): Promise<IPCResult<AzureBoardsImportResult>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      const config = await getAzureDevOpsConfig(project);
      if (!config) return { success: false, error: NOT_CONFIGURED };

      if (!Array.isArray(workItemIds) || workItemIds.length === 0) {
        return { success: false, error: 'No work items selected' };
      }
      if (workItemIds.length > MAX_IMPORT_IDS) {
        return { success: false, error: `Too many work items selected (max ${MAX_IMPORT_IDS})` };
      }
      if (!workItemIds.every(id => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)) {
        return { success: false, error: 'Invalid work item id' };
      }

      try {
        const ids = [...new Set(workItemIds as number[])];

        // Always refetch from Azure; renderer-supplied content is never trusted
        const fetched = new Map((await getWorkItemsByIds(config, ids)).map(item => [item.id, item]));

        let imported = 0;
        let failed = 0;
        const skipped: AzureBoardsImportResult['skipped'] = [];
        const errors: string[] = [];
        // zeenha fork: per-item outcomes let the renderer retry only failed ids.
        const items: AzureBoardsImportItemOutcome[] = [];

        for (const id of ids) {
          const item = fetched.get(id);
          try {
            const spec = await createSpecFromWorkItem(project, config, id, item, allowDuplicates);
            if (spec.kind === 'existing') {
              skipped.push({ id, specId: spec.specId });
              items.push({ id, status: 'skipped', specId: spec.specId, title: item?.title });
              continue;
            }
            agentManager.startSpecCreation(spec.specId, project.path, spec.description, spec.specDir, spec.metadata);
            imported++;
            items.push({ id, status: 'imported', specId: spec.specId, title: item?.title });
          } catch (err) {
            failed++;
            const reason = errorMessage(err, 'Unknown error');
            errors.push(`Failed to import AB#${id}: ${reason}`);
            items.push({ id, status: 'failed', title: item?.title, reason });
          }
        }

        return {
          success: true,
          data: { success: failed === 0, imported, failed, skipped, errors: errors.length > 0 ? errors : undefined, items }
        };
      } catch (error) {
        debugLog('Work item import failed');
        return { success: false, error: errorMessage(error, 'Failed to import work items') };
      }
    }
  );
}
