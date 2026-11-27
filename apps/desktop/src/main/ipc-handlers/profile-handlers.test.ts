/**
 * Tests for profile IPC handlers
 *
 * Tests profiles:set-active handler with support for:
 * - Setting valid profile as active
 * - Switching to OAuth (null profileId)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIProfile, ProfilesFile } from '@shared/types/profile';

// Hoist mocked functions to avoid circular dependency in atomicModifyProfiles
const { mockedLoadProfilesFile, mockedSaveProfilesFile } = vi.hoisted(() => ({
  mockedLoadProfilesFile: vi.fn(),
  mockedSaveProfilesFile: vi.fn()
}));

// Mock electron before importing
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn()
  }
}));

// Mock profile service
vi.mock('../services/profile', () => ({
  loadProfilesFile: mockedLoadProfilesFile,
  saveProfilesFile: mockedSaveProfilesFile,
  validateFilePermissions: vi.fn(),
  getProfilesFilePath: vi.fn(() => '/test/profiles.json'),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  deleteProfile: vi.fn(),
  testConnection: vi.fn(),
  discoverModels: vi.fn(),
  atomicModifyProfiles: vi.fn(async (modifier: (file: unknown) => unknown) => {
    const file = await mockedLoadProfilesFile();
    const modified = modifier(file);
    await mockedSaveProfilesFile(modified as never);
    return modified;
  })
}));

import { registerProfileHandlers } from './profile-handlers';
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import {
  loadProfilesFile,
  saveProfilesFile,
  validateFilePermissions,
  testConnection,
  discoverModels
} from '../services/profile';
import type { TestConnectionResult } from '@shared/types/profile';
import type { ProviderAccount } from '../../shared/types/provider-account';
import { readSettingsFile } from '../settings-utils';
import { recordApiKeyOutcome } from '../services/api-key-status-recorder';

vi.mock('../settings-utils', () => ({ readSettingsFile: vi.fn() }));
vi.mock('../services/api-key-status-recorder', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/api-key-status-recorder')>(),
  recordApiKeyOutcome: vi.fn()
}));

function getHandler(channel: string) {
  const calls = vi.mocked(ipcMain.handle).mock.calls;
  const registration = calls.find(([registeredChannel]) => registeredChannel === channel);
  if (!registration) throw new Error(`Missing handler: ${channel}`);
  const handler = registration[1];
  return (...args: unknown[]) => handler({} as IpcMainInvokeEvent, ...args);
}

describe('profile-handlers - setActiveProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerProfileHandlers();
  });
  const mockProfiles: APIProfile[] = [
    {
      id: 'profile-1',
      name: 'Test Profile 1',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-test-key-1',
      createdAt: Date.now(),
      updatedAt: Date.now()
    },
    {
      id: 'profile-2',
      name: 'Test Profile 2',
      baseUrl: 'https://custom.api.com',
      apiKey: 'sk-custom-key-2',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  ];

  describe('setting valid profile as active', () => {
    it('should set active profile with valid profileId', async () => {
      const mockFile: ProfilesFile = {
        profiles: mockProfiles,
        activeProfileId: null,
        version: 1
      };

      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);
      vi.mocked(saveProfilesFile).mockResolvedValue(undefined);
      vi.mocked(validateFilePermissions).mockResolvedValue(true);

      const handler = getHandler(IPC_CHANNELS.PROFILES_SET_ACTIVE);
      const result = await handler('profile-1');

      expect(result).toEqual({ success: true });
      expect(saveProfilesFile).toHaveBeenCalledWith(
        expect.objectContaining({
          activeProfileId: 'profile-1'
        })
      );
    });

    it('should return error for non-existent profile', async () => {
      const mockFile: ProfilesFile = {
        profiles: mockProfiles,
        activeProfileId: null,
        version: 1
      };

      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);

      const handler = getHandler(IPC_CHANNELS.PROFILES_SET_ACTIVE);
      const result = await handler('non-existent-id');

      expect(result).toEqual({
        success: false,
        error: 'Profile not found'
      });
    });
  });

  describe('switching to OAuth (null profileId)', () => {
    it('should accept null profileId to switch to OAuth', async () => {
      const mockFile: ProfilesFile = {
        profiles: mockProfiles,
        activeProfileId: 'profile-1',
        version: 1
      };

      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);
      vi.mocked(saveProfilesFile).mockResolvedValue(undefined);
      vi.mocked(validateFilePermissions).mockResolvedValue(true);

      const handler = getHandler(IPC_CHANNELS.PROFILES_SET_ACTIVE);
      const result = await handler(null);

      // Should succeed and clear activeProfileId
      expect(result).toEqual({ success: true });
      expect(saveProfilesFile).toHaveBeenCalledWith(
        expect.objectContaining({
          activeProfileId: null
        })
      );
    });

    it('should handle null when no profile was active', async () => {
      const mockFile: ProfilesFile = {
        profiles: mockProfiles,
        activeProfileId: null,
        version: 1
      };

      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);
      vi.mocked(saveProfilesFile).mockResolvedValue(undefined);
      vi.mocked(validateFilePermissions).mockResolvedValue(true);

      const handler = getHandler(IPC_CHANNELS.PROFILES_SET_ACTIVE);
      const result = await handler(null);

      // Should succeed (idempotent operation)
      expect(result).toEqual({ success: true });
      expect(saveProfilesFile).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle loadProfilesFile errors', async () => {
      vi.mocked(loadProfilesFile).mockRejectedValue(
        new Error('Failed to load profiles')
      );

      const handler = getHandler(IPC_CHANNELS.PROFILES_SET_ACTIVE);
      const result = await handler('profile-1');

      expect(result).toEqual({
        success: false,
        error: 'Failed to load profiles'
      });
    });

    it('should handle saveProfilesFile errors', async () => {
      const mockFile: ProfilesFile = {
        profiles: mockProfiles,
        activeProfileId: null,
        version: 1
      };

      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);
      vi.mocked(saveProfilesFile).mockRejectedValue(
        new Error('Failed to save')
      );

      const handler = getHandler(IPC_CHANNELS.PROFILES_SET_ACTIVE);
      const result = await handler('profile-1');

      expect(result).toEqual({
        success: false,
        error: 'Failed to save'
      });
    });
  });
});

describe('profile-handlers - testConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerProfileHandlers();
  });

  describe('successful connection tests', () => {
    it('should return success result for valid connection', async () => {
      const mockResult: TestConnectionResult = {
        success: true,
        message: 'Connection successful'
      };

      vi.mocked(testConnection).mockResolvedValue(mockResult);

      const handler = getHandler(IPC_CHANNELS.PROFILES_TEST_CONNECTION);
      const result = await handler('https://api.anthropic.com', 'sk-test-key-12chars');

      expect(result).toEqual({
        success: true,
        data: mockResult
      });
      expect(testConnection).toHaveBeenCalledWith(
        'https://api.anthropic.com',
        'sk-test-key-12chars',
        expect.any(AbortSignal)
      );
    });
  });

  describe('input validation', () => {
    it('should return error for empty baseUrl', async () => {
      const handler = getHandler(IPC_CHANNELS.PROFILES_TEST_CONNECTION);
      const result = await handler('', 'sk-test-key-12chars');

      expect(result).toEqual({
        success: false,
        error: 'Base URL is required'
      });
      expect(testConnection).not.toHaveBeenCalled();
    });

    it('should return error for whitespace-only baseUrl', async () => {
      const handler = getHandler(IPC_CHANNELS.PROFILES_TEST_CONNECTION);
      const result = await handler('   ', 'sk-test-key-12chars');

      expect(result).toEqual({
        success: false,
        error: 'Base URL is required'
      });
      expect(testConnection).not.toHaveBeenCalled();
    });

    it('should return error for empty apiKey', async () => {
      const handler = getHandler(IPC_CHANNELS.PROFILES_TEST_CONNECTION);
      const result = await handler('https://api.anthropic.com', '');

      expect(result).toEqual({
        success: false,
        error: 'API key is required'
      });
      expect(testConnection).not.toHaveBeenCalled();
    });

    it('should return error for whitespace-only apiKey', async () => {
      const handler = getHandler(IPC_CHANNELS.PROFILES_TEST_CONNECTION);
      const result = await handler('https://api.anthropic.com', '   ');

      expect(result).toEqual({
        success: false,
        error: 'API key is required'
      });
      expect(testConnection).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should return IPCResult with TestConnectionResult data for service errors', async () => {
      const mockResult: TestConnectionResult = {
        success: false,
        errorType: 'auth',
        message: 'Authentication failed. Please check your API key.'
      };

      vi.mocked(testConnection).mockResolvedValue(mockResult);

      const handler = getHandler(IPC_CHANNELS.PROFILES_TEST_CONNECTION);
      const result = await handler('https://api.anthropic.com', 'invalid-key');

      expect(result).toEqual({
        success: true,
        data: mockResult
      });
    });

    it('should return error for unexpected exceptions', async () => {
      vi.mocked(testConnection).mockRejectedValue(new Error('Unexpected error'));

      const handler = getHandler(IPC_CHANNELS.PROFILES_TEST_CONNECTION);
      const result = await handler('https://api.anthropic.com', 'sk-test-key-12chars');

      expect(result).toEqual({
        success: false,
        error: 'Unexpected error'
      });
    });

    it('should return error for non-Error exceptions', async () => {
      vi.mocked(testConnection).mockRejectedValue('String error');

      const handler = getHandler(IPC_CHANNELS.PROFILES_TEST_CONNECTION);
      const result = await handler('https://api.anthropic.com', 'sk-test-key-12chars');

      expect(result).toEqual({
        success: false,
        error: 'Failed to test connection'
      });
    });
  });
});


describe('profile-handlers - saved provider keys', () => {
  const sentinel = 'provider-key-sentinel-do-not-return';
  const account: ProviderAccount = {
    id: 'pa_saved',
    provider: 'anthropic',
    name: 'Saved provider',
    authType: 'api-key',
    billingModel: 'pay-per-use',
    apiKey: sentinel,
    baseUrl: '  HTTPS://API.EXAMPLE.TEST/Provider///  ',
    createdAt: 1,
    updatedAt: 1
  };
  const endpoint = 'https://api.example.test/Provider';

  beforeEach(() => {
    vi.clearAllMocks();
    registerProfileHandlers();
    vi.mocked(readSettingsFile).mockReturnValue({ providerAccounts: [account] });
  });

  it.each([
    { outcome: 'valid', data: { success: true, message: 'Connection successful' } },
    { outcome: 'rejected', data: { success: false, errorType: 'auth', message: 'Authentication failed' } }
  ] satisfies { outcome: 'valid' | 'rejected'; data: TestConnectionResult }[])(
    'tests the stored endpoint using its saved key and records $outcome',
    async ({ outcome, data }) => {
      vi.mocked(testConnection).mockResolvedValueOnce(data);

      const reply = await getHandler(IPC_CHANNELS.PROFILES_TEST_CONNECTION)(`${endpoint}/`, '  ', 1, account.id);

      expect(testConnection).toHaveBeenCalledWith(endpoint, sentinel, expect.any(AbortSignal));
      expect(recordApiKeyOutcome).toHaveBeenCalledWith(account.id, outcome);
      expect(reply).toEqual({ success: true, data });
      expect(JSON.stringify(reply)).not.toContain(sentinel);
    }
  );

  describe.each([
    { channel: IPC_CHANNELS.PROFILES_TEST_CONNECTION, service: testConnection },
    { channel: IPC_CHANNELS.PROFILES_DISCOVER_MODELS, service: discoverModels }
  ])('$channel', ({ channel, service }) => {
    it.each([
      ['different host', 'https://other.example.test/Provider', {}, 'endpoint_mismatch'],
      ['different scheme', 'http://api.example.test/Provider', {}, 'endpoint_mismatch'],
      ['different path case', 'https://api.example.test/provider', {}, 'endpoint_mismatch'],
      ['no stored endpoint', endpoint, { baseUrl: undefined }, 'endpoint_mismatch'],
      ['no saved key', endpoint, { apiKey: undefined }, 'no_saved_key'],
      ['blank saved key', endpoint, { apiKey: '  ' }, 'no_saved_key'],
      ['unknown account', endpoint, { id: 'pa_other' }, 'account_not_found']
    ] as const)('rejects %s without using the key', async (_name, url, updates, error) => {
      vi.mocked(readSettingsFile).mockReturnValue({ providerAccounts: [{ ...account, ...updates }] });

      const reply = await getHandler(channel)(url, '', 1, account.id);

      expect(reply).toEqual({ success: false, error });
      expect(service).not.toHaveBeenCalled();
      expect(recordApiKeyOutcome).not.toHaveBeenCalled();
      expect(JSON.stringify(reply)).not.toContain(sentinel);
    });

    it('does not return an error that echoes the saved key', async () => {
      vi.mocked(service).mockRejectedValueOnce(new Error(`Invalid credential: ${sentinel}`));

      const reply = await getHandler(channel)(endpoint, '', 1, account.id);

      expect(reply).toEqual({ success: false, error: 'Invalid credential: [redacted]' });
      expect(JSON.stringify(reply)).not.toContain(sentinel);
    });
  });

  it('uses the saved key for discovery and drops model metadata that echoes it', async () => {
    const model = { id: 'model-a', display_name: 'Model A' };
    vi.mocked(discoverModels).mockResolvedValueOnce({ models: [
      model,
      { id: sentinel, display_name: 'Echoed key' },
      { id: 'model-b', display_name: sentinel }
    ] });

    const reply = await getHandler(IPC_CHANNELS.PROFILES_DISCOVER_MODELS)(endpoint, '', 1, account.id);

    expect(discoverModels).toHaveBeenCalledWith(endpoint, sentinel, expect.any(AbortSignal));
    expect(reply).toEqual({ success: true, data: { models: [model] } });
    expect(JSON.stringify(reply)).not.toContain(sentinel);
  });

  it('keeps discovery with a supplied key working independently of stored accounts', async () => {
    vi.mocked(discoverModels).mockResolvedValueOnce({ models: [] });
    const otherEndpoint = 'https://other.example.test';
    const suppliedKey = 'typed-key-for-test';

    const reply = await getHandler(IPC_CHANNELS.PROFILES_DISCOVER_MODELS)(otherEndpoint, suppliedKey, 1, account.id);

    expect(reply).toEqual({ success: true, data: { models: [] } });
    expect(discoverModels).toHaveBeenCalledWith(otherEndpoint, suppliedKey, expect.any(AbortSignal));
    expect(readSettingsFile).not.toHaveBeenCalled();
  });
});
