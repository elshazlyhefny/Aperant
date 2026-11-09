import { describe, it, expect } from 'vitest';
import type { PRReviewCategory } from '@shared/types/pr-review';
import { CATEGORY_ICONS, getCategoryIcon } from '../severity-config';
import enCommon from '../../../../../shared/i18n/locales/en/common.json';
import frCommon from '../../../../../shared/i18n/locales/fr/common.json';

// Typed as Record so adding a category to the union fails typecheck until listed here
const ALL_CATEGORIES: Record<PRReviewCategory, true> = {
  security: true,
  quality: true,
  style: true,
  test: true,
  docs: true,
  pattern: true,
  performance: true,
  verification_failed: true,
};

const LEGACY_KEYS = ['logic', 'documentation', 'testing', 'other'];

describe('PR review category maps', () => {
  const categories = Object.keys(ALL_CATEGORIES) as PRReviewCategory[];

  it('has an icon for every category', () => {
    for (const category of categories) {
      expect(CATEGORY_ICONS[category]).toBeDefined();
    }
  });

  it('falls back to an icon for unknown categories', () => {
    expect(getCategoryIcon('logic')).toBeDefined();
    expect(getCategoryIcon('totally-unknown')).toBeDefined();
  });

  it.each([
    ['en', enCommon],
    ['fr', frCommon],
  ])('%s defines translations for all categories and legacy keys', (_name, json) => {
    const table = (json as { prReview: { category: Record<string, string> } }).prReview.category;
    for (const key of [...categories, ...LEGACY_KEYS]) {
      expect(table[key], `missing prReview.category.${key}`).toBeTruthy();
    }
  });
});
