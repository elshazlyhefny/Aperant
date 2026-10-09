/**
 * zeenha fork: a failed triage used to come back as a default result
 * (category FEATURE, confidence 0), indistinguishable from a real one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockGenerateText = vi.fn();
const mockCreateSimpleClient = vi.fn();

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: (...args: unknown[]) => mockGenerateText(...args),
}));
vi.mock('../../../client/factory', () => ({
  createSimpleClient: (...args: unknown[]) => mockCreateSimpleClient(...args),
}));

import { isTriageFailure, triageBatchIssues, triageSingleIssue } from '../triage-engine';

const issue = { number: 5, title: 'Crash on start', author: { login: 'u' }, createdAt: '2026-01-01' };
const config = { repo: 'o/r' };

function clientOk() {
  mockCreateSimpleClient.mockResolvedValue({ model: {}, systemPrompt: 's' });
}

afterEach(() => vi.clearAllMocks());

describe('triage engine failures', () => {
  it('reports a model error as a failure, not as a feature', async () => {
    clientOk();
    mockGenerateText.mockRejectedValue(new Error('401 invalid x-api-key'));

    const outcome = await triageSingleIssue(issue, [issue], config);

    expect(isTriageFailure(outcome)).toBe(true);
    expect(outcome).toEqual({ issueNumber: 5, repo: 'o/r', failed: true, error: '401 invalid x-api-key' });
    expect(outcome).not.toHaveProperty('category');
  });

  it('reports a client creation error as that issue\'s failure', async () => {
    mockCreateSimpleClient.mockRejectedValue(new Error('no credentials'));

    const outcome = await triageSingleIssue(issue, [issue], config);

    expect(isTriageFailure(outcome)).toBe(true);
  });

  it('reports unparseable text output as a failure', async () => {
    clientOk();
    mockGenerateText.mockResolvedValue({ output: undefined, text: 'I cannot help with that.' });

    const outcome = await triageSingleIssue(issue, [issue], config);

    expect(isTriageFailure(outcome)).toBe(true);
  });

  it('returns a real result when the model answers', async () => {
    clientOk();
    mockGenerateText.mockResolvedValue({
      output: undefined,
      text: JSON.stringify({ category: 'bug', confidence: 0.9, priority: 'high' }),
    });

    const outcome = await triageSingleIssue(issue, [issue], config);

    expect(isTriageFailure(outcome)).toBe(false);
    expect(outcome).toMatchObject({ issueNumber: 5, category: 'bug', confidence: 0.9 });
  });

  it('keeps a batch going past a failed issue', async () => {
    clientOk();
    mockGenerateText
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValueOnce({ output: undefined, text: JSON.stringify({ category: 'question', confidence: 0.7 }) });

    const outcomes = await triageBatchIssues([issue, { ...issue, number: 6 }], config);

    expect(outcomes.map(isTriageFailure)).toEqual([true, false]);
  });
});
