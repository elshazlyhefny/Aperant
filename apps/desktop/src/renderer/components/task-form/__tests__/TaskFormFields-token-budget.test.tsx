/**
 * @vitest-environment jsdom
 *
 * zeenha fork: the per-task token budget field. Blank inherits the project
 * default, a number is a limit, and the checkbox stores 0 (no limit).
 */
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) => (o?.value ? `${key}:${o.value}` : key),
    i18n: { language: 'en' },
  }),
}));
vi.mock('../../AgentProfileSelector', () => ({ AgentProfileSelector: () => null }));
vi.mock('../ClassificationFields', () => ({ ClassificationFields: () => null }));
vi.mock('../../ScreenshotCapture', () => ({ ScreenshotCapture: () => null }));
vi.mock('../ImagePreviewModal', () => ({ ImagePreviewModal: () => null }));

import { TaskFormFields } from '../TaskFormFields';

function form(text: string, onChange: (v: string) => void, inherited?: number) {
  return (
    <TaskFormFields
      description=""
      onDescriptionChange={() => undefined}
      title=""
      onTitleChange={() => undefined}
      profileId=""
      model=""
      thinkingLevel=""
      onProfileChange={() => undefined}
      onModelChange={() => undefined}
      onThinkingLevelChange={() => undefined}
      onPhaseModelsChange={() => undefined}
      onPhaseThinkingChange={() => undefined}
      category=""
      priority=""
      complexity=""
      impact=""
      onCategoryChange={() => undefined}
      onPriorityChange={() => undefined}
      onComplexityChange={() => undefined}
      onImpactChange={() => undefined}
      showClassification={false}
      onShowClassificationChange={() => undefined}
      images={[]}
      onImagesChange={() => undefined}
      requireReviewBeforeCoding={false}
      onRequireReviewChange={() => undefined}
      tokenBudgetText={text}
      onTokenBudgetTextChange={onChange}
      inheritedTokenBudget={inherited}
    />
  );
}

describe('TaskFormFields token budget', () => {
  it('shows the inherited project default and emits typed numbers', () => {
    const onChange = vi.fn();
    render(form('', onChange, 250000));
    expect(screen.getByText(/tokenBudgetInherited/)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('tasks:form.tokenBudgetPlaceholder'), { target: { value: '1234' } });
    expect(onChange).toHaveBeenCalledWith('1234');
  });

  it('shows the none hint when the project has no default', () => {
    render(form('', vi.fn()));
    expect(screen.getByText('tasks:form.tokenBudgetInheritedNone')).toBeInTheDocument();
  });

  it('checkbox stores 0 and disables the input; unchecking clears to inherit', () => {
    const onChange = vi.fn();
    const { rerender } = render(form('', onChange));
    fireEvent.click(screen.getByRole('checkbox', { name: 'tasks:form.tokenBudgetNoLimit' }));
    expect(onChange).toHaveBeenCalledWith('0');
    rerender(form('0', onChange));
    expect(screen.getByPlaceholderText('tasks:form.tokenBudgetPlaceholder')).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'tasks:form.tokenBudgetNoLimit' }));
    expect(onChange).toHaveBeenLastCalledWith('');
  });
});
