/**
 * zeenha fork: Linear is a writeback-only tracker (no PRs), so it implements
 * OutcomeWriter without the Forge PR methods.
 */

import { getLinearApiKey, linearGraphQL } from '../linear-client';
import type { OutcomeWriter } from './types';
import { warn } from './writeback-utils';

const LINEAR_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const LINEAR_COMMENT_MUTATION =
  'mutation($input: CommentCreateInput!){ commentCreate(input: $input){ success } }';
const LINEAR_STATES_QUERY =
  'query($id: String!){ issue(id: $id){ team { states { nodes { id name } } } } }';
const LINEAR_ISSUE_UPDATE_MUTATION =
  'mutation($id: String!, $input: IssueUpdateInput!){ issueUpdate(id: $id, input: $input){ success } }';

export const linearWriter: OutcomeWriter = {
  sourceType: 'linear',
  settingKey: 'linear',

  postOutcome({ meta, project, event, text, settings }) {
    const issueId = meta.linearIssueId;
    if (typeof issueId !== 'string' || !LINEAR_ID_PATTERN.test(issueId)) return;
    const apiKey = getLinearApiKey(project);
    if (!apiKey) return;

    const stateName = (settings.linearTransitionStateName ?? '').trim();
    const doTransition =
      event === 'review_ready' && settings.linearTransitionOnReview === true && stateName.length > 0;

    const run = async (): Promise<void> => {
      try {
        const data = (await linearGraphQL(apiKey, LINEAR_COMMENT_MUTATION, {
          input: { issueId, body: text }
        })) as { commentCreate?: { success?: boolean } } | null | undefined;
        if (data?.commentCreate?.success === false) {
          throw new Error('LinearCommentRejected');
        }
      } catch (err) {
        warn('linear', event, issueId, err);
      }
      if (!doTransition) return;
      try {
        const states = (await linearGraphQL(apiKey, LINEAR_STATES_QUERY, { id: issueId })) as
          | { issue?: { team?: { states?: { nodes?: Array<{ id?: unknown; name?: unknown }> } } } }
          | null
          | undefined;
        const wanted = stateName.toLowerCase();
        const nodes = states?.issue?.team?.states?.nodes ?? [];
        const match = nodes.find(
          (n) => String(n?.name).trim().toLowerCase() === wanted && typeof n?.id === 'string' && n.id.length > 0
        );
        if (!match) return;
        const result = (await linearGraphQL(apiKey, LINEAR_ISSUE_UPDATE_MUTATION, {
          id: issueId,
          input: { stateId: match.id }
        })) as { issueUpdate?: { success?: boolean } } | null | undefined;
        if (result?.issueUpdate?.success === false) {
          throw new Error('LinearTransitionRejected');
        }
      } catch (err) {
        warn('linear', event, issueId, err, 'transition');
      }
    };
    return run().catch(() => undefined);
  }
};
