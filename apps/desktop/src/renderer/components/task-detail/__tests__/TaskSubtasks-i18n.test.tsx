/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import { TaskSubtasks } from '../TaskSubtasks';

describe('TaskSubtasks i18n', () => {
  it('renders translated empty state keys', () => {
    render(<TaskSubtasks task={{ subtasks: [] } as never} />);
    expect(screen.getByText('tasks:subtasks.empty')).toBeInTheDocument();
    expect(screen.getByText('tasks:subtasks.emptyHint')).toBeInTheDocument();
  });
});
