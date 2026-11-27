/**
 * zeenha fork: Azure Boards outcome writer. Electron-free so the headless CLI can
 * await it. Tokens and response bodies are never logged (see writeback-utils warn).
 */

import type { DeliveryResult } from '../../../shared/types/delivery-receipt';
import { AzureDevOpsAPIError, getAzureDevOpsConfig } from '../azuredevops/utils';
import { addWorkItemComment, escapeForWorkItemComment, setWorkItemState } from '../azuredevops/work-item-client';
import type { WebhookEvent } from '../../task-webhook-core';
import type { OutcomeWriter } from './types';
import { classifyWritebackError, isPositiveSafeInt, skipWriteback, trackWriteback, warn } from './writeback-utils';

type ConfigLoader = typeof getAzureDevOpsConfig;

function sameName(a: unknown, b: string): boolean {
  return typeof a === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function createAzureBoardsWriter(getConfig: ConfigLoader = getAzureDevOpsConfig): OutcomeWriter {
  return {
    sourceType: 'azure_boards',
    settingKey: 'azureboards',

    postOutcome({ meta, project, event, text, settings, recorder }) {
      try {
        if ((event as WebhookEvent) === 'pr_opened') return;
        const comment = { operation: 'issue_comment', provider: 'azureboards', event } as const;
        const transition = { ...comment, operation: 'issue_transition' } as const;
        const stateName = (settings.azureBoardsTransitionStateName ?? '').trim();
        const doTransition =
          event === 'review_ready' && settings.azureBoardsTransitionOnReview === true && stateName.length > 0;
        const skipBoth = async (reason: 'invalid_reference' | 'missing_configuration' | 'target_mismatch') => {
          await skipWriteback(recorder, comment, reason);
          if (doTransition) await skipWriteback(recorder, transition, reason);
        };

        const run = async (): Promise<void> => {
          const id = meta.azureBoardsWorkItemId;
          if (!isPositiveSafeInt(id)) return skipBoth('invalid_reference');
          const config = await getConfig(project);
          if (!config) return skipBoth('missing_configuration');
          if (!sameName(meta.azureBoardsOrganization, config.organization) || !sameName(meta.azureBoardsProject, config.project)) {
            return skipBoth('target_mismatch');
          }

          const send = async (what: 'comment' | 'transition', mutate: () => Promise<void>): Promise<DeliveryResult> => {
            try {
              await mutate();
              return { status: 'delivered', attempts: 1 };
            } catch (err) {
              warn('azureboards', event, `#${id}`, err, what);
              return classifyWritebackError(err, err instanceof AzureDevOpsAPIError ? err.statusCode : undefined);
            }
          };
          await trackWriteback(recorder, comment, () => send('comment', () => addWorkItemComment(config, id, escapeForWorkItemComment(text))));
          if (!doTransition) return;
          await trackWriteback(recorder, transition, () => send('transition', () => setWorkItemState(config, id, stateName)));
        };
        return run().catch(() => undefined);
      } catch {
        // never let Azure Boards problems affect task flow
      }
    }
  };
}

export const azureBoardsWriter = createAzureBoardsWriter();
