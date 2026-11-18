import { describe, it, expect, vi, beforeEach } from 'vitest';

const { handle, on } = vi.hoisted(() => ({ handle: vi.fn(), on: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle, on }, app: { getPath: () => '/tmp' } }));

import { IPC_CHANNELS } from '../../../../shared/constants/ipc';
import { registerAzureDevOpsHandlers } from '../index';

const HANDLE_CHANNELS = [
  IPC_CHANNELS.AZUREDEVOPS_CHECK_CONNECTION,
  IPC_CHANNELS.AZUREDEVOPS_DETECT_REPOSITORY,
  IPC_CHANNELS.AZUREDEVOPS_GET_PULL_REQUESTS,
  IPC_CHANNELS.AZUREDEVOPS_GET_PULL_REQUEST,
  IPC_CHANNELS.AZUREDEVOPS_GET_PULL_REQUEST_DIFF,
  IPC_CHANNELS.AZUREDEVOPS_POST_PULL_REQUEST_COMMENT,
  IPC_CHANNELS.AZUREDEVOPS_PR_REVIEW_CANCEL,
  IPC_CHANNELS.AZUREDEVOPS_PR_GET_REVIEW,
  IPC_CHANNELS.AZUREDEVOPS_PR_GET_LOGS,
  IPC_CHANNELS.AZUREDEVOPS_PR_POST_REVIEW
];
const ON_CHANNELS = [IPC_CHANNELS.AZUREDEVOPS_PR_REVIEW];

describe('registerAzureDevOpsHandlers', () => {
  beforeEach(() => {
    handle.mockClear();
    on.mockClear();
  });

  it('registers every PR channel exactly once', () => {
    registerAzureDevOpsHandlers(() => null);
    const handled = handle.mock.calls.map((c) => c[0]);
    const listened = on.mock.calls.map((c) => c[0]);
    for (const ch of HANDLE_CHANNELS) expect(handled.filter((x) => x === ch)).toHaveLength(1);
    for (const ch of ON_CHANNELS) expect(listened.filter((x) => x === ch)).toHaveLength(1);
    expect(new Set(handled).size).toBe(handled.length);
    expect(new Set(listened).size).toBe(listened.length);
  });
});
