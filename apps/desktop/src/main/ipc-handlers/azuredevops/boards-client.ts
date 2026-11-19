/**
 * Azure Boards (work item tracking) client.
 *
 * All requests go through azureDevOpsFetch so URLs and auth headers are built in one
 * place and the PAT never reaches logs or error messages.
 */

import type { AzureBoardsFilter, AzureBoardsMetadata, AzureBoardsSavedQuery } from '../../../shared/types';
import type { AzureDevOpsConfig } from './types';
import { AZURE_DEVOPS_API_BASE, azureDevOpsFetch } from './utils';

type BoardsConfig = Pick<AzureDevOpsConfig, 'organization' | 'project' | 'pat'>;

export const WIQL_MAX_RESULTS = 200;
export const WORK_ITEMS_BATCH_SIZE = 200;

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WORK_ITEM_FIELDS = [
  'System.Id',
  'System.Title',
  'System.WorkItemType',
  'System.State',
  'System.AreaPath',
  'System.AssignedTo',
  'System.Tags',
  'System.Description',
  'Microsoft.VSTS.Common.AcceptanceCriteria',
  'Microsoft.VSTS.TCM.ReproSteps',
  'Microsoft.VSTS.Common.Priority'
];

export interface AzureBoardsWorkItemData {
  id: number;
  title: string;
  workItemType: string;
  state: string;
  areaPath: string;
  assignedTo?: string;
  tags: string[];
  /** Markdown converted from the HTML description */
  description: string;
  acceptanceCriteria: string;
  reproSteps: string;
  priority?: number;
  url: string;
}

export interface WiqlResult {
  ids: number[];
  truncated: boolean;
}

interface QueryNode {
  id?: string;
  name?: string;
  path?: string;
  isFolder?: boolean;
  children?: QueryNode[];
}

interface RawWorkItem {
  id?: number;
  fields?: Record<string, unknown>;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function assertValidIds(ids: number[]): void {
  for (const id of ids) {
    if (!isPositiveInteger(id)) {
      throw new Error('Invalid work item id');
    }
  }
}

/** Escape a WIQL string literal by doubling single quotes */
function wiqlLiteral(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function wiqlList(values: string[]): string {
  return `(${values.map(wiqlLiteral).join(', ')})`;
}

export function buildWorkItemUrl(config: Pick<AzureDevOpsConfig, 'organization' | 'project'>, id: number): string {
  if (!isPositiveInteger(id)) {
    throw new Error('Invalid work item id');
  }
  return (
    `${AZURE_DEVOPS_API_BASE}/${encodeURIComponent(config.organization)}` +
    `/${encodeURIComponent(config.project)}/_workitems/edit/${id}`
  );
}

function flattenQueries(nodes: QueryNode[] | undefined, out: AzureBoardsSavedQuery[]): void {
  for (const node of nodes ?? []) {
    if (node.isFolder || node.children?.length) {
      flattenQueries(node.children, out);
    }
    if (!node.isFolder && node.id && node.name) {
      out.push({ id: node.id, name: node.name, path: node.path ?? node.name });
    }
  }
}

export async function listSavedQueries(config: BoardsConfig): Promise<AzureBoardsSavedQuery[]> {
  const response = (await azureDevOpsFetch(config, '/wit/queries?$depth=2&$expand=none')) as {
    value?: QueryNode[];
  };
  const out: AzureBoardsSavedQuery[] = [];
  flattenQueries(response.value, out);
  return out;
}

export async function getBoardsMetadata(config: BoardsConfig): Promise<AzureBoardsMetadata> {
  const response = (await azureDevOpsFetch(config, '/wit/workitemtypes')) as {
    value?: Array<{ name?: string; states?: Array<{ name?: string }> }>;
  };
  const types = new Set<string>();
  const states = new Set<string>();
  for (const type of response.value ?? []) {
    if (type.name) types.add(type.name);
    for (const state of type.states ?? []) {
      if (state.name) states.add(state.name);
    }
  }
  return { workItemTypes: [...types], states: [...states] };
}

export function buildWiql(filter: AzureBoardsFilter = {}): string {
  const clauses = ['[System.TeamProject] = @project'];
  if (filter.areaPath) {
    clauses.push(`[System.AreaPath] UNDER ${wiqlLiteral(filter.areaPath)}`);
  }
  if (filter.states?.length) {
    clauses.push(`[System.State] IN ${wiqlList(filter.states)}`);
  }
  if (filter.workItemTypes?.length) {
    clauses.push(`[System.WorkItemType] IN ${wiqlList(filter.workItemTypes)}`);
  }
  return `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(' AND ')} ORDER BY [System.ChangedDate] DESC`;
}

export async function runWiql(
  config: BoardsConfig,
  request: { savedQueryId?: string; filter?: AzureBoardsFilter }
): Promise<WiqlResult> {
  let response: { workItems?: Array<{ id?: number }> };

  if (request.savedQueryId !== undefined) {
    if (typeof request.savedQueryId !== 'string' || !GUID_PATTERN.test(request.savedQueryId)) {
      throw new Error('Invalid saved query id');
    }
    response = (await azureDevOpsFetch(config, `/wit/wiql/${request.savedQueryId}`)) as typeof response;
  } else {
    response = (await azureDevOpsFetch(config, `/wit/wiql?$top=${WIQL_MAX_RESULTS}`, {
      method: 'POST',
      body: JSON.stringify({ query: buildWiql(request.filter) })
    })) as typeof response;
  }

  const all = (response.workItems ?? []).map((w) => w.id).filter(isPositiveInteger);
  const truncated = all.length >= WIQL_MAX_RESULTS && (request.savedQueryId ? all.length > WIQL_MAX_RESULTS : true);
  return { ids: all.slice(0, WIQL_MAX_RESULTS), truncated };
}

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'"
};

/** Convert Azure Boards HTML to plain Markdown-ish text. Never interprets the HTML. */
export function htmlToMarkdown(html: string | undefined | null): string {
  if (!html) return '';
  let text = String(html)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|ul|ol|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<(p|div|h[1-6])\b[^>]*>/gi, '\n');
  // Strip remaining tags repeatedly so nested fragments like "<<b>script>" cannot survive
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<[^<>]*>/g, '');
  } while (text !== previous);
  text = text
    .replace(/&(?:nbsp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&amp;/g, '&');
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function identityName(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (value && typeof value === 'object') {
    const v = value as { displayName?: unknown; uniqueName?: unknown };
    if (typeof v.displayName === 'string' && v.displayName) return v.displayName;
    if (typeof v.uniqueName === 'string' && v.uniqueName) return v.uniqueName;
  }
  return undefined;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeWorkItem(config: BoardsConfig, raw: RawWorkItem): AzureBoardsWorkItemData | null {
  const f = raw.fields ?? {};
  const id = isPositiveInteger(raw.id) ? raw.id : f['System.Id'];
  if (!isPositiveInteger(id)) return null;
  const priority = f['Microsoft.VSTS.Common.Priority'];
  return {
    id,
    title: str(f['System.Title']),
    workItemType: str(f['System.WorkItemType']),
    state: str(f['System.State']),
    areaPath: str(f['System.AreaPath']),
    assignedTo: identityName(f['System.AssignedTo']),
    tags: str(f['System.Tags'])
      .split(';')
      .map((t) => t.trim())
      .filter(Boolean),
    description: htmlToMarkdown(str(f['System.Description'])),
    acceptanceCriteria: htmlToMarkdown(str(f['Microsoft.VSTS.Common.AcceptanceCriteria'])),
    reproSteps: htmlToMarkdown(str(f['Microsoft.VSTS.TCM.ReproSteps'])),
    priority: typeof priority === 'number' ? priority : undefined,
    url: buildWorkItemUrl(config, id)
  };
}

export async function getWorkItemsByIds(config: BoardsConfig, ids: number[]): Promise<AzureBoardsWorkItemData[]> {
  assertValidIds(ids);
  const byId = new Map<number, AzureBoardsWorkItemData>();

  for (let i = 0; i < ids.length; i += WORK_ITEMS_BATCH_SIZE) {
    const chunk = ids.slice(i, i + WORK_ITEMS_BATCH_SIZE);
    const response = (await azureDevOpsFetch(config, '/wit/workitemsbatch', {
      method: 'POST',
      body: JSON.stringify({ ids: chunk, fields: WORK_ITEM_FIELDS })
    })) as { value?: RawWorkItem[] };
    for (const raw of response.value ?? []) {
      const item = normalizeWorkItem(config, raw);
      if (item) byId.set(item.id, item);
    }
  }

  // Preserve the order of the requested ids (the WIQL ordering)
  const ordered: AzureBoardsWorkItemData[] = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (item) ordered.push(item);
  }
  return ordered;
}
