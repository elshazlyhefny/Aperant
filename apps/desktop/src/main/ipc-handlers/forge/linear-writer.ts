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

export const linearWriter: OutcomeWriter = {
  sourceType: 'linear',
  settingKey: 'linear',

  postOutcome({ meta, project, event, text }) {
    const issueId = meta.linearIssueId;
    if (typeof issueId !== 'string' || !LINEAR_ID_PATTERN.test(issueId)) return;
    const apiKey = getLinearApiKey(project);
    if (!apiKey) return;

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
    };
    void run().catch(() => undefined);
  }
};
