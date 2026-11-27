/**
 * zeenha fork: Linear is a writeback-only tracker (no PRs), so it implements
 * OutcomeWriter without the Forge PR methods.
 */

import type { DeliveryResult } from '../../../shared/types/delivery-receipt';
import { getLinearApiKey, linearGraphQL } from '../linear-client';
import type { OutcomeWriter } from './types';
import { classifyWritebackError, skipWriteback, trackWriteback, warn } from './writeback-utils';

const LINEAR_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const LINEAR_COMMENT_MUTATION =
  'mutation($input: CommentCreateInput!){ commentCreate(input: $input){ success } }';
const LINEAR_STATES_QUERY =
  'query($id: String!){ issue(id: $id){ team { states { nodes { id name } } } } }';
const LINEAR_ISSUE_UPDATE_MUTATION =
  'mutation($id: String!, $input: IssueUpdateInput!){ issueUpdate(id: $id, input: $input){ success } }';

function mutationResult(success: unknown, warnRejected: () => void): DeliveryResult {
  if (success === true) return { status: 'delivered', attempts: 1 };
  if (success === false) {
    warnRejected();
    return { status: 'failed', reason: 'rejected', attempts: 1 };
  }
  return { status: 'unknown', reason: 'ambiguous_response', attempts: 1 };
}

function linearStatus(err: unknown): number | undefined {
  return err instanceof Error && 'linearStatus' in err && typeof err.linearStatus === 'number'
    ? err.linearStatus
    : undefined;
}

export const linearWriter: OutcomeWriter = {
  sourceType: 'linear',
  settingKey: 'linear',

  postOutcome({ meta, project, event, text, settings, recorder }) {
    const comment = { operation: 'issue_comment', provider: 'linear', event } as const;
    const transition = { ...comment, operation: 'issue_transition' } as const;
    const stateName = (settings.linearTransitionStateName ?? '').trim();
    const doTransition =
      event === 'review_ready' && settings.linearTransitionOnReview === true && stateName.length > 0;

    const run = async (): Promise<void> => {
      const skipBoth = async (reason: 'invalid_reference' | 'missing_configuration') => {
        await skipWriteback(recorder, comment, reason);
        if (doTransition) await skipWriteback(recorder, transition, reason);
      };
      const issueId = meta.linearIssueId;
      if (typeof issueId !== 'string' || !LINEAR_ID_PATTERN.test(issueId)) return skipBoth('invalid_reference');
      const apiKey = getLinearApiKey(project);
      if (!apiKey) return skipBoth('missing_configuration');

      await trackWriteback(recorder, comment, async () => {
        try {
          const data = (await linearGraphQL(apiKey, LINEAR_COMMENT_MUTATION, {
            input: { issueId, body: text }
          })) as { commentCreate?: { success?: unknown } } | null | undefined;
          return mutationResult(data?.commentCreate?.success, () => warn('linear', event, issueId, new Error('LinearCommentRejected')));
        } catch (err) {
          warn('linear', event, issueId, err);
          return classifyWritebackError(err, linearStatus(err));
        }
      });
      if (!doTransition) return;

      await trackWriteback(recorder, transition, async () => {
        let stateId: string;
        try {
          const states = (await linearGraphQL(apiKey, LINEAR_STATES_QUERY, { id: issueId })) as
            | { issue?: { team?: { states?: { nodes?: Array<{ id?: unknown; name?: unknown }> } } } }
            | null
            | undefined;
          const nodes = states?.issue?.team?.states?.nodes;
          if (!Array.isArray(nodes)) throw new Error('InvalidLinearStatesResponse');
          const wanted = stateName.toLowerCase();
          const match = nodes.find(
            (n) => String(n?.name).trim().toLowerCase() === wanted && typeof n?.id === 'string' && n.id.length > 0
          );
          if (typeof match?.id !== 'string') return { status: 'skipped', reason: 'state_unavailable' };
          stateId = match.id;
        } catch (err) {
          warn('linear', event, issueId, err, 'transition');
          return { status: 'failed', reason: 'lookup_failed', httpStatus: linearStatus(err) };
        }
        try {
          const result = (await linearGraphQL(apiKey, LINEAR_ISSUE_UPDATE_MUTATION, {
            id: issueId,
            input: { stateId }
          })) as { issueUpdate?: { success?: unknown } } | null | undefined;
          return mutationResult(result?.issueUpdate?.success, () =>
            warn('linear', event, issueId, new Error('LinearTransitionRejected'), 'transition')
          );
        } catch (err) {
          warn('linear', event, issueId, err, 'transition');
          return classifyWritebackError(err, linearStatus(err));
        }
      });
    };
    return run().catch(() => undefined);
  }
};
