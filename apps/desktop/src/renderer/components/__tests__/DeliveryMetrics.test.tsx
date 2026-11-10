/**
 * @vitest-environment jsdom
 *
 * zeenha fork: the project Delivery view renders project-wide run metrics.
 */
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}|${Object.entries(opts).map(([k, v]) => `${k}=${v}`).join(',')}` : key,
    i18n: { language: 'en' }
  })
}));

import { DeliveryMetrics } from '../DeliveryMetrics';

const getProjectRunMetrics = vi.fn();

const tokens = { input: 1234, output: 56, cacheRead: 7, cacheCreation: 8 };
const sample = {
  periodDays: 30,
  generatedAt: '2026-01-01T00:00:00.000Z',
  taskCount: 9,
  included: 6,
  excluded: { missing: 2, corrupt: 1 },
  completedTasks: 4,
  failedBeforeWork: { count: 3 },
  totals: { sessions: 5, durationMs: 184000, tokens, totalTokens: 98765 },
  perCompletedTask: { totalTokens: 24691, durationMs: 46000 },
  qa: { tasksWithQa: 0, totalIterations: 0, averageIterations: null },
  byPhase: [{ key: 'coding', tasks: 2, sessions: 3, durationMs: 60000, tokens, totalTokens: 1297 }],
  byModel: [{ key: 'model-x', tasks: 2, sessions: 3, durationMs: 60000, tokens, totalTokens: 1297 }],
  trend: [{ date: '2026-01-01', completedTasks: 2, totalTokens: 100, tokensPerCompletedTask: 50 }]
};

beforeEach(() => {
  getProjectRunMetrics.mockReset();
  (window as unknown as { electronAPI: unknown }).electronAPI = { getProjectRunMetrics };
});

describe('DeliveryMetrics', () => {
  it('calls the API with 30 days by default and re-calls on period change', async () => {
    getProjectRunMetrics.mockResolvedValue({ success: true, data: sample });
    render(<DeliveryMetrics projectId="p1" />);
    await screen.findByTestId('delivery-cards');
    expect(getProjectRunMetrics).toHaveBeenCalledWith('p1', 30);

    fireEvent.change(screen.getByTestId('delivery-period'), { target: { value: '7' } });
    await waitFor(() => expect(getProjectRunMetrics).toHaveBeenLastCalledWith('p1', 7));

    fireEvent.change(screen.getByTestId('delivery-period'), { target: { value: 'all' } });
    await waitFor(() => expect(getProjectRunMetrics).toHaveBeenLastCalledWith('p1', null));
  });

  it('renders cards and by-phase / by-model rows', async () => {
    getProjectRunMetrics.mockResolvedValue({ success: true, data: sample });
    render(<DeliveryMetrics projectId="p1" />);
    await screen.findByTestId('delivery-cards');
    expect(screen.getByTestId('delivery-card-total-tokens')).toHaveTextContent('98,765');
    expect(screen.getByTestId('delivery-card-avg-tokens')).toHaveTextContent('24,691');
    expect(screen.getByTestId('delivery-card-total-duration')).toHaveTextContent('3m 4s');
    expect(screen.getByTestId('delivery-card-avg-qa')).toHaveTextContent('—');
    expect(screen.getByTestId('delivery-by-phase')).toHaveTextContent('coding');
    expect(screen.getByTestId('delivery-by-model')).toHaveTextContent('model-x');
    expect(screen.getByTestId('delivery-trend')).toHaveTextContent('2026-01-01');
    expect(screen.getByTestId('delivery-note')).toBeInTheDocument();
  });

  it('shows the excluded counts', async () => {
    getProjectRunMetrics.mockResolvedValue({ success: true, data: sample });
    render(<DeliveryMetrics projectId="p1" />);
    const notice = await screen.findByTestId('delivery-excluded');
    expect(notice).toHaveTextContent('missing=2');
    expect(notice).toHaveTextContent('corrupt=1');
  });

  it('hides the excluded notice when nothing was excluded', async () => {
    getProjectRunMetrics.mockResolvedValue({
      success: true,
      data: { ...sample, excluded: { missing: 0, corrupt: 0 } }
    });
    render(<DeliveryMetrics projectId="p1" />);
    await screen.findByTestId('delivery-cards');
    expect(screen.queryByTestId('delivery-excluded')).not.toBeInTheDocument();
  });

  it('shows the failed-before-work count highlighted', async () => {
    getProjectRunMetrics.mockResolvedValue({ success: true, data: sample });
    render(<DeliveryMetrics projectId="p1" />);
    const card = await screen.findByTestId('delivery-card-failed-before-work');
    expect(card).toHaveTextContent('3');
    expect(card.querySelector('.text-destructive')).not.toBeNull();
  });

  it('shows the empty state', async () => {
    getProjectRunMetrics.mockResolvedValue({ success: true, data: null });
    render(<DeliveryMetrics projectId="p1" />);
    expect(await screen.findByTestId('delivery-empty')).toBeInTheDocument();
  });

  it('shows an error state with retry', async () => {
    getProjectRunMetrics.mockResolvedValue({ success: false, error: 'boom' });
    render(<DeliveryMetrics projectId="p1" />);
    expect(await screen.findByTestId('delivery-error')).toBeInTheDocument();
    expect(screen.getByText('tasks:delivery.retry')).toBeInTheDocument();
  });
});
