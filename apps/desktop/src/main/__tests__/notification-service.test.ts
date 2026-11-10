import { describe, it, expect, beforeEach, vi } from 'vitest';

const clickHandlers: Array<() => void> = [];

vi.mock('electron', () => {
  class MockNotification {
    static isSupported = vi.fn(() => true);
    on(event: string, handler: () => void): void {
      if (event === 'click') clickHandlers.push(handler);
    }
    show = vi.fn();
  }
  return { Notification: MockNotification, shell: { beep: vi.fn() } };
});

vi.mock('../project-store', () => ({
  projectStore: { getProjects: vi.fn(() => []) }
}));

import { notificationService } from '../notification-service';
import { IPC_CHANNELS } from '../../shared/constants';

function makeWindow(overrides: Record<string, unknown> = {}) {
  return {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: {
      isDestroyed: vi.fn(() => false),
      isLoading: vi.fn(() => false),
      once: vi.fn(),
      send: vi.fn()
    },
    ...overrides
  };
}

describe('notificationService click handling', () => {
  beforeEach(() => {
    clickHandlers.length = 0;
  });

  it('restores, focuses and sends NOTIFICATION_OPEN_TASK with ids', () => {
    const win = makeWindow();
    notificationService.initialize(() => win as never);
    notificationService.notifyTaskFailed('T', 'proj-1', 'task-1');
    clickHandlers[0]();

    expect(win.restore).toHaveBeenCalled();
    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(win.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.NOTIFICATION_OPEN_TASK, {
      projectId: 'proj-1',
      taskId: 'task-1'
    });
  });

  it('does not send when ids are missing', () => {
    const win = makeWindow();
    notificationService.initialize(() => win as never);
    notificationService.notifyTaskFailed('T', '', '');
    clickHandlers[0]();

    expect(win.focus).toHaveBeenCalled();
    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it('defers send until did-finish-load while the renderer is loading', () => {
    const win = makeWindow();
    win.webContents.isLoading.mockReturnValue(true);
    notificationService.initialize(() => win as never);
    notificationService.notifyTaskFailed('T', 'p', 't');
    clickHandlers[0]();

    expect(win.webContents.send).not.toHaveBeenCalled();
    expect(win.webContents.once).toHaveBeenCalledWith('did-finish-load', expect.any(Function));
  });

  it('does not throw when the window is null or destroyed', () => {
    notificationService.initialize(() => null);
    notificationService.notifyTaskFailed('T', 'p', 't');
    expect(() => clickHandlers[0]()).not.toThrow();

    const win = makeWindow({ isDestroyed: vi.fn(() => true) });
    notificationService.initialize(() => win as never);
    notificationService.notifyTaskFailed('T', 'p', 't');
    expect(() => clickHandlers[1]()).not.toThrow();
    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});
