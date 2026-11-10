/**
 * Schedule API
 *
 * zeenha fork: preload bridge for recurring task schedules.
 */

import { ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult } from '../../shared/types';
import type { RecurringSchedule, ScheduleInput } from '../../shared/types/schedule';

export interface ScheduleChangedEvent {
  projectId: string;
}

export interface ScheduleAPI {
  listSchedules: (projectId: string) => Promise<IPCResult<RecurringSchedule[]>>;
  createSchedule: (projectId: string, input: ScheduleInput) => Promise<IPCResult<RecurringSchedule>>;
  updateSchedule: (id: string, input: ScheduleInput) => Promise<IPCResult<RecurringSchedule>>;
  deleteSchedule: (id: string) => Promise<IPCResult>;
  setScheduleEnabled: (id: string, enabled: boolean) => Promise<IPCResult<RecurringSchedule>>;
  /** Acknowledge run reports; omit recordIds to acknowledge all. */
  acknowledgeScheduleReports: (scheduleId: string, recordIds?: string[]) => Promise<IPCResult<RecurringSchedule>>;
  /** Fired when schedules change in the main process. Returns an unsubscribe function. */
  onSchedulesChanged: (callback: (event: ScheduleChangedEvent) => void) => () => void;
}

export const createScheduleAPI = (): ScheduleAPI => ({
  listSchedules: (projectId: string): Promise<IPCResult<RecurringSchedule[]>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SCHEDULE_LIST, projectId),

  createSchedule: (projectId: string, input: ScheduleInput): Promise<IPCResult<RecurringSchedule>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SCHEDULE_CREATE, projectId, input),

  updateSchedule: (id: string, input: ScheduleInput): Promise<IPCResult<RecurringSchedule>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SCHEDULE_UPDATE, id, input),

  deleteSchedule: (id: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.SCHEDULE_DELETE, id),

  setScheduleEnabled: (id: string, enabled: boolean): Promise<IPCResult<RecurringSchedule>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SCHEDULE_SET_ENABLED, id, enabled),

  acknowledgeScheduleReports: (scheduleId: string, recordIds?: string[]): Promise<IPCResult<RecurringSchedule>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SCHEDULE_ACK_REPORTS, scheduleId, recordIds),

  onSchedulesChanged: (callback: (event: ScheduleChangedEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: ScheduleChangedEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.SCHEDULE_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SCHEDULE_CHANGED, handler);
  },
});
