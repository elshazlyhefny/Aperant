/**
 * @vitest-environment jsdom
 *
 * Ideation labels are i18n keys: every key must resolve in en and fr, and the
 * screens must render keys (through t) rather than English literals.
 */
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import {
  CODE_QUALITY_CATEGORY_LABELS,
  DOCUMENTATION_CATEGORY_LABELS,
  IDEATION_TYPE_DESCRIPTIONS,
  IDEATION_TYPE_LABELS,
  PERFORMANCE_CATEGORY_LABELS,
  SECURITY_CATEGORY_LABELS,
  SEO_CATEGORY_LABELS,
  UIUX_CATEGORY_LABELS,
} from '../../../../shared/constants/ideation';
import enCommon from '../../../../shared/i18n/locales/en/common.json';
import frCommon from '../../../../shared/i18n/locales/fr/common.json';
import type { IdeationConfig } from '../../../../shared/types';
import { IdeationEmptyState } from '../IdeationEmptyState';
import { IdeationFilters } from '../IdeationFilters';

const resolve = (tree: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], tree);

const maps = {
  IDEATION_TYPE_LABELS,
  IDEATION_TYPE_DESCRIPTIONS,
  UIUX_CATEGORY_LABELS,
  DOCUMENTATION_CATEGORY_LABELS,
  SECURITY_CATEGORY_LABELS,
  PERFORMANCE_CATEGORY_LABELS,
  CODE_QUALITY_CATEGORY_LABELS,
  SEO_CATEGORY_LABELS,
};

describe('ideation label keys', () => {
  for (const [name, map] of Object.entries(maps)) {
    for (const [locale, json] of [['en', enCommon], ['fr', frCommon]] as const) {
      it(`${name} resolves to non-empty strings in ${locale}`, () => {
        for (const value of Object.values(map)) {
          expect(value.startsWith('common:')).toBe(true);
          const found = resolve(json, value.slice('common:'.length));
          expect(typeof found, `${locale} ${value}`).toBe('string');
          expect((found as string).trim().length, `${locale} ${value}`).toBeGreaterThan(0);
        }
      });
    }
  }
});

describe('ideation screens', () => {
  it('IdeationFilters renders keys, not English literals', () => {
    render(<IdeationFilters activeTab="all" onTabChange={vi.fn()}><div /></IdeationFilters>);
    expect(screen.getByText('ideation.filters.all')).toBeInTheDocument();
    expect(screen.getByText('ideation.filters.security')).toBeInTheDocument();
    expect(screen.queryByText('Security')).toBeNull();
  });

  it('IdeationEmptyState renders keys, not English literals', () => {
    const config = { enabledTypes: ['code_improvements'], includeRoadmapContext: true, includeKanbanContext: true, maxIdeasPerType: 5 } as unknown as IdeationConfig;
    render(
      <IdeationEmptyState config={config} hasToken={true} isCheckingToken={false}
        onGenerate={vi.fn()} onOpenConfig={vi.fn()} onToggleIdeationType={vi.fn()} />
    );
    expect(screen.getByText('ideation.emptyState.title')).toBeInTheDocument();
    expect(screen.queryByText(/Generate/)).toBeNull();
  });
});
