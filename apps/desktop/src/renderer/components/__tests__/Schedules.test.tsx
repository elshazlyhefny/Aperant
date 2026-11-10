/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { RecurringSchedule } from '../../../shared/types/schedule';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts?.count !== undefined ? `${key}:${opts.count}` : key,
    i18n: { language: 'en' }
  })
}));

vi.mock('../ScheduleDialog', () => ({ ScheduleDialog: () => null }));

import { Schedules } from '../Schedules';
import { useScheduleStore } from '../../stores/schedule-store';

function makeSchedule(overrides: Partial<RecurringSchedule> = {}): RecurringSchedule {
  return {
    id: 's1',
    projectId: 'p1',
    name: 'Nightly audit',
    enabled: true,
    cadence: { kind: 'daily', time: '09:00' },
    template: { title: 'Audit deps', description: 'Check deps', tokenBudget: 1000 },
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: 2_000_000_000_000,
    history: [],
    ...overrides
  };
}

const api = {
  listSchedules: vi.fn(),
  setScheduleEnabled: vi.fn(),
  acknowledgeScheduleReports: vi.fn(),
  deleteSchedule: vi.fn()
};

describe('Schedules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useScheduleStore.setState({ schedules: [], activeProjectId: null, isLoading: false, error: null });
    (window as unknown as { electronAPI: unknown }).electronAPI = api;
  });

  it('shows the empty state with a new schedule button', async () => {
    api.listSchedules.mockResolvedValue({ success: true, data: [] });
    render(<Schedules projectId="p1" />);
    expect(await screen.findByText('schedules:empty.title')).toBeTruthy();
    expect(screen.getByText('schedules:buttons.new')).toBeTruthy();
  });

  it('renders a paused schedule with a resume action', async () => {
    api.listSchedules.mockResolvedValue({
      success: true,
      data: [makeSchedule({ enabled: false, nextRunAt: null })]
    });
    render(<Schedules projectId="p1" />);
    expect(await screen.findByText('Nightly audit')).toBeTruthy();
    expect(screen.getByText('schedules:status.paused')).toBeTruthy();
    expect(screen.getByText('schedules:buttons.resume')).toBeTruthy();
  });

  it('dismisses a missed-run banner', async () => {
    const schedule = makeSchedule({
      history: [{ id: 'r1', at: 5, kind: 'missed', missedCount: 3, acknowledged: false }]
    });
    api.listSchedules.mockResolvedValue({ success: true, data: [schedule] });
    api.acknowledgeScheduleReports.mockResolvedValue({
      success: true,
      data: { ...schedule, history: [{ ...schedule.history[0], acknowledged: true }] }
    });
    render(<Schedules projectId="p1" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByText('schedules:buttons.dismiss'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(api.acknowledgeScheduleReports).toHaveBeenCalledWith('s1', ['r1']);
  });
});
