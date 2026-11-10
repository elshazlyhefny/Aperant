import { IPC_CHANNELS } from '../../shared/constants';
import { createIpcListener, IpcListenerCleanup } from './modules/ipc-utils';

export interface NotificationOpenTarget {
  projectId: string;
  taskId: string;
}

/**
 * Desktop notification API (main -> renderer events)
 */
export interface NotificationAPI {
  onNotificationOpenTask: (
    callback: (target: NotificationOpenTarget) => void
  ) => IpcListenerCleanup;
}

export const createNotificationAPI = (): NotificationAPI => ({
  onNotificationOpenTask: (
    callback: (target: NotificationOpenTarget) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.NOTIFICATION_OPEN_TASK, callback)
});
