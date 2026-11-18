/**
 * Report a Jira-imported task's outcome back to the issue it came from.
 *
 * zeenha fork: reports to the same Jira site/issue the user imported from, using
 * the credentials already used for import. The switch lives in user settings only
 * (default off). Comments are built from allow-listed fields only; errors, paths,
 * logs and tokens are never sent or logged. Nothing here throws.
 */

import type { JiraWritebackSettings } from '../../../shared/types/settings';
import { DEFAULT_APP_SETTINGS } from '../../../shared/constants/config';
import { appLog } from '../../app-logger';
import { readSettingsFile } from '../../settings-utils';
import { type OutcomeEvent, buildOutcomeComment } from '../issue-writeback/common';
import { JiraAPIError } from './jira-client';

export function buildJiraComment(input: { event: OutcomeEvent; taskTitle?: string; prUrl?: string }): string {
  return buildOutcomeComment(input.event, input.taskTitle, input.prUrl);
}

export function loadSettings(): JiraWritebackSettings {
  const raw = readSettingsFile() ?? {};
  const def = DEFAULT_APP_SETTINGS.jiraWriteback;
  const w = ((raw as { jiraWriteback?: Partial<JiraWritebackSettings> }).jiraWriteback ?? {});
  return {
    enabled: w.enabled === true,
    comment: typeof w.comment === 'boolean' ? w.comment : def.comment,
    transitionOnReview: w.transitionOnReview === true,
    transitionStatusName: typeof w.transitionStatusName === 'string' ? w.transitionStatusName : def.transitionStatusName
  };
}

export function warn(event: string, issueKey: string, what: string, err: unknown): void {
  try {
    const detail = err instanceof JiraAPIError
      ? `${err.message}${err.statusCode ? ` (HTTP ${err.statusCode})` : ''}`
      : err instanceof Error ? err.name : 'UnknownError';
    appLog.warn(`[JiraWriteback] ${what} failed event=${event} issue=${issueKey} reason=${detail}`);
  } catch {
    // never throw from logging
  }
}
