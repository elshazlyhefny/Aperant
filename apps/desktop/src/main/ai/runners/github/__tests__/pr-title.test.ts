/**
 * zeenha fork: AI-suggested Conventional Commits PR titles.
 *
 * The model's answer is only used when it is one clean line of the expected
 * shape and at most 72 characters; anything else falls back (null) so the
 * Create PR dialog keeps the task title.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ text: '', fail: false, prompts: [] as string[] }));

vi.mock('../../../../env-utils', () => ({ getAugmentedEnv: () => ({}) }));
vi.mock('../../../client/factory', () => ({
  createSimpleClient: vi.fn(async ({ systemPrompt }: { systemPrompt: string }) => ({ model: 'test-model', systemPrompt })),
}));
vi.mock('ai', () => ({
  generateText: vi.fn(async ({ prompt }: { prompt: string }) => {
    state.prompts.push(prompt);
    if (state.fail) throw new Error('model unavailable');
    return { text: state.text };
  }),
}));

import { MAX_SUGGESTED_PR_TITLE_LENGTH, normalizeSuggestedPRTitle, suggestPRTitle } from '../pr-creator';

describe('normalizeSuggestedPRTitle', () => {
  it('accepts a conventional title with and without a scope', () => {
    expect(normalizeSuggestedPRTitle('feat(shop): add View cart link to the add-to-cart toast')).toBe(
      'feat(shop): add View cart link to the add-to-cart toast',
    );
    expect(normalizeSuggestedPRTitle('fix: keep pager focus while a page loads')).toBe(
      'fix: keep pager focus while a page loads',
    );
  });

  it('cleans quoting, a "Title:" prefix, a trailing period and extra lines', () => {
    expect(normalizeSuggestedPRTitle('Title: "fix(pos): print Arabic receipts."\n\nThis fixes...')).toBe(
      'fix(pos): print Arabic receipts',
    );
    expect(normalizeSuggestedPRTitle('`feat(billing): add invoices`')).toBe('feat(billing): add invoices');
  });

  it('rejects anything that is not a conventional title', () => {
    expect(normalizeSuggestedPRTitle('Make Add to cart confirmation actionable')).toBeNull();
    expect(normalizeSuggestedPRTitle('feature(shop): add link')).toBeNull();
    expect(normalizeSuggestedPRTitle('feat(Shop Area): add link')).toBeNull();
    expect(normalizeSuggestedPRTitle('feat(shop):no space')).toBeNull();
    expect(normalizeSuggestedPRTitle('')).toBeNull();
    expect(normalizeSuggestedPRTitle(null)).toBeNull();
  });

  it('rejects a title longer than the limit instead of cutting it', () => {
    const long = `feat(shop): ${'a'.repeat(MAX_SUGGESTED_PR_TITLE_LENGTH)}`;
    expect(normalizeSuggestedPRTitle(long)).toBeNull();
    const exact = `fix: ${'b'.repeat(MAX_SUGGESTED_PR_TITLE_LENGTH - 5)}`;
    expect(exact).toHaveLength(MAX_SUGGESTED_PR_TITLE_LENGTH);
    expect(normalizeSuggestedPRTitle(exact)).toBe(exact);
  });
});

describe('suggestPRTitle', () => {
  beforeEach(() => {
    state.text = '';
    state.fail = false;
    state.prompts = [];
  });

  it("returns the model's title and gives it the task, commits and diff", async () => {
    state.text = 'feat(shop): add View cart link to the add-to-cart toast\n';
    const title = await suggestPRTitle({
      taskTitle: "Make 'Add to cart' confirmation actionable",
      specId: '019-make-add-to-cart-confirmation-actionable',
      commitLog: 'abc123 Add View cart link',
      diffSummary: ' components/CartAddedToast.vue | 20 +++',
    });
    expect(title).toBe('feat(shop): add View cart link to the add-to-cart toast');
    expect(state.prompts[0]).toContain("Make 'Add to cart' confirmation actionable");
    expect(state.prompts[0]).toContain('abc123 Add View cart link');
    expect(state.prompts[0]).toContain('CartAddedToast.vue');
  });

  it('returns null for an unusable answer or a model failure', async () => {
    state.text = 'Here is a great title for your PR!';
    expect(await suggestPRTitle({ taskTitle: 't', specId: '001-t', commitLog: '', diffSummary: '' })).toBeNull();
    state.fail = true;
    expect(await suggestPRTitle({ taskTitle: 't', specId: '001-t', commitLog: '', diffSummary: '' })).toBeNull();
  });
});
