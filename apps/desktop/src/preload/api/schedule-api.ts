/**
 * Schedule API
 *
 * zeenha fork: preload bridge for recurring task schedules.
 */

import { ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult } from '../../shared/types';
import type { RecurringSchedule, ScheduleInput, ScheduleRunNowResult } from '../../shared/types/schedule';

export interface ScheduleChangedEvent {
  projectId: string;
}

export interface ScheduleAPI {
  listSchedules: (projectId: string) => Promise<IPCResult<RecurringSchedule[]>>;
  createSchedule: (projectId: string, input: ScheduleInput) => Promise<IPCResult<RecurringSchedule>>;
  // zeenha fork: by-ID calls name the caller's project; main rejects a schedule of another project.
  updateSchedule: (projectId: string, id: string, input: ScheduleInput) => Promise<IPCResult<RecurringSchedule>>;
  deleteSchedule: (projectId: string, id: string) => Promise<IPCResult>;
  setScheduleEnabled: (projectId: string, id: string, enabled: boolean) => Promise<IPCResult<RecurringSchedule>>;
  /** Acknowledge run reports; omit recordIds to acknowledge all. */
  acknowledgeScheduleReports: (
    projectId: string,
    scheduleId: string,
    recordIds?: string[]
  ) => Promise<IPCResult<RecurringSchedule>>;
  /** Start the schedule's task now, without changing its next run or paused state. */
  runScheduleNow: (projectId: string, id: string) => Promise<IPCResult<ScheduleRunNowResult>>;
  /** Fired when schedules change in the main process. Returns an unsubscribe function. */
  onSchedulesChanged: (callback: (event: ScheduleChangedEvent) => void) => () => void;
}

export const createScheduleAPI = (): ScheduleAPI => ({
  listSchedules: (projectId: string): Promise<IPCResult<RecurringSchedule[]>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SCHEDULE_LIST, projectId),

  createSchedule: (projectId: string, input: ScheduleInput): Promise<IPCResult<RecurringSchedule>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SCHEDULE_CREATE, projectId, input),

  updateSchedule: (projectId: string, id: string, input: ScheduleInput): Promise<IPCResult<RecurringSchedule>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SCHEDULE_UPDATE, projectId, id, input),

  deleteSchedule: (projectId: string, id: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.SCHEDULE_DELETE, projectId, id),

  setScheduleEnabled: (projectId: string, id: string, enabled: boolean): Promise<IPCResult<RecurringSchedule>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SCHEDULE_SET_ENABLED, projectId, id, enabled),

  acknowledgeScheduleReports: (
    projectId: string,
    scheduleId: string,
    recordIds?: string[]
  ): Promise<IPCResult<RecurringSchedule>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SCHEDULE_ACK_REPORTS, projectId, scheduleId, recordIds),

  runScheduleNow: (projectId: string, id: string): Promise<IPCResult<ScheduleRunNowResult>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SCHEDULE_RUN_NOW, projectId, id),

  onSchedulesChanged: (callback: (event: ScheduleChangedEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: ScheduleChangedEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.SCHEDULE_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SCHEDULE_CHANGED, handler);
  },
});
