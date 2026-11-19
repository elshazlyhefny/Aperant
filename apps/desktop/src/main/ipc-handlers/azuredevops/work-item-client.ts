/**
 * zeenha fork: Azure Boards work item writes (comment + state) used by the outcome writeback.
 * Named work-item-client.ts to stay clear of any boards-client.ts.
 */

import { azureDevOpsFetch, MAX_COMMENT_LENGTH } from './utils';
import type { AzureDevOpsConfig } from './types';

type WorkItemConfig = Pick<AzureDevOpsConfig, 'organization' | 'project' | 'pat'>;

function assertWorkItemId(id: number): void {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error('Invalid Azure DevOps work item id');
  }
}

/** HTML-escape text for a work item comment; newlines become <br>. */
export function escapeForWorkItemComment(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r?\n/g, '<br>');
}

/** Add an HTML comment to a work item. */
export async function addWorkItemComment(config: WorkItemConfig, id: number, html: string): Promise<void> {
  assertWorkItemId(id);
  const text = html.length > MAX_COMMENT_LENGTH ? html.substring(0, MAX_COMMENT_LENGTH) : html;
  await azureDevOpsFetch(config, `/wit/workItems/${id}/comments?api-version=7.1-preview.4`, {
    method: 'POST',
    body: JSON.stringify({ text })
  });
}

/** Set System.State on a work item. */
export async function setWorkItemState(config: WorkItemConfig, id: number, state: string): Promise<void> {
  assertWorkItemId(id);
  await azureDevOpsFetch(config, `/wit/workitems/${id}?api-version=7.1`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json-patch+json' },
    body: JSON.stringify([{ op: 'add', path: '/fields/System.State', value: state }])
  });
}
