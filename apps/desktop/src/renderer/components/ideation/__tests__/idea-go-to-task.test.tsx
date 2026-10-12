/**
 * @vitest-environment jsdom
 *
 * zeenha fork: a converted idea is stored as `archived` with its task link
 * (`converted` is never written any more). The detail panel offered "Go to
 * task" only for `converted`, so it never showed, and it offered "Convert to
 * task" on an idea that already was one. The card already linked archived
 * ideas; both now read linkedTaskIdOf().
 */
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import type { Idea } from '../../../../shared/types';
import { TooltipProvider } from '../../ui/tooltip';
import { IdeaCard } from '../IdeaCard';
import { IdeaDetailPanel } from '../IdeaDetailPanel';
import { linkedTaskIdOf } from '../type-guards';

const idea = (o: Partial<Idea> = {}): Idea =>
  ({
    id: 'ci-001',
    type: 'code_improvements',
    title: 'Send reminders to guests',
    description: 'd',
    rationale: 'r',
    status: 'archived',
    taskId: '027-send-reminders',
    createdAt: new Date(),
    buildsUpon: [],
    estimatedEffort: 'small',
    affectedFiles: [],
    existingPatterns: [],
    ...o,
  }) as Idea;

const panel = (i: Idea, onGoToTask = vi.fn(), onConvert = vi.fn()) =>
  render(<IdeaDetailPanel idea={i} onClose={vi.fn()} onConvert={onConvert} onGoToTask={onGoToTask} onDismiss={vi.fn()} />);

describe('linkedTaskIdOf', () => {
  it('is the task of an archived or legacy converted idea, and null otherwise', () => {
    expect(linkedTaskIdOf(idea())).toBe('027-send-reminders');
    expect(linkedTaskIdOf(idea({ status: 'converted' }))).toBe('027-send-reminders');
    expect(linkedTaskIdOf(idea({ taskId: undefined }))).toBeNull();
    expect(linkedTaskIdOf(idea({ status: 'draft' }))).toBeNull();
  });
});

describe('IdeaDetailPanel', () => {
  it('offers Go to task for a converted idea stored as archived, and no Convert', () => {
    const onGoToTask = vi.fn();
    panel(idea(), onGoToTask);
    fireEvent.click(screen.getByRole('button', { name: /ideation.goToTask/ }));
    expect(onGoToTask).toHaveBeenCalledWith('027-send-reminders');
    expect(screen.queryByRole('button', { name: /ideation.convertToTask/ })).toBeNull();
  });

  it('still links a legacy converted idea', () => {
    panel(idea({ status: 'converted' }));
    expect(screen.getByRole('button', { name: /ideation.goToTask/ })).toBeInTheDocument();
  });

  it('offers Convert, not Go to task, for a draft idea', () => {
    panel(idea({ status: 'draft', taskId: undefined }));
    expect(screen.getByRole('button', { name: /ideation.convertToTask/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /ideation.goToTask/ })).toBeNull();
  });
});

describe('IdeaCard', () => {
  it('links an archived idea to its task (one link, not two)', () => {
    const onGoToTask = vi.fn();
    render(
      <TooltipProvider>
        <IdeaCard idea={idea()} isSelected={false} onClick={vi.fn()} onConvert={vi.fn()} onGoToTask={onGoToTask} onDismiss={vi.fn()} onToggleSelect={vi.fn()} />
      </TooltipProvider>,
    );
    const links = screen.getAllByRole('button', { name: 'accessibility.goToTaskAriaLabel' });
    expect(links).toHaveLength(1);
    fireEvent.click(links[0]);
    expect(onGoToTask).toHaveBeenCalledWith('027-send-reminders');
  });
});
