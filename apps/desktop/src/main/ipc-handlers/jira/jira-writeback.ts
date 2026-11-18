/**
 * Report a Jira-imported task's outcome back to the issue it came from.
 *
 * zeenha fork: reports to the same Jira site/issue the user imported from, using
 * the credentials already used for import. The switch lives in user settings only
 * (default off). This is the desktop side: it reads the settings file and builds
 * the registry's Jira writer from the Electron-free forge/jira-writer.ts.
 * Nothing here throws.
 */

import type { JiraWritebackSettings } from '../../../shared/types/settings';
import { DEFAULT_APP_SETTINGS } from '../../../shared/constants/config';
import { readSettingsFile } from '../../settings-utils';
import { createJiraWriter } from '../forge/jira-writer';
import { type OutcomeEvent, buildOutcomeComment } from '../issue-writeback/common';

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

/** The desktop Jira writer, registered in forge/registry.ts. */
export const jiraWriter = createJiraWriter(loadSettings);
