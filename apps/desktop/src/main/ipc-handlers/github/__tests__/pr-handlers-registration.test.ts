import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../shared/constants';

const mockIpcMain = vi.hoisted(() => {
  class HoistedMockIpcMain {
    handlers = new Map<string, Function>();
    listeners = new Map<string, Function>();

    handle(channel: string, handler: Function): void {
      this.handlers.set(channel, handler);
    }

    on(channel: string, listener: Function): void {
      this.listeners.set(channel, listener);
    }

    async invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
      const handler = this.handlers.get(channel);
      if (!handler) {
        throw new Error(`No handler for channel: ${channel}`);
      }
      return handler({}, ...args);
    }

    reset(): void {
      this.handlers.clear();
      this.listeners.clear();
    }
  }

  return new HoistedMockIpcMain();
});

vi.mock('electron', () => ({
  ipcMain: mockIpcMain,
  BrowserWindow: vi.fn(),
  app: {
    getPath: vi.fn(() => '/tmp'),
    on: vi.fn(),
  },
}));

// No project resolves, so handlers fall through to their "no config" results
vi.mock('../utils/project-middleware', () => ({
  withProjectOrNull: async () => null,
}));

vi.mock('../../../pr-review-state-manager', () => ({
  PRReviewStateManager: class {
    handleAuthChange = vi.fn();
  },
}));

vi.mock('../../../services/pr-status-poller', () => ({
  getPRStatusPoller: vi.fn(() => ({ setMainWindowGetter: vi.fn(), startPolling: vi.fn(), stopPolling: vi.fn() })),
}));

vi.mock('../../../sentry', () => ({
  safeBreadcrumb: vi.fn(),
  safeCaptureException: vi.fn(),
}));

import { registerPRHandlers } from '../pr-handlers';

const EXPECTED_HANDLE_CHANNELS = [
  IPC_CHANNELS.GITHUB_PR_LIST,
  IPC_CHANNELS.GITHUB_PR_LIST_MORE,
  IPC_CHANNELS.GITHUB_PR_GET,
  IPC_CHANNELS.GITHUB_PR_GET_REVIEW,
  IPC_CHANNELS.GITHUB_PR_GET_REVIEWS_BATCH,
  IPC_CHANNELS.GITHUB_PR_GET_LOGS,
  IPC_CHANNELS.GITHUB_PR_POST_REVIEW,
  IPC_CHANNELS.GITHUB_PR_MARK_REVIEW_POSTED,
  IPC_CHANNELS.GITHUB_PR_POST_COMMENT,
  IPC_CHANNELS.GITHUB_PR_DELETE_REVIEW,
  IPC_CHANNELS.GITHUB_PR_MERGE,
  IPC_CHANNELS.GITHUB_PR_ASSIGN,
  IPC_CHANNELS.GITHUB_PR_REVIEW_CANCEL,
  IPC_CHANNELS.GITHUB_PR_CHECK_NEW_COMMITS,
  IPC_CHANNELS.GITHUB_PR_CHECK_MERGE_READINESS,
  IPC_CHANNELS.GITHUB_PR_UPDATE_BRANCH,
  IPC_CHANNELS.GITHUB_WORKFLOWS_AWAITING_APPROVAL,
  IPC_CHANNELS.GITHUB_PR_NOTIFY_EXTERNAL_REVIEW_COMPLETE,
  IPC_CHANNELS.GITHUB_WORKFLOW_APPROVE,
  IPC_CHANNELS.GITHUB_PR_STATUS_POLL_START,
  IPC_CHANNELS.GITHUB_PR_STATUS_POLL_STOP,
  IPC_CHANNELS.GITHUB_PR_STATUS_UPDATE,
];

const EXPECTED_ON_CHANNELS = [
  IPC_CHANNELS.GITHUB_AUTH_CHANGED,
  IPC_CHANNELS.GITHUB_PR_REVIEW,
  IPC_CHANNELS.GITHUB_PR_FOLLOWUP_REVIEW,
];

describe('registerPRHandlers registration', () => {
  beforeEach(() => {
    mockIpcMain.reset();
    registerPRHandlers(() => null);
  });

  it('registers exactly the expected ipcMain.handle channels', () => {
    expect([...mockIpcMain.handlers.keys()].sort()).toEqual([...EXPECTED_HANDLE_CHANNELS].sort());
    expect(EXPECTED_HANDLE_CHANNELS).toHaveLength(22);
  });

  it('registers exactly the expected ipcMain.on channels', () => {
    expect([...mockIpcMain.listeners.keys()].sort()).toEqual([...EXPECTED_ON_CHANNELS].sort());
    expect(EXPECTED_ON_CHANNELS).toHaveLength(3);
  });

  it('returns the empty list result when no project/GitHub config resolves', async () => {
    const result = await mockIpcMain.invokeHandler(IPC_CHANNELS.GITHUB_PR_LIST, 'project-1');
    expect(result).toEqual({ prs: [], hasNextPage: false, endCursor: null });
  });
});
