import { describe, expect, it } from 'vitest';
import { SPEC_SLUG_MAX_LENGTH, buildSpecId, slugifySpecTitle } from '../spec-slug';

const TASK_BRANCH_RE = /^auto-claude\/[A-Za-z0-9._\-/]+$/;

describe('slugifySpecTitle', () => {
  it('cuts at the last whole word instead of mid-word', () => {
    // The old 50-char hard cut produced "...-while-a-page-loa".
    const slug = slugifySpecTitle(
      "Keep focus on the dashboard pager while a page loads and bring the new page's results into view",
    );
    expect(slug).toBe('keep-focus-on-the-dashboard-pager-while');
    expect(slug.length).toBeLessThanOrEqual(SPEC_SLUG_MAX_LENGTH);
  });

  it('drops a word the limit would split', () => {
    // A hard cut at 40 gives "reset-the-product-gallery-and-quantity-w".
    expect(slugifySpecTitle('Reset the product gallery and quantity when moving between products')).toBe(
      'reset-the-product-gallery-and-quantity',
    );
  });

  it('keeps a word that ends exactly at the limit', () => {
    const title = `${'a'.repeat(19)} ${'b'.repeat(20)} tail`; // 19 + 1 + 20 = 40
    expect(slugifySpecTitle(title)).toBe(`${'a'.repeat(19)}-${'b'.repeat(20)}`);
  });

  it('never ends with a dash', () => {
    expect(slugifySpecTitle("Make 'Add to cart' confirmation actionable: a View cart link")).not.toMatch(/-$/);
    expect(slugifySpecTitle('  --Fix the thing!!--  ')).toBe('fix-the-thing');
  });

  it('returns short titles unchanged apart from slugging', () => {
    expect(slugifySpecTitle('Validated thermal receipt printing')).toBe('validated-thermal-receipt-printing');
  });

  it('hard-cuts a single word longer than the limit', () => {
    expect(slugifySpecTitle('x'.repeat(60))).toBe('x'.repeat(SPEC_SLUG_MAX_LENGTH));
  });

  it('folds accents and falls back when nothing ASCII is left', () => {
    expect(slugifySpecTitle('Café crème')).toBe('cafe-creme');
    expect(slugifySpecTitle('إصلاح السلة')).toBe('task');
    expect(slugifySpecTitle('')).toBe('task');
  });
});

describe('buildSpecId', () => {
  it('pads the number and stays inside the branch charset Create PR enforces', () => {
    const id = buildSpecId(7, "Make 'Add to cart' confirmation actionable: a View cart link in the toast");
    expect(id).toBe('007-make-add-to-cart-confirmation-actionable');
    expect(`auto-claude/${id}`).toMatch(TASK_BRANCH_RE);
  });
});
