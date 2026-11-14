/**
 * zeenha fork: IPC handlers for recurring task schedules. They validate input,
 * persist through schedule-store and build the real ScheduleService that the
 * app starts at launch.
 */
import { randomUUID } from 'node:crypto';
import { ipcMain, type BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult } from '../../shared/types';
import type { RecurringSchedule, ScheduleInput, ScheduleRunNowResult } from '../../shared/types/schedule';
import { computeNextRun, validateCadence } from '../../shared/utils/schedule-time';
import type { AgentManager } from '../agent/agent-manager';
import { ensureQueueLock } from '../desktop-queue-lock';
import { projectStore } from '../project-store';
import { createScheduleService, readTaskTokensFromDisk, type ScheduleService } from '../schedule-service';
import * as scheduleStore from '../schedule-store';
import { createTaskSpec } from './task/create-task';
import { applyTaskStatusUpdate, stopTask } from './task/execution-handlers';

function fail<T = never>(error: unknown): IPCResult<T> {
  return { success: false, error: error instanceof Error ? error.message : String(error) };
}

/** Returns an error message, or null when the input is valid. */
function validateInput(input: ScheduleInput): string | null {
  if (!input || typeof input !== 'object') return 'Invalid schedule';
  if (typeof input.name !== 'string' || !input.name.trim()) return 'Name is required';
  const template = input.template;
  if (!template || typeof template !== 'object') return 'Task template is required';
  if (typeof template.title !== 'string' || !template.title.trim()) return 'Task title is required';
  if (typeof template.description !== 'string' || !template.description.trim()) return 'Task description is required';
  if (!Number.isInteger(template.tokenBudget) || template.tokenBudget <= 0) {
    return 'Token budget must be a positive whole number';
  }
  if (!input.cadence || typeof input.cadence !== 'object') return 'Cadence is required';
  const cadence = validateCadence(input.cadence);
  if (!cadence.ok) return cadence.reason;
  return null;
}

export function registerScheduleHandlers(
  agentManager: AgentManager,
  getMainWindow: () => BrowserWindow | null
): ScheduleService {
  const notifyChanged = (projectId: string): void => {
    try {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.SCHEDULE_CHANGED, { projectId });
      }
    } catch {
      // The window may be closing
    }
  };

  const service = createScheduleService({
    now: () => Date.now(),
    listSchedules: () => scheduleStore.listSchedules(),
    saveSchedule: (schedule) => {
      scheduleStore.saveSchedule(schedule);
    },
    getProject: (projectId) => projectStore.getProject(projectId),
    listTasks: (projectId) => projectStore.getTasks(projectId),
    createTask: async (projectId, template, scheduleId, scheduledFor) => {
      const created = await createTaskSpec(projectId, template.title, template.description, {
        sourceType: 'schedule',
        scheduleId,
        scheduledFor,
        tokenBudget: template.tokenBudget,
        ...(template.category ? { category: template.category } : {}),
        ...(template.model ? { model: template.model } : {}),
        ...(template.thinkingLevel ? { thinkingLevel: template.thinkingLevel } : {}),
      });
      if (!created.success || !created.data) throw new Error(created.error ?? 'Failed to create task');
      const queued = await applyTaskStatusUpdate(agentManager, getMainWindow, created.data.id, 'queue');
      if (!queued.success) throw new Error(queued.error ?? 'Failed to queue task');
      projectStore.invalidateTasksCache(projectId);
      return created.data.id;
    },
    startTask: async (taskId) => {
      const result = await applyTaskStatusUpdate(agentManager, getMainWindow, taskId, 'in_progress');
      if (!result.success) throw new Error(result.error ?? 'Failed to start task');
    },
    isRunning: (taskId) => agentManager.isRunning(taskId),
    notifyChanged,
    readTaskTokens: (projectId, specId) => {
      const project = projectStore.getProject(projectId);
      return project ? readTaskTokensFromDisk(project, specId) : 0;
    },
    stopTask: (taskId) => stopTask(agentManager, taskId),
    canRun: (projectId) => {
      const project = projectStore.getProject(projectId);
      return project ? ensureQueueLock(project).ok : true;
    },
  });

  ipcMain.handle(
    IPC_CHANNELS.SCHEDULE_LIST,
    async (_event, projectId: string): Promise<IPCResult<RecurringSchedule[]>> => {
      try {
        // Schedules of a removed project are dropped from the list
        if (!projectStore.getProject(projectId)) return { success: true, data: [] };
        return { success: true, data: scheduleStore.listSchedules(projectId) };
      } catch (error) {
        return fail(error);
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SCHEDULE_CREATE,
    async (_event, projectId: string, input: ScheduleInput): Promise<IPCResult<RecurringSchedule>> => {
      try {
        if (!projectStore.getProject(projectId)) return { success: false, error: 'Project not found' };
        const invalid = validateInput(input);
        if (invalid) return { success: false, error: invalid };
        const now = Date.now();
        const enabled = input.enabled !== false;
        const schedule: RecurringSchedule = {
          id: randomUUID(),
          projectId,
          name: input.name.trim(),
          enabled,
          cadence: input.cadence,
          template: { ...input.template, title: input.template.title.trim() },
          createdAt: now,
          updatedAt: now,
          nextRunAt: enabled ? computeNextRun(input.cadence, now) : null,
          history: [],
        };
        const saved = scheduleStore.saveSchedule(schedule);
        notifyChanged(projectId);
        return { success: true, data: saved };
      } catch (error) {
        return fail(error);
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SCHEDULE_UPDATE,
    async (_event, id: string, input: ScheduleInput): Promise<IPCResult<RecurringSchedule>> => {
      try {
        const existing = scheduleStore.getSchedule(id);
        if (!existing) return { success: false, error: 'Schedule not found' };
        const invalid = validateInput(input);
        if (invalid) return { success: false, error: invalid };
        const now = Date.now();
        const updated: RecurringSchedule = {
          ...existing,
          name: input.name.trim(),
          cadence: input.cadence,
          template: { ...input.template, title: input.template.title.trim() },
          updatedAt: now,
          nextRunAt: existing.enabled ? computeNextRun(input.cadence, now) : null,
        };
        const saved = scheduleStore.saveSchedule(updated);
        notifyChanged(existing.projectId);
        return { success: true, data: saved };
      } catch (error) {
        return fail(error);
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.SCHEDULE_DELETE, async (_event, id: string): Promise<IPCResult> => {
    try {
      const existing = scheduleStore.getSchedule(id);
      if (!existing) return { success: false, error: 'Schedule not found' };
      // Only the schedule is removed; tasks it already created are untouched
      scheduleStore.removeSchedule(id);
      notifyChanged(existing.projectId);
      return { success: true };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.SCHEDULE_SET_ENABLED,
    async (_event, id: string, enabled: boolean): Promise<IPCResult<RecurringSchedule>> => {
      try {
        const existing = scheduleStore.getSchedule(id);
        if (!existing) return { success: false, error: 'Schedule not found' };
        // Pausing clears nextRunAt; resuming counts from now so the paused
        // period is never reported as missed.
        const updated: RecurringSchedule = {
          ...existing,
          enabled,
          updatedAt: Date.now(),
          nextRunAt: enabled ? computeNextRun(existing.cadence, Date.now()) : null,
        };
        const saved = scheduleStore.saveSchedule(updated);
        notifyChanged(existing.projectId);
        return { success: true, data: saved };
      } catch (error) {
        return fail(error);
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SCHEDULE_ACK_REPORTS,
    async (_event, scheduleId: string, recordIds?: string[]): Promise<IPCResult<RecurringSchedule>> => {
      try {
        const existing = scheduleStore.getSchedule(scheduleId);
        if (!existing) return { success: false, error: 'Schedule not found' };
        const ids = recordIds ? new Set(recordIds) : null;
        const updated: RecurringSchedule = {
          ...existing,
          history: existing.history.map((r) => (!ids || ids.has(r.id) ? { ...r, acknowledged: true } : r)),
        };
        const saved = scheduleStore.saveSchedule(updated);
        notifyChanged(existing.projectId);
        return { success: true, data: saved };
      } catch (error) {
        return fail(error);
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SCHEDULE_RUN_NOW,
    async (_event, id: string): Promise<IPCResult<ScheduleRunNowResult>> => {
      try {
        if (typeof id !== 'string' || !id) return { success: false, error: 'Schedule not found' };
        if (!scheduleStore.getSchedule(id)) return { success: false, error: 'Schedule not found' };
        // The service saves the schedule and notifies the renderer itself
        const result = await service.runNow(id);
        if (result.reason === 'not_found') return { success: false, error: 'Schedule not found' };
        return { success: true, data: result };
      } catch (error) {
        return fail(error);
      }
    }
  );

  return service;
}
