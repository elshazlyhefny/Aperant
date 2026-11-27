/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { RecurringSchedule } from '../../../shared/types/schedule';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' }
  })
}));

import { ScheduleDialog } from '../ScheduleDialog';
import { useScheduleStore } from '../../stores/schedule-store';

const createSchedule = vi.fn();
const updateSchedule = vi.fn();

const skipSchedule: RecurringSchedule = {
  id: 's1',
  projectId: 'p1',
  name: 'Nightly audit',
  enabled: true,
  cadence: { kind: 'daily', time: '09:00' },
  template: { title: 'Audit deps', description: 'Check deps', tokenBudget: 1000 },
  missedRunPolicy: 'skip',
  createdAt: 1,
  updatedAt: 1,
  nextRunAt: 2_000_000_000_000,
  history: []
};

function renderDialog(schedule?: RecurringSchedule) {
  const onOpenChange = vi.fn();
  render(<ScheduleDialog open onOpenChange={onOpenChange} projectId="p1" schedule={schedule} />);
  return onOpenChange;
}

const byId = (id: string) => document.getElementById(id) as HTMLInputElement;
const save = () => fireEvent.click(screen.getByText('common:buttons.save'));
const type = (id: string, value: string) => fireEvent.change(byId(id), { target: { value } });

function fillText() {
  type('schedule-name', 'Name');
  type('schedule-task-title', 'Title');
  type('schedule-task-description', 'Desc');
}

describe('ScheduleDialog accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createSchedule.mockResolvedValue(null);
    useScheduleStore.setState({
      schedules: [],
      activeProjectId: null,
      isLoading: false,
      error: null,
      createSchedule,
      updateSchedule
    });
  });

  it('shows an alert and focuses the name input when the form is empty', async () => {
    renderDialog();
    save();
    const alert = await screen.findByRole('alert');
    expect(alert.id).toBe('schedule-error');
    expect(alert.textContent).toContain('schedules:validation.nameRequired');
    const name = byId('schedule-name');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(name.getAttribute('aria-describedby')).toContain('schedule-error');
    expect(document.activeElement).toBe(name);
  });

  it('focuses title then description as they become the first invalid field', () => {
    renderDialog();
    type('schedule-name', 'Name');
    save();
    expect(document.activeElement).toBe(byId('schedule-task-title'));
    type('schedule-task-title', 'Title');
    save();
    expect(document.activeElement).toBe(byId('schedule-task-description'));
  });

  it('focuses the interval input and links hint and error', () => {
    renderDialog();
    fillText();
    fireEvent.click(screen.getByText('schedules:form.cadenceCustom'));
    type('schedule-interval', '1');
    save();
    const interval = byId('schedule-interval');
    expect(document.activeElement).toBe(interval);
    const described = interval.getAttribute('aria-describedby') ?? '';
    expect(described).toContain('schedule-interval-hint');
    expect(described).toContain('schedule-error');
  });

  it('reports no weekdays and focuses the weekdays group', () => {
    renderDialog();
    fillText();
    fireEvent.click(screen.getByText('schedules:form.cadenceWeekly'));
    fireEvent.click(screen.getByText('schedules:weekdays.1'));
    save();
    expect(screen.getByRole('alert').textContent).toContain('schedules:validation.noDays');
    expect(document.activeElement).toBe(screen.getByRole('group', { name: 'schedules:form.weekdays' }));
  });

  it('focuses the budget input for an invalid token budget', () => {
    renderDialog();
    fillText();
    type('schedule-token-budget', '0');
    save();
    const budget = byId('schedule-token-budget');
    expect(document.activeElement).toBe(budget);
    expect(budget.getAttribute('aria-describedby')).toContain('schedule-budget-hint');
  });

  it('exposes pressed state and labelled groups for cadence and weekdays', () => {
    renderDialog();
    const cadence = screen.getByRole('group', { name: 'schedules:form.cadence' });
    const pressed = (label: string) =>
      screen.getByText(label).getAttribute('aria-pressed');
    expect(cadence).toBeTruthy();
    expect(pressed('schedules:form.cadenceDaily')).toBe('true');
    expect(pressed('schedules:form.cadenceWeekly')).toBe('false');
    expect(pressed('schedules:form.cadenceCustom')).toBe('false');
    fireEvent.click(screen.getByText('schedules:form.cadenceWeekly'));
    expect(pressed('schedules:form.cadenceWeekly')).toBe('true');
    expect(pressed('schedules:form.cadenceDaily')).toBe('false');
    expect(screen.getByRole('group', { name: 'schedules:form.weekdays' })).toBeTruthy();
  });

  it('defaults to catch-up and saves skip when selected', async () => {
    createSchedule.mockResolvedValue(skipSchedule);
    const onOpenChange = renderDialog();
    const group = screen.getByRole('group', { name: 'schedules:form.missedRuns' });
    const catchUp = within(group).getByRole('button', { name: 'schedules:form.missedRunsCatchUp' });
    const skip = within(group).getByRole('button', { name: 'schedules:form.missedRunsSkip' });
    expect(group.getAttribute('aria-describedby')).toBe('schedule-missed-policy-hint');
    expect(screen.getByText('schedules:form.missedRunsHint').id).toBe('schedule-missed-policy-hint');
    expect(catchUp.getAttribute('aria-pressed')).toBe('true');
    expect(skip.getAttribute('aria-pressed')).toBe('false');

    fillText();
    fireEvent.click(skip);
    expect(catchUp.getAttribute('aria-pressed')).toBe('false');
    expect(skip.getAttribute('aria-pressed')).toBe('true');
    save();
    expect(createSchedule).toHaveBeenCalledWith('p1', expect.objectContaining({ missedRunPolicy: 'skip' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('loads the saved skip policy when editing and allows switching back to catch-up', async () => {
    updateSchedule.mockResolvedValue({ ...skipSchedule, missedRunPolicy: 'catch_up' });
    const onOpenChange = renderDialog(skipSchedule);
    expect(screen.getByRole('button', { name: 'schedules:form.missedRunsSkip', pressed: true })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'schedules:form.missedRunsCatchUp', pressed: false }));
    save();
    expect(updateSchedule).toHaveBeenCalledWith('s1', expect.objectContaining({ missedRunPolicy: 'catch_up' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('renders the store save error in the same alert element', async () => {
    createSchedule.mockImplementation(async () => {
      useScheduleStore.setState({ error: 'boom' });
      return null;
    });
    renderDialog();
    fillText();
    save();
    const alert = await screen.findByText('boom');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.id).toBe('schedule-error');
  });
});
