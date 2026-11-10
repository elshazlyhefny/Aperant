import { Notification, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { projectStore } from './project-store';
import { IPC_CHANNELS } from '../shared/constants';

export type NotificationType = 'task-complete' | 'task-failed' | 'review-needed';

interface NotificationOptions {
  title: string;
  body: string;
  projectId?: string;
  taskId?: string;
}

/**
 * Service for sending system notifications with optional sound
 */
class NotificationService {
  private mainWindow: (() => BrowserWindow | null) | null = null;

  /**
   * Initialize the notification service with the main window getter
   */
  initialize(getMainWindow: () => BrowserWindow | null): void {
    this.mainWindow = getMainWindow;
  }

  /**
   * Send a notification for task completion
   */
  notifyTaskComplete(taskTitle: string, projectId: string, taskId: string): void {
    this.sendNotification('task-complete', {
      title: 'Task Complete',
      body: `"${taskTitle}" has completed and is ready for review`,
      projectId,
      taskId
    });
  }

  /**
   * Send a notification for task failure
   */
  notifyTaskFailed(taskTitle: string, projectId: string, taskId: string): void {
    this.sendNotification('task-failed', {
      title: 'Task Failed',
      body: `"${taskTitle}" encountered an error`,
      projectId,
      taskId
    });
  }

  /**
   * Send a notification for review needed
   */
  notifyReviewNeeded(taskTitle: string, projectId: string, taskId: string): void {
    this.sendNotification('review-needed', {
      title: 'Review Needed',
      body: `"${taskTitle}" is ready for your review`,
      projectId,
      taskId
    });
  }

  /**
   * Send a system notification with optional sound
   */
  private sendNotification(type: NotificationType, options: NotificationOptions): void {
    // Get notification settings
    const settings = this.getNotificationSettings(options.projectId);

    // Check if this notification type is enabled
    if (!this.isNotificationEnabled(type, settings)) {
      return;
    }

    // Create and show the notification
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: options.title,
        body: options.body,
        silent: !settings.sound // Let the OS handle sound if enabled
      });

      // Focus window when notification is clicked
      notification.on('click', () => {
        this.handleClick(options);
      });

      notification.show();
    }

    // Play sound if enabled (system beep)
    if (settings.sound) {
      this.playNotificationSound();
    }
  }

  /**
   * Restore and focus the window, then ask the renderer to open the task
   */
  private handleClick(options: NotificationOptions): void {
    try {
      const window = this.mainWindow?.();
      if (!window || window.isDestroyed()) {
        return;
      }
      if (window.isMinimized()) {
        window.restore();
      }
      window.show();
      window.focus();

      const { projectId, taskId } = options;
      if (!projectId || !taskId) {
        return;
      }
      const target = { projectId, taskId };
      const webContents = window.webContents;
      if (!webContents || webContents.isDestroyed()) {
        return;
      }
      if (webContents.isLoading()) {
        // Renderer still loading: deliver once it has finished
        webContents.once('did-finish-load', () => {
          if (!webContents.isDestroyed()) {
            webContents.send(IPC_CHANNELS.NOTIFICATION_OPEN_TASK, target);
          }
        });
      } else {
        webContents.send(IPC_CHANNELS.NOTIFICATION_OPEN_TASK, target);
      }
    } catch (error) {
      console.warn('[NotificationService] Failed to handle notification click:', error);
    }
  }

  /**
   * Play a notification sound
   */
  private playNotificationSound(): void {
    // Use system beep - works across all platforms
    shell.beep();
  }

  /**
   * Get notification settings for a project or fall back to defaults
   */
  private getNotificationSettings(projectId?: string): {
    onTaskComplete: boolean;
    onTaskFailed: boolean;
    onReviewNeeded: boolean;
    sound: boolean;
  } {
    // Try to get project-specific settings
    if (projectId) {
      const projects = projectStore.getProjects();
      const project = projects.find(p => p.id === projectId);
      if (project?.settings?.notifications) {
        return project.settings.notifications;
      }
    }

    // Fall back to defaults
    return {
      onTaskComplete: true,
      onTaskFailed: true,
      onReviewNeeded: true,
      sound: false
    };
  }

  /**
   * Check if a notification type is enabled in settings
   */
  private isNotificationEnabled(
    type: NotificationType,
    settings: {
      onTaskComplete: boolean;
      onTaskFailed: boolean;
      onReviewNeeded: boolean;
      sound: boolean;
    }
  ): boolean {
    switch (type) {
      case 'task-complete':
        return settings.onTaskComplete;
      case 'task-failed':
        return settings.onTaskFailed;
      case 'review-needed':
        return settings.onReviewNeeded;
      default:
        return false;
    }
  }
}

// Export singleton instance
export const notificationService = new NotificationService();
