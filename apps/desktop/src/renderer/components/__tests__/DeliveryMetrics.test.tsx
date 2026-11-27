/**
 * @vitest-environment jsdom
 *
 * zeenha fork: the project Delivery view renders project-wide run metrics.
 */
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}|${Object.entries(opts).map(([k, v]) => `${k}=${v}`).join(',')}` : key,
    i18n: { language: 'en' }
  })
}));

import type { DeliveryTimingStats, ProjectDeliveryTiming } from '../../../shared/types/run-metrics';
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

const timing: ProjectDeliveryTiming = {
  eligibleTasks: 9,
  measuredTasks: 3,
  coverage: 3 / 9,
  unknown: { missing: 2, corrupt: 1, incomplete: 3 },
  queueToReviewReady: { medianMs: 184000, p90Ms: 300000, samples: 3 },
  segments: {
    queuedMs: { medianMs: 10000, p90Ms: 20000, samples: 3 },
    activeMs: { medianMs: 120000, p90Ms: 180000, samples: 3 },
    credentialPauseMs: { medianMs: 0, p90Ms: 45000, samples: 3 },
    budgetPauseMs: { medianMs: 0, p90Ms: 30000, samples: 3 },
    otherMs: { medianMs: 54000, p90Ms: 60000, samples: 3 }
  }
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
    const formatted = new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date('2026-01-01T00:00:00'));
    expect(screen.getByTestId('delivery-trend')).toHaveTextContent(formatted);
    expect(screen.getByTestId('delivery-note')).toBeInTheDocument();
    expect(screen.queryByTestId('delivery-timing')).not.toBeInTheDocument();
  });

  it('renders timing percentiles, sample counts and coverage, even without run metrics', async () => {
    getProjectRunMetrics.mockResolvedValue({
      success: true,
      data: { ...sample, included: 0, completedTasks: 0, deliveryTiming: timing }
    });
    render(<DeliveryMetrics projectId="p1" />);
    await screen.findByTestId('delivery-timing');
    expect(screen.queryByTestId('delivery-empty')).not.toBeInTheDocument();
    const coverage = screen.getByTestId('delivery-timing-coverage');
    expect(coverage).toHaveTextContent('measured=3,eligible=9,percent=33.3%');
    expect(coverage).toHaveTextContent('missing=2,corrupt=1,incomplete=3');
    expect(screen.getByTestId('delivery-timing-note')).toHaveTextContent('tasks:delivery.timing.note');

    const expected = [
      ['queueToReviewReady', '3m 4s', '5m 0s'],
      ['queued', '10s', '20s'],
      ['active', '2m 0s', '3m 0s'],
      ['credentialPause', '0ms', '45s'],
      ['budgetPause', '0ms', '30s'],
      ['other', '54s', '1m 0s']
    ];
    for (const [key, median, p90] of expected) {
      const row = within(screen.getByTestId(`delivery-timing-row-${key}`));
      expect(row.getByRole('rowheader')).toHaveTextContent(`tasks:delivery.timing.metrics.${key}`);
      expect(row.getAllByRole('cell').map((cell) => cell.textContent)).toEqual([median, p90, '3']);
    }
  });

  it('updates timing on period change and shows dashes for unknown percentiles and coverage', async () => {
    const unknownStats: DeliveryTimingStats = { medianMs: null, p90Ms: null, samples: 0 };
    const noTimingSamples: ProjectDeliveryTiming = {
      eligibleTasks: 0,
      measuredTasks: 0,
      coverage: null,
      unknown: { missing: 0, corrupt: 0, incomplete: 0 },
      queueToReviewReady: unknownStats,
      segments: {
        queuedMs: unknownStats,
        activeMs: unknownStats,
        credentialPauseMs: unknownStats,
        budgetPauseMs: unknownStats,
        otherMs: unknownStats
      }
    };
    getProjectRunMetrics
      .mockResolvedValueOnce({ success: true, data: { ...sample, deliveryTiming: timing } })
      .mockResolvedValueOnce({ success: true, data: { ...sample, periodDays: 7, deliveryTiming: noTimingSamples } });
    render(<DeliveryMetrics projectId="p1" />);
    const coverage = await screen.findByTestId('delivery-timing-coverage');
    expect(coverage).toHaveTextContent('percent=33.3%');

    fireEvent.change(screen.getByTestId('delivery-period'), { target: { value: '7' } });
    await waitFor(() => expect(coverage).toHaveTextContent('measured=0,eligible=0,percent=—'));
    expect(getProjectRunMetrics).toHaveBeenLastCalledWith('p1', 7);
    const rows = within(screen.getByTestId('delivery-timing')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(within(row).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['—', '—', '0']);
    }
  });

  it('lists failed tasks, falling back to specId, and opens one on click', async () => {
    const onOpenTask = vi.fn();
    getProjectRunMetrics.mockResolvedValue({
      success: true,
      data: {
        ...sample,
        failedBeforeWork: { count: 2, tasks: [{ specId: '001-a', title: 'Alpha' }, { specId: '002-b' }] }
      }
    });
    render(<DeliveryMetrics projectId="p1" onOpenTask={onOpenTask} />);
    const section = await screen.findByTestId('delivery-failed');
    expect(section).toHaveTextContent('Alpha');
    expect(section).toHaveTextContent('002-b');
    const rows = screen.getAllByTestId('delivery-failed-task');
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[0]);
    expect(onOpenTask).toHaveBeenCalledWith('001-a');
    expect(screen.queryByTestId('delivery-failed-truncated')).not.toBeInTheDocument();
  });

  it('renders no failed list when tasks is missing or empty', async () => {
    getProjectRunMetrics.mockResolvedValue({ success: true, data: sample });
    const { unmount } = render(<DeliveryMetrics projectId="p1" />);
    await screen.findByTestId('delivery-cards');
    expect(screen.queryByTestId('delivery-failed')).not.toBeInTheDocument();
    unmount();

    getProjectRunMetrics.mockResolvedValue({
      success: true,
      data: { ...sample, failedBeforeWork: { count: 3, tasks: [] } }
    });
    render(<DeliveryMetrics projectId="p1" />);
    await screen.findByTestId('delivery-cards');
    expect(screen.queryByTestId('delivery-failed')).not.toBeInTheDocument();
  });

  it('shows the truncation note only when count exceeds the listed tasks', async () => {
    getProjectRunMetrics.mockResolvedValue({
      success: true,
      data: { ...sample, failedBeforeWork: { count: 60, tasks: [{ specId: '001-a' }] } }
    });
    render(<DeliveryMetrics projectId="p1" />);
    const note = await screen.findByTestId('delivery-failed-truncated');
    expect(note).toHaveTextContent('shown=1');
    expect(note).toHaveTextContent('count=60');
  });

  it('uses phase translation keys with the raw key as fallback', async () => {
    getProjectRunMetrics.mockResolvedValue({
      success: true,
      data: {
        ...sample,
        byPhase: [...sample.byPhase, { ...sample.byPhase[0], key: 'unknown' }]
      }
    });
    render(<DeliveryMetrics projectId="p1" />);
    await screen.findByTestId('delivery-cards');
    const phase = screen.getByTestId('delivery-by-phase');
    expect(phase).toHaveTextContent('tasks:delivery.phases.coding');
    expect(phase).toHaveTextContent('defaultValue=unknown');
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
