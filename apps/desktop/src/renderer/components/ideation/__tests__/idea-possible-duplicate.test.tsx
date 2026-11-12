/**
 * @vitest-environment jsdom
 *
 * zeenha fork: a new idea that may repeat an existing task or idea is flagged
 * with a badge on the card and the detail panel. The badge never hides the
 * convert and dismiss actions, and it is not shown once the idea is acted on.
 */
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import enCommon from '../../../../shared/i18n/locales/en/common.json';
import frCommon from '../../../../shared/i18n/locales/fr/common.json';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import type { Idea } from '../../../../shared/types';
import { TooltipProvider } from '../../ui/tooltip';
import { IdeaCard } from '../IdeaCard';
import { IdeaDetailPanel } from '../IdeaDetailPanel';

const TASK_KEY = 'ideation.possibleDuplicate.task';
const IDEA_KEY = 'ideation.possibleDuplicate.idea';

const idea = (o: Partial<Idea> = {}): Idea =>
  ({
    id: 'ci-001',
    type: 'code_improvements',
    title: 'Send reminders to guests',
    description: 'd',
    rationale: 'r',
    status: 'draft',
    createdAt: new Date(),
    buildsUpon: [],
    estimatedEffort: 'small',
    affectedFiles: [],
    existingPatterns: [],
    possibleDuplicateOf: { kind: 'task', id: '038-low-stock-reorder', score: 0.82 },
    ...o,
  }) as Idea;

const card = (i: Idea, onConvert = vi.fn(), onDismiss = vi.fn()) =>
  render(
    <TooltipProvider>
      <IdeaCard idea={i} isSelected={false} onClick={vi.fn()} onConvert={onConvert} onGoToTask={vi.fn()} onDismiss={onDismiss} onToggleSelect={vi.fn()} />
    </TooltipProvider>,
  );

const panel = (i: Idea, onConvert = vi.fn(), onDismiss = vi.fn()) =>
  render(
    <TooltipProvider>
      <IdeaDetailPanel idea={i} onClose={vi.fn()} onConvert={onConvert} onGoToTask={vi.fn()} onDismiss={onDismiss} />
    </TooltipProvider>,
  );

const views = [
  ['IdeaCard', card],
  ['IdeaDetailPanel', panel],
] as const;

describe.each(views)('%s possible-duplicate badge', (_name, renderView) => {
  it('shows the task badge for a duplicate of a task', () => {
    renderView(idea());
    expect(screen.getByText(TASK_KEY)).toBeInTheDocument();
    expect(screen.queryByText(IDEA_KEY)).toBeNull();
  });

  it('shows the idea badge for a duplicate of an idea', () => {
    renderView(idea({ possibleDuplicateOf: { kind: 'idea', id: 'ci-000', score: 0.7, title: 'Other idea' } }));
    expect(screen.getByText(IDEA_KEY)).toBeInTheDocument();
    expect(screen.queryByText(TASK_KEY)).toBeNull();
  });

  it('shows nothing without possibleDuplicateOf', () => {
    renderView(idea({ possibleDuplicateOf: undefined }));
    expect(screen.queryByText(TASK_KEY)).toBeNull();
    expect(screen.queryByText(IDEA_KEY)).toBeNull();
  });

  it('shows nothing for an archived idea with a task link', () => {
    renderView(idea({ status: 'archived', taskId: '027-send-reminders' }));
    expect(screen.queryByText(TASK_KEY)).toBeNull();
  });

  it('shows nothing for a dismissed idea', () => {
    renderView(idea({ status: 'dismissed' }));
    expect(screen.queryByText(TASK_KEY)).toBeNull();
  });

  it('keeps the convert and dismiss buttons working', () => {
    const onConvert = vi.fn();
    const onDismiss = vi.fn();
    const i = idea();
    renderView(i, onConvert, onDismiss);
    expect(screen.getByText(TASK_KEY)).toBeInTheDocument();
    const convert = screen.getAllByRole('button', { name: /convertToTask/ })[0];
    const dismiss = screen.getAllByRole('button', { name: /dismiss/i })[0];
    fireEvent.click(convert);
    fireEvent.click(dismiss);
    expect(onConvert).toHaveBeenCalledWith(i);
    expect(onDismiss).toHaveBeenCalledWith(i);
  });
});

describe('possibleDuplicate i18n keys', () => {
  const keysOf = (o: object) => Object.keys(o).sort();
  it('exist in en and fr with the same key set', () => {
    const en = enCommon.ideation.possibleDuplicate;
    const fr = frCommon.ideation.possibleDuplicate;
    expect(keysOf(en)).toEqual(['idea', 'score', 'task']);
    expect(keysOf(fr)).toEqual(keysOf(en));
  });
});
