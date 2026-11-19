/**
 * zeenha fork: Azure Boards outcome writer. Electron-free so the headless CLI can
 * await it. Tokens and response bodies are never logged (see writeback-utils warn).
 */

import { getAzureDevOpsConfig } from '../azuredevops/utils';
import { addWorkItemComment, escapeForWorkItemComment, setWorkItemState } from '../azuredevops/work-item-client';
import type { WebhookEvent } from '../../task-webhook-core';
import type { OutcomeWriter } from './types';
import { isPositiveSafeInt, warn } from './writeback-utils';

type ConfigLoader = typeof getAzureDevOpsConfig;

function sameName(a: unknown, b: string): boolean {
  return typeof a === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function createAzureBoardsWriter(getConfig: ConfigLoader = getAzureDevOpsConfig): OutcomeWriter {
  return {
    sourceType: 'azure_boards',
    settingKey: 'azureboards',

    postOutcome({ meta, project, event, text, settings }) {
      try {
        if ((event as WebhookEvent) === 'pr_opened') return;
        const id = meta.azureBoardsWorkItemId;
        if (!isPositiveSafeInt(id)) return;

        const stateName = (settings.azureBoardsTransitionStateName ?? '').trim();
        const doTransition =
          event === 'review_ready' && settings.azureBoardsTransitionOnReview === true && stateName.length > 0;

        const run = async (): Promise<void> => {
          const config = await getConfig(project);
          if (!config) return;
          if (!sameName(meta.azureBoardsOrganization, config.organization)) return;
          if (!sameName(meta.azureBoardsProject, config.project)) return;

          try {
            await addWorkItemComment(config, id, escapeForWorkItemComment(text));
          } catch (err) {
            warn('azureboards', event, `#${id}`, err);
          }
          if (!doTransition) return;
          try {
            await setWorkItemState(config, id, stateName);
          } catch (err) {
            warn('azureboards', event, `#${id}`, err, 'transition');
          }
        };
        return run().catch(() => undefined);
      } catch {
        // never let Azure Boards problems affect task flow
      }
    }
  };
}

export const azureBoardsWriter = createAzureBoardsWriter();
