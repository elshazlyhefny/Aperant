/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' }
  })
}));

import { ScheduleDialog } from '../ScheduleDialog';
import { useScheduleStore } from '../../stores/schedule-store';

const createSchedule = vi.fn();

function renderDialog() {
  return render(<ScheduleDialog open onOpenChange={vi.fn()} projectId="p1" />);
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
      updateSchedule: vi.fn()
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
