/**
 * zeenha fork: Jira is a writeback-only tracker with its own settings block
 * (jiraWriteback), so it implements OutcomeWriter with isEnabled instead of a
 * settingKey in issueWriteback. Electron-free: the desktop passes a settings
 * loader that reads the settings file; the CLI passes its config's settings.
 * Errors, paths, logs and tokens are never sent or logged.
 */

import type { DeliveryResult } from '../../../shared/types/delivery-receipt';
import type { JiraWritebackSettings } from '../../../shared/types/settings';
import { appLogPort } from '../../log-port';
import type { WebhookEvent } from '../../task-webhook-core';
import {
  addIssueComment, isValidIssueKey, JiraAPIError, JiraTransitionLookupError, normalizeJiraSiteUrl, transitionIssue
} from '../jira/jira-client';
import { type JiraConfig, getJiraConfig } from '../jira/jira-config';
import type { OutcomeWriter } from './types';
import { classifyWritebackError, skipWriteback, trackWriteback } from './writeback-utils';

function warn(event: string, issueKey: string, what: string, err: unknown): void {
  try {
    const detail = err instanceof JiraAPIError
      ? `${err.message}${err.statusCode ? ` (HTTP ${err.statusCode})` : ''}`
      : err instanceof Error ? err.name : 'UnknownError';
    appLogPort.warn(`[JiraWriteback] ${what} failed event=${event} issue=${issueKey} reason=${detail}`);
  } catch {
    // never throw from logging
  }
}

function mutationReceipt(confirmed: boolean, httpStatus: number): DeliveryResult {
  return confirmed
    ? { status: 'delivered', attempts: 1, httpStatus }
    : { status: 'unknown', reason: 'ambiguous_response', attempts: 1, httpStatus };
}

function mutationError(err: unknown): DeliveryResult {
  if (err instanceof JiraAPIError && err.failureKind) {
    return { status: 'unknown', reason: err.failureKind, attempts: 1, httpStatus: err.statusCode };
  }
  return classifyWritebackError(err, err instanceof JiraAPIError ? err.statusCode : undefined);
}

export function createJiraWriter(
  loadSettings: () => JiraWritebackSettings,
  getConfig: (project: Parameters<OutcomeWriter['postOutcome']>[0]['project']) => JiraConfig | null = getJiraConfig
): OutcomeWriter {
  return {
    sourceType: 'jira',
    isEnabled: (raw) => raw.jiraWriteback?.enabled === true,

    postOutcome({ meta, project, event, text, recorder }) {
      try {
        if ((event as WebhookEvent) === 'pr_opened') return;
        const settings = loadSettings();
        const statusName = settings.transitionStatusName.trim();
        const doTransition = event === 'review_ready' && settings.transitionOnReview && statusName.length > 0;
        if (!settings.comment && !doTransition) return;

        const comment = { operation: 'issue_comment', provider: 'jira', event } as const;
        const transition = { ...comment, operation: 'issue_transition' } as const;
        const skipEnabled = async (reason: 'invalid_reference' | 'missing_configuration' | 'target_mismatch') => {
          if (settings.comment) await skipWriteback(recorder, comment, reason);
          if (doTransition) await skipWriteback(recorder, transition, reason);
        };
        const issueKey = meta.jiraIssueKey;
        if (!isValidIssueKey(issueKey)) return skipEnabled('invalid_reference');
        const config = getConfig(project);
        if (!config) return skipEnabled('missing_configuration');
        if (normalizeJiraSiteUrl(meta.jiraSiteUrl) !== config.siteUrl) return skipEnabled('target_mismatch');

        const run = async (): Promise<void> => {
          if (settings.comment) {
            await trackWriteback(recorder, comment, async () => {
              try {
                const { confirmed, httpStatus } = await addIssueComment(config.siteUrl, config.email, config.token, issueKey, text);
                return mutationReceipt(confirmed, httpStatus);
              } catch (err) {
                warn(event, issueKey, 'comment', err);
                return mutationError(err);
              }
            });
          }
          if (doTransition) {
            await trackWriteback(recorder, transition, async () => {
              try {
                const result = await transitionIssue(config.siteUrl, config.email, config.token, issueKey, statusName);
                if (!result.transitioned && result.reason === 'transition_not_available') {
                  return { status: 'skipped', reason: 'state_unavailable' };
                }
                return mutationReceipt(result.transitioned, result.httpStatus);
              } catch (err) {
                warn(event, issueKey, 'transition', err);
                if (err instanceof JiraTransitionLookupError) {
                  return { status: 'failed', reason: 'lookup_failed', httpStatus: err.statusCode };
                }
                return mutationError(err);
              }
            });
          }
        };
        return run().catch(() => undefined);
      } catch {
        // never let Jira problems affect task flow
      }
    }
  };
}
