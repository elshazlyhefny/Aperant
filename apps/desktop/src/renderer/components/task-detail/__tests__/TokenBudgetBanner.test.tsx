/**
 * @vitest-environment jsdom
 *
 * zeenha fork: banner shown when a task paused on its token budget.
 */
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) =>
      opts ? `${key} ${Object.values(opts).join('/')}` : key,
    i18n: { language: 'en' }
  })
}));
vi.mock('../../../stores/project-store', () => ({
  useProjectStore: (sel: (s: unknown) => unknown) =>
    sel({ getActiveProject: () => ({ id: 'p1', settings: {} }) })
}));
const calls: string[] = [];
const persistUpdateTask = vi.fn(async (..._args: unknown[]) => {
  calls.push('save');
  return true;
});
const startTaskOrQueue = vi.fn(async (..._args: unknown[]) => {
  calls.push('start');
  return { action: 'started', success: true };
});
vi.mock('../../../stores/task-store', () => ({
  persistUpdateTask: (...a: unknown[]) => persistUpdateTask(...a),
  startTaskOrQueue: (...a: unknown[]) => startTaskOrQueue(...a)
}));

import { TokenBudgetBanner } from '../TokenBudgetBanner';

const task = { id: 't1', specId: '002-x', metadata: { tokenBudget: 1000 } } as never;
const getTaskRunMetrics = vi.fn();

beforeEach(() => {
  calls.length = 0;
  persistUpdateTask.mockClear();
  startTaskOrQueue.mockClear();
  getTaskRunMetrics.mockReset();
  getTaskRunMetrics.mockResolvedValue({
    success: true,
    data: { summary: { tokens: { input: 900, output: 150, cacheRead: 500, cacheCreation: 5 } } }
  });
  (window as unknown as { electronAPI: unknown }).electronAPI = { getTaskRunMetrics };
});

describe('TokenBudgetBanner', () => {
  it('renders used and limit and a suggested higher limit', async () => {
    render(<TokenBudgetBanner task={task} />);
    await waitFor(() =>
      expect(screen.getByTestId('token-budget-banner-usage')).toHaveTextContent('1,050/1,000')
    );
    expect(screen.getByTestId('token-budget-banner-input')).toHaveValue(1500);
  });

  it('saves the raised budget before starting', async () => {
    render(<TokenBudgetBanner task={task} />);
    fireEvent.change(screen.getByTestId('token-budget-banner-input'), { target: { value: '2500' } });
    fireEvent.click(screen.getByTestId('token-budget-banner-resume'));
    await waitFor(() => expect(startTaskOrQueue).toHaveBeenCalledWith('t1'));
    expect(persistUpdateTask).toHaveBeenCalledWith('t1', { metadata: { tokenBudget: 2500 } });
    expect(calls).toEqual(['save', 'start']);
  });

  it('stores 0 when unlimited is chosen', async () => {
    render(<TokenBudgetBanner task={task} />);
    fireEvent.click(screen.getByTestId('token-budget-banner-unlimited'));
    fireEvent.click(screen.getByTestId('token-budget-banner-resume'));
    await waitFor(() => expect(startTaskOrQueue).toHaveBeenCalled());
    expect(persistUpdateTask).toHaveBeenCalledWith('t1', { metadata: { tokenBudget: 0 } });
  });

  it('does not start when saving fails', async () => {
    persistUpdateTask.mockResolvedValueOnce(false);
    render(<TokenBudgetBanner task={task} />);
    fireEvent.click(screen.getByTestId('token-budget-banner-resume'));
    await screen.findByText('tasks:tokenBudgetBanner.saveFailed');
    expect(startTaskOrQueue).not.toHaveBeenCalled();
  });
});
