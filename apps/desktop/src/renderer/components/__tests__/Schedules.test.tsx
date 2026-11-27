/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import type { RecurringSchedule } from '../../../shared/types/schedule';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts?.count !== undefined
        ? `${key}:${opts.count}`
        : opts?.title !== undefined
          ? `${key}:${opts.title}`
          : key,
    i18n: { language: 'en' }
  })
}));

vi.mock('../ScheduleDialog', () => ({ ScheduleDialog: () => null }));

import { Schedules } from '../Schedules';
import { countUnacknowledgedReports, useScheduleStore } from '../../stores/schedule-store';
import { useTaskStore } from '../../stores/task-store';

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
  deleteSchedule: vi.fn(),
  runScheduleNow: vi.fn()
};

describe('Schedules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useScheduleStore.setState({ schedules: [], activeProjectId: null, isLoading: false, error: null, loadError: null });
    useTaskStore.setState({ tasks: [] });
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

  it('shows catch-up as the missed-run policy for a legacy schedule', async () => {
    api.listSchedules.mockResolvedValue({ success: true, data: [makeSchedule()] });
    render(<Schedules projectId="p1" />);
    expect(await screen.findByText('schedules:missedPolicySummary.catch_up')).toBeTruthy();
  });

  it('shows intentional skips in history without an attention banner or sidebar report', async () => {
    api.listSchedules.mockResolvedValue({
      success: true,
      data: [
        makeSchedule({
          missedRunPolicy: 'skip',
          history: [{ id: 'r1', at: 5, kind: 'skipped_missed', missedCount: 3, acknowledged: false }]
        })
      ]
    });
    render(<Schedules projectId="p1" />);
    expect(await screen.findByText('schedules:missedPolicySummary.skip')).toBeTruthy();
    const historyHeading = screen.getByRole('heading', { name: 'schedules:history.title' });
    const skipped = screen.getByText(/schedules:history\.skipped_missed:3/, { selector: 'li' });
    expect(historyHeading.nextElementSibling).toBe(skipped.parentElement);
    expect(screen.queryByText(/schedules:history\.(missed|skipped_unfinished):/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(countUnacknowledgedReports(useScheduleStore.getState().schedules)).toBe(0);
  });

  it('runs a schedule now and shows the started notice', async () => {
    api.listSchedules.mockResolvedValue({ success: true, data: [makeSchedule()] });
    api.runScheduleNow.mockResolvedValue({ success: true, data: { started: true, taskId: 't1' } });
    render(<Schedules projectId="p1" />);
    fireEvent.click(await screen.findByText('schedules:buttons.runNow'));
    expect(await screen.findByText('schedules:runNow.started')).toBeTruthy();
    expect(api.runScheduleNow).toHaveBeenCalledWith('s1');
  });

  it('shows the unfinished notice when run now is skipped', async () => {
    api.listSchedules.mockResolvedValue({ success: true, data: [makeSchedule()] });
    api.runScheduleNow.mockResolvedValue({
      success: true,
      data: { started: false, reason: 'unfinished' }
    });
    render(<Schedules projectId="p1" />);
    fireEvent.click(await screen.findByText('schedules:buttons.runNow'));
    expect(await screen.findByText('schedules:runNow.unfinished')).toBeTruthy();
  });

  it('offers run now for a paused schedule', async () => {
    api.listSchedules.mockResolvedValue({
      success: true,
      data: [makeSchedule({ enabled: false, nextRunAt: null })]
    });
    render(<Schedules projectId="p1" />);
    expect(await screen.findByText('schedules:buttons.runNow')).toBeTruthy();
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

  const seedTasks = () =>
    useTaskStore.setState({
      tasks: [{ id: 'task-1', specId: '001-spec', title: 'Audit result' }] as never
    });

  it('shows the last task title as a button that opens it', async () => {
    seedTasks();
    const onOpenTask = vi.fn();
    api.listSchedules.mockResolvedValue({
      success: true,
      data: [makeSchedule({ lastTaskId: 'task-1' })]
    });
    render(<Schedules projectId="p1" onOpenTask={onOpenTask} />);
    fireEvent.click(await screen.findByRole('button', { name: 'schedules:lastTask:Audit result' }));
    expect(onOpenTask).toHaveBeenCalledWith('task-1');
  });

  it('matches the last task by specId', async () => {
    seedTasks();
    const onOpenTask = vi.fn();
    api.listSchedules.mockResolvedValue({
      success: true,
      data: [makeSchedule({ lastTaskId: '001-spec' })]
    });
    render(<Schedules projectId="p1" onOpenTask={onOpenTask} />);
    fireEvent.click(await screen.findByRole('button', { name: 'schedules:lastTask:Audit result' }));
    expect(onOpenTask).toHaveBeenCalledWith('001-spec');
  });

  it('disables the last task button when the task is missing', async () => {
    api.listSchedules.mockResolvedValue({
      success: true,
      data: [makeSchedule({ lastTaskId: 'gone' })]
    });
    render(<Schedules projectId="p1" onOpenTask={vi.fn()} />);
    const button = (await screen.findByRole('button', {
      name: 'schedules:lastTask:gone'
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toBe('schedules:lastTaskMissing');
  });

  it('shows Open task on skipped runs in the banner and history', async () => {
    seedTasks();
    const onOpenTask = vi.fn();
    api.listSchedules.mockResolvedValue({
      success: true,
      data: [
        makeSchedule({
          history: [
            { id: 'r1', at: 5, kind: 'skipped_unfinished', taskId: 'task-1', acknowledged: false }
          ]
        })
      ]
    });
    render(<Schedules projectId="p1" onOpenTask={onOpenTask} />);
    const buttons = await screen.findAllByRole('button', { name: 'schedules:buttons.openTask' });
    expect(buttons).toHaveLength(2);
    for (const b of buttons) fireEvent.click(b);
    expect(onOpenTask).toHaveBeenCalledTimes(2);
    expect(onOpenTask).toHaveBeenCalledWith('task-1');
  });

  it('shows no Open task button for missed records or records without a task', async () => {
    api.listSchedules.mockResolvedValue({
      success: true,
      data: [
        makeSchedule({
          history: [
            { id: 'r1', at: 5, kind: 'missed', missedCount: 2, taskId: 'task-1', acknowledged: false },
            { id: 'r2', at: 6, kind: 'skipped_unfinished', acknowledged: false }
          ]
        })
      ]
    });
    render(<Schedules projectId="p1" onOpenTask={vi.fn()} />);
    await screen.findByRole('alert');
    expect(screen.queryByText('schedules:buttons.openTask')).toBeNull();
  });

  it('shows a loading state while schedules load', async () => {
    api.listSchedules.mockReturnValue(new Promise(() => undefined));
    render(<Schedules projectId="p1" />);
    expect(await screen.findByText('schedules:loading')).toBeTruthy();
    expect(screen.queryByText('schedules:empty.title')).toBeNull();
  });

  it('shows a load failure with retry instead of the empty state', async () => {
    api.listSchedules.mockResolvedValueOnce({ success: false, error: 'boom' });
    render(<Schedules projectId="p1" />);
    expect(await screen.findByText('schedules:errors.loadFailed')).toBeTruthy();
    expect(screen.getByText('schedules:buttons.retry')).toBeTruthy();
    expect(screen.queryByText('schedules:empty.title')).toBeNull();

    api.listSchedules.mockResolvedValueOnce({ success: true, data: [] });
    fireEvent.click(screen.getByText('schedules:buttons.retry'));
    expect(await screen.findByText('schedules:empty.title')).toBeTruthy();
    expect(api.listSchedules).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('schedules:errors.loadFailed')).toBeNull();
  });

  it('shows a load failure when listing rejects', async () => {
    api.listSchedules.mockRejectedValueOnce(new Error('ipc down'));
    render(<Schedules projectId="p1" />);
    expect(await screen.findByText('schedules:errors.loadFailed')).toBeTruthy();
    expect(screen.queryByText('schedules:empty.title')).toBeNull();
  });

  it('keeps the delete dialog open and shows an error when delete fails', async () => {
    api.listSchedules.mockResolvedValue({ success: true, data: [makeSchedule()] });
    api.deleteSchedule.mockResolvedValue({ success: false, error: 'x' });
    render(<Schedules projectId="p1" />);
    fireEvent.click(await screen.findByText('schedules:buttons.delete'));
    expect(await screen.findByText('schedules:delete.title')).toBeTruthy();
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByText('schedules:buttons.delete'));
    expect(await within(dialog).findByText('schedules:errors.deleteFailed')).toBeTruthy();
    expect(screen.getByText('schedules:delete.title')).toBeTruthy();
    expect(screen.getByText('Nightly audit')).toBeTruthy();
  });

  it('closes the delete dialog when delete succeeds', async () => {
    api.listSchedules.mockResolvedValue({ success: true, data: [makeSchedule()] });
    api.deleteSchedule.mockResolvedValue({ success: true });
    render(<Schedules projectId="p1" />);
    fireEvent.click(await screen.findByText('schedules:buttons.delete'));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByText('schedules:buttons.delete'));
    await waitFor(() => expect(screen.queryByText('schedules:delete.title')).toBeNull());
    expect(api.deleteSchedule).toHaveBeenCalledWith('s1');
  });

  it('shows an error when pausing a schedule fails', async () => {
    api.listSchedules.mockResolvedValue({ success: true, data: [makeSchedule()] });
    api.setScheduleEnabled.mockResolvedValue({ success: false });
    render(<Schedules projectId="p1" />);
    fireEvent.click(await screen.findByText('schedules:buttons.pause'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('schedules:errors.actionFailed');
    expect(screen.getByText('Nightly audit')).toBeTruthy();
  });

  it('shows an error when dismissing a missed-run banner fails', async () => {
    const schedule = makeSchedule({
      history: [{ id: 'r1', at: 5, kind: 'missed', missedCount: 3, acknowledged: false }]
    });
    api.listSchedules.mockResolvedValue({ success: true, data: [schedule] });
    api.acknowledgeScheduleReports.mockResolvedValue({ success: false });
    render(<Schedules projectId="p1" />);
    fireEvent.click(await screen.findByText('schedules:buttons.dismiss'));
    expect(await screen.findByText('schedules:errors.actionFailed')).toBeTruthy();
  });

  it('does not show the load-error screen for a save error', async () => {
    api.listSchedules.mockResolvedValue({ success: true, data: [] });
    render(<Schedules projectId="p1" />);
    expect(await screen.findByText('schedules:empty.title')).toBeTruthy();
    act(() => {
      useScheduleStore.setState({ error: 'save failed' });
    });
    expect(screen.queryByText('schedules:errors.loadFailed')).toBeNull();
    expect(screen.getByText('schedules:empty.title')).toBeTruthy();
  });
});
