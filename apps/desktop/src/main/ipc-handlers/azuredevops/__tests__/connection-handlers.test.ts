/**
 * Unit tests for Azure DevOps connection handlers
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, fn: (...args: unknown[]) => Promise<unknown>) => { handlers.set(channel, fn); }) },
  app: { getPath: () => '/tmp' }
}));

const getProject = vi.fn();
vi.mock('../../../project-store', () => ({ projectStore: { getProject: (...a: unknown[]) => getProject(...a) } }));

const getAzureDevOpsConfig = vi.fn();
const azureDevOpsFetch = vi.fn();
const detect = vi.fn();
vi.mock('../utils', () => ({
  getAzureDevOpsConfig: (...a: unknown[]) => getAzureDevOpsConfig(...a),
  azureDevOpsFetch: (...a: unknown[]) => azureDevOpsFetch(...a),
  detectAzureDevOpsRepositoryFromRemote: (...a: unknown[]) => detect(...a)
}));

import { registerCheckConnection, registerDetectRepository } from '../connection-handlers';
import { IPC_CHANNELS } from '../../../../shared/constants';

const config = { organization: 'org', project: 'My Proj', repository: 'repo', pat: 'secret' };

describe('azure devops connection handlers', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    registerCheckConnection();
    registerDetectRepository();
    getProject.mockReturnValue({ id: 'p1', path: '/repo' });
  });

  const call = (channel: string) => handlers.get(channel)!({}, 'p1');

  it('returns an error when not configured', async () => {
    getAzureDevOpsConfig.mockResolvedValue(null);
    expect(await call(IPC_CHANNELS.AZUREDEVOPS_CHECK_CONNECTION)).toEqual({
      success: false,
      error: 'Azure DevOps not configured'
    });
  });

  it('returns connected status', async () => {
    getAzureDevOpsConfig.mockResolvedValue(config);
    azureDevOpsFetch.mockResolvedValue({ id: 'x' });
    expect(await call(IPC_CHANNELS.AZUREDEVOPS_CHECK_CONNECTION)).toEqual({
      success: true,
      data: { connected: true, repoFullName: 'org/My Proj/repo' }
    });
  });

  it('returns connected:false with error when the request fails', async () => {
    getAzureDevOpsConfig.mockResolvedValue(config);
    azureDevOpsFetch.mockRejectedValue(new Error('401 Unauthorized'));
    const result = (await call(IPC_CHANNELS.AZUREDEVOPS_CHECK_CONNECTION)) as {
      success: boolean;
      data: { connected: boolean; error: string };
    };
    expect(result.success).toBe(true);
    expect(result.data.connected).toBe(false);
    expect(result.data.error).toBe('401 Unauthorized');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('detects repository, or null without an Azure remote', async () => {
    detect.mockReturnValueOnce({ organization: 'o', project: 'p', repository: 'r', fullName: 'o/p/r' });
    expect(await call(IPC_CHANNELS.AZUREDEVOPS_DETECT_REPOSITORY)).toEqual({
      success: true,
      data: { organization: 'o', project: 'p', repository: 'r', fullName: 'o/p/r' }
    });
    detect.mockReturnValueOnce(null);
    expect(await call(IPC_CHANNELS.AZUREDEVOPS_DETECT_REPOSITORY)).toEqual({ success: true, data: null });
  });
});
