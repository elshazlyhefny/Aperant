/**
 * Tests for profile-service.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validateBaseUrl,
  validateApiKey,
  validateProfileNameUnique,
  createProfile,
  updateProfile,
  getAPIProfileEnv,
  testConnection,
  discoverModels
} from './profile-service';
import type { ProfilesFile, } from '@shared/types/profile';

const mockFetch = vi.fn();

/** Build a JSON Response for the fetch mock */
const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

/** fetch mock that never resolves and rejects with an abort error when its signal aborts */
const abortableFetch = (_url: string, init: RequestInit): Promise<Response> =>
  new Promise((_resolve, reject) => {
    const signal = init.signal as AbortSignal;
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Mock api-profile-store
vi.mock('./api-profile-store', () => ({
  loadProfilesFile: vi.fn(),
  saveProfilesFile: vi.fn(),
  generateProfileId: vi.fn(() => 'mock-uuid-1234'),
  validateFilePermissions: vi.fn().mockResolvedValue(true),
  getProfilesFilePath: vi.fn(() => '/mock/profiles.json'),
  atomicModifyProfiles: vi.fn(async (modifier: (file: ProfilesFile) => ProfilesFile) => {
    // Get the current mock file from loadProfilesFile
    const { loadProfilesFile, saveProfilesFile } = await import('./api-profile-store');
    const file = await loadProfilesFile();
    const modified = modifier(file);
    await saveProfilesFile(modified);
    return modified;
  })
}));

describe('profile-service', () => {
  describe('validateBaseUrl', () => {
    it('should accept valid HTTPS URLs', () => {
      expect(validateBaseUrl('https://api.anthropic.com')).toBe(true);
      expect(validateBaseUrl('https://custom-api.example.com')).toBe(true);
      expect(validateBaseUrl('https://api.example.com/v1')).toBe(true);
    });

    it('should accept valid HTTP URLs', () => {
      expect(validateBaseUrl('http://localhost:8080')).toBe(true);
      expect(validateBaseUrl('http://127.0.0.1:8000')).toBe(true);
    });

    it('should reject invalid URLs', () => {
      expect(validateBaseUrl('not-a-url')).toBe(false);
      expect(validateBaseUrl('ftp://example.com')).toBe(false);
      expect(validateBaseUrl('')).toBe(false);
      expect(validateBaseUrl('https://')).toBe(false);
    });

    it('should reject URLs without valid format', () => {
      expect(validateBaseUrl('anthropic.com')).toBe(false);
      expect(validateBaseUrl('://api.anthropic.com')).toBe(false);
    });
  });

  describe('validateApiKey', () => {
    it('should accept Anthropic API key format (sk-ant-...)', () => {
      expect(validateApiKey('sk-ant-api03-12345')).toBe(true);
      expect(validateApiKey('sk-ant-test-key')).toBe(true);
    });

    it('should accept OpenAI API key format (sk-...)', () => {
      expect(validateApiKey('sk-proj-12345')).toBe(true);
      expect(validateApiKey('sk-test-key-12345')).toBe(true);
    });

    it('should accept custom API keys with reasonable length', () => {
      expect(validateApiKey('custom-key-12345678')).toBe(true);
      expect(validateApiKey('x-api-key-abcdefghij')).toBe(true);
    });

    it('should reject empty or too short keys', () => {
      expect(validateApiKey('')).toBe(false);
      expect(validateApiKey('sk-')).toBe(false);
      expect(validateApiKey('abc')).toBe(false);
    });

    it('should reject keys with only whitespace', () => {
      expect(validateApiKey('   ')).toBe(false);
      expect(validateApiKey('\t\n')).toBe(false);
    });
  });

  describe('validateProfileNameUnique', () => {
    it('should return true when name is unique', async () => {
      const mockFile: ProfilesFile = {
        profiles: [
          {
            id: '1',
            name: 'Existing Profile',
            baseUrl: 'https://api.example.com',
            apiKey: 'sk-test',
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        ],
        activeProfileId: null,
        version: 1
      };

      const { loadProfilesFile } = await import('./api-profile-store');
      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);

      const result = await validateProfileNameUnique('New Profile');
      expect(result).toBe(true);
    });

    it('should return false when name already exists', async () => {
      const mockFile: ProfilesFile = {
        profiles: [
          {
            id: '1',
            name: 'Existing Profile',
            baseUrl: 'https://api.example.com',
            apiKey: 'sk-test',
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        ],
        activeProfileId: null,
        version: 1
      };

      const { loadProfilesFile } = await import('./api-profile-store');
      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);

      const result = await validateProfileNameUnique('Existing Profile');
      expect(result).toBe(false);
    });

    it('should be case-insensitive for duplicate detection', async () => {
      const mockFile: ProfilesFile = {
        profiles: [
          {
            id: '1',
            name: 'My Profile',
            baseUrl: 'https://api.example.com',
            apiKey: 'sk-test',
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        ],
        activeProfileId: null,
        version: 1
      };

      const { loadProfilesFile } = await import('./api-profile-store');
      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);

      const result1 = await validateProfileNameUnique('my profile');
      const result2 = await validateProfileNameUnique('MY PROFILE');
      expect(result1).toBe(false);
      expect(result2).toBe(false);
    });

    it('should trim whitespace before checking', async () => {
      const mockFile: ProfilesFile = {
        profiles: [
          {
            id: '1',
            name: 'My Profile',
            baseUrl: 'https://api.example.com',
            apiKey: 'sk-test',
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        ],
        activeProfileId: null,
        version: 1
      };

      const { loadProfilesFile } = await import('./api-profile-store');
      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);

      const result = await validateProfileNameUnique('  My Profile  ');
      expect(result).toBe(false);
    });
  });

  describe('createProfile', () => {
    it('should create profile with valid data and save', async () => {
      const mockFile: ProfilesFile = {
        profiles: [],
        activeProfileId: null,
        version: 1
      };

      const { loadProfilesFile, saveProfilesFile, generateProfileId } =
        await import('./api-profile-store');
      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);
      vi.mocked(saveProfilesFile).mockResolvedValue(undefined);
      vi.mocked(generateProfileId).mockReturnValue('generated-id-123');

      const input = {
        name: 'Test Profile',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-test-key',
        models: {
          default: 'claude-sonnet-4-5-20250929'
        }
      };

      const result = await createProfile(input);

      expect(result).toMatchObject({
        id: 'generated-id-123',
        name: 'Test Profile',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-test-key',
        models: {
          default: 'claude-sonnet-4-5-20250929'
        }
      });
      expect(result.createdAt).toBeGreaterThan(0);
      expect(result.updatedAt).toBeGreaterThan(0);
      expect(saveProfilesFile).toHaveBeenCalled();
    });

    it('should throw error for invalid base URL', async () => {
      const { loadProfilesFile } = await import('./api-profile-store');
      vi.mocked(loadProfilesFile).mockResolvedValue({
        profiles: [],
        activeProfileId: null,
        version: 1
      });

      const input = {
        name: 'Test Profile',
        baseUrl: 'not-a-url',
        apiKey: 'sk-ant-test-key'
      };

      await expect(createProfile(input)).rejects.toThrow('Invalid base URL');
    });

    it('should throw error for invalid API key', async () => {
      const { loadProfilesFile } = await import('./api-profile-store');
      vi.mocked(loadProfilesFile).mockResolvedValue({
        profiles: [],
        activeProfileId: null,
        version: 1
      });

      const input = {
        name: 'Test Profile',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'too-short'
      };

      await expect(createProfile(input)).rejects.toThrow('Invalid API key');
    });

    it('should throw error for duplicate profile name', async () => {
      const mockFile: ProfilesFile = {
        profiles: [
          {
            id: '1',
            name: 'Existing Profile',
            baseUrl: 'https://api.example.com',
            apiKey: 'sk-test',
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        ],
        activeProfileId: null,
        version: 1
      };

      const { loadProfilesFile } = await import('./api-profile-store');
      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);

      const input = {
        name: 'Existing Profile',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-test-key'
      };

      await expect(createProfile(input)).rejects.toThrow(
        'A profile with this name already exists'
      );
    });
  });

  describe('updateProfile', () => {
    it('should update profile name and other fields', async () => {
      const mockFile: ProfilesFile = {
        profiles: [
          {
            id: 'existing-id',
            name: 'Old Name',
            baseUrl: 'https://old-api.example.com',
            apiKey: 'sk-old-key-12345678',
            createdAt: 1000000,
            updatedAt: 1000000
          }
        ],
        activeProfileId: null,
        version: 1
      };

      const { loadProfilesFile, saveProfilesFile } = await import('./api-profile-store');
      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);
      vi.mocked(saveProfilesFile).mockResolvedValue(undefined);

      const input = {
        id: 'existing-id',
        name: 'New Name',
        baseUrl: 'https://new-api.example.com',
        apiKey: 'sk-new-api-key-123',
        models: { default: 'claude-sonnet-4-5-20250929' }
      };

      const result = await updateProfile(input);

      expect(result.name).toBe('New Name');
      expect(result.baseUrl).toBe('https://new-api.example.com');
      expect(result.apiKey).toBe('sk-new-api-key-123');
      expect(result.models).toEqual({ default: 'claude-sonnet-4-5-20250929' });
      expect(result.updatedAt).toBeGreaterThan(1000000);
      expect(result.createdAt).toBe(1000000);
    });

    it('resets keyStatus when the apiKey changes but keeps it when only the name changes', async () => {
      const make = (): ProfilesFile => ({
        profiles: [
          {
            id: 'existing-id',
            name: 'Old Name',
            baseUrl: 'https://api.example.com',
            apiKey: 'sk-old-key-12345678',
            keyStatus: 'rejected',
            keyStatusAt: 42,
            createdAt: 1000000,
            updatedAt: 1000000
          }
        ],
        activeProfileId: null,
        version: 1
      });
      const { loadProfilesFile, saveProfilesFile } = await import('./api-profile-store');
      vi.mocked(saveProfilesFile).mockResolvedValue(undefined);

      vi.mocked(loadProfilesFile).mockResolvedValue(make());
      const renamed = await updateProfile({
        id: 'existing-id',
        name: 'Renamed',
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-old-key-12345678'
      });
      expect(renamed.keyStatus).toBe('rejected');
      expect(renamed.keyStatusAt).toBe(42);

      vi.mocked(loadProfilesFile).mockResolvedValue(make());
      const rekeyed = await updateProfile({
        id: 'existing-id',
        name: 'Old Name',
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-new-key-98765432'
      });
      expect(rekeyed.keyStatus).toBeUndefined();
      expect(rekeyed.keyStatusAt).toBeUndefined();
    });

    it('should allow updating profile with same name (case-insensitive)', async () => {
      const mockFile: ProfilesFile = {
        profiles: [
          {
            id: 'existing-id',
            name: 'My Profile',
            baseUrl: 'https://api.example.com',
            apiKey: 'sk-old-api-key-123',
            createdAt: 1000000,
            updatedAt: 1000000
          }
        ],
        activeProfileId: null,
        version: 1
      };

      const { loadProfilesFile, saveProfilesFile } = await import('./api-profile-store');
      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);
      vi.mocked(saveProfilesFile).mockResolvedValue(undefined);

      const input = {
        id: 'existing-id',
        name: 'my profile',
        baseUrl: 'https://new-api.example.com',
        apiKey: 'sk-new-api-key-456'
      };

      const result = await updateProfile(input);
      expect(result.name).toBe('my profile');
      expect(saveProfilesFile).toHaveBeenCalled();
    });

    it('should throw error when name conflicts with another profile', async () => {
      const mockFile: ProfilesFile = {
        profiles: [
          {
            id: 'profile-1',
            name: 'Profile One',
            baseUrl: 'https://api1.example.com',
            apiKey: 'sk-key-one-12345678',
            createdAt: 1000000,
            updatedAt: 1000000
          },
          {
            id: 'profile-2',
            name: 'Profile Two',
            baseUrl: 'https://api2.example.com',
            apiKey: 'sk-key-two-12345678',
            createdAt: 1000000,
            updatedAt: 1000000
          }
        ],
        activeProfileId: null,
        version: 1
      };

      const { loadProfilesFile } = await import('./api-profile-store');
      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);

      const input = {
        id: 'profile-1',
        name: 'Profile Two',
        baseUrl: 'https://api1.example.com',
        apiKey: 'sk-key-one-12345678'
      };

      await expect(updateProfile(input)).rejects.toThrow(
        'A profile with this name already exists'
      );
    });

    it('should throw error for invalid base URL', async () => {
      const mockFile: ProfilesFile = {
        profiles: [
          {
            id: 'existing-id',
            name: 'Test Profile',
            baseUrl: 'https://api.example.com',
            apiKey: 'sk-test-api-key-123',
            createdAt: 1000000,
            updatedAt: 1000000
          }
        ],
        activeProfileId: null,
        version: 1
      };

      const { loadProfilesFile } = await import('./api-profile-store');
      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);

      const input = {
        id: 'existing-id',
        name: 'Test Profile',
        baseUrl: 'not-a-url',
        apiKey: 'sk-test-api-key-123'
      };

      await expect(updateProfile(input)).rejects.toThrow('Invalid base URL');
    });

    it('should throw error for invalid API key', async () => {
      const mockFile: ProfilesFile = {
        profiles: [
          {
            id: 'existing-id',
            name: 'Test Profile',
            baseUrl: 'https://api.example.com',
            apiKey: 'sk-test-api-key-123',
            createdAt: 1000000,
            updatedAt: 1000000
          }
        ],
        activeProfileId: null,
        version: 1
      };

      const { loadProfilesFile } = await import('./api-profile-store');
      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);

      const input = {
        id: 'existing-id',
        name: 'Test Profile',
        baseUrl: 'https://api.example.com',
        apiKey: 'too-short'
      };

      await expect(updateProfile(input)).rejects.toThrow('Invalid API key');
    });

    it('should throw error when profile not found', async () => {
      const mockFile: ProfilesFile = {
        profiles: [],
        activeProfileId: null,
        version: 1
      };

      const { loadProfilesFile } = await import('./api-profile-store');
      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);

      const input = {
        id: 'non-existent-id',
        name: 'Test Profile',
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-test-api-key-123'
      };

      await expect(updateProfile(input)).rejects.toThrow('Profile not found');
    });
  });

  describe('getAPIProfileEnv', () => {
    it('should return empty object when no active profile (OAuth mode)', async () => {
      const mockFile: ProfilesFile = {
        profiles: [
          {
            id: 'profile-1',
            name: 'Test Profile',
            baseUrl: 'https://api.example.com',
            apiKey: 'sk-test-key-12345678',
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        ],
        activeProfileId: null,
        version: 1
      };

      const { loadProfilesFile } = await import('./api-profile-store');
      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);

      const result = await getAPIProfileEnv();
      expect(result).toEqual({});
    });

    it('should return correct env vars for active profile with all fields', async () => {
      const mockFile: ProfilesFile = {
        profiles: [
          {
            id: 'profile-1',
            name: 'Test Profile',
            baseUrl: 'https://api.custom.com',
            apiKey: 'sk-test-key-12345678',
            models: {
              default: 'claude-sonnet-4-5-20250929',
              haiku: 'claude-haiku-4-5-20251001',
              sonnet: 'claude-sonnet-4-5-20250929',
              opus: 'claude-opus-4-5-20251101'
            },
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        ],
        activeProfileId: 'profile-1',
        version: 1
      };

      const { loadProfilesFile } = await import('./api-profile-store');
      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);

      const result = await getAPIProfileEnv();

      expect(result).toEqual({
        ANTHROPIC_BASE_URL: 'https://api.custom.com',
        ANTHROPIC_AUTH_TOKEN: 'sk-test-key-12345678',
        ANTHROPIC_MODEL: 'claude-sonnet-4-5-20250929',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5-20251001',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-5-20250929',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-5-20251101'
      });
    });

    it('should not send an undecryptable key envelope as ANTHROPIC_AUTH_TOKEN', async () => {
      const mockFile: ProfilesFile = {
        profiles: [
          {
            id: 'profile-1',
            name: 'Locked Keyring Profile',
            baseUrl: 'https://api.custom.com',
            apiKey: 'aperant-secret:v1:Y2lwaGVydGV4dA==',
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        ],
        activeProfileId: 'profile-1',
        version: 1
      };

      const { loadProfilesFile } = await import('./api-profile-store');
      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);

      const result = await getAPIProfileEnv();

      expect(result).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
      expect(result).toEqual({ ANTHROPIC_BASE_URL: 'https://api.custom.com' });
    });

    it('should filter out empty string values', async () => {
      const mockFile: ProfilesFile = {
        profiles: [
          {
            id: 'profile-1',
            name: 'Test Profile',
            baseUrl: '',
            apiKey: 'sk-test-key-12345678',
            models: {
              default: 'claude-sonnet-4-5-20250929',
              haiku: '',
              sonnet: ''
            },
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        ],
        activeProfileId: 'profile-1',
        version: 1
      };

      const { loadProfilesFile } = await import('./api-profile-store');
      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);

      const result = await getAPIProfileEnv();

      expect(result).not.toHaveProperty('ANTHROPIC_BASE_URL');
      expect(result).not.toHaveProperty('ANTHROPIC_DEFAULT_HAIKU_MODEL');
      expect(result).not.toHaveProperty('ANTHROPIC_DEFAULT_SONNET_MODEL');
      expect(result).toEqual({
        ANTHROPIC_AUTH_TOKEN: 'sk-test-key-12345678',
        ANTHROPIC_MODEL: 'claude-sonnet-4-5-20250929'
      });
    });

    it('should return empty object when activeProfileId is empty string', async () => {
      const mockFile: ProfilesFile = {
        profiles: [
          {
            id: 'profile-1',
            name: 'Test Profile',
            baseUrl: 'https://api.example.com',
            apiKey: 'sk-test-key-12345678',
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        ],
        activeProfileId: '',
        version: 1
      };

      const { loadProfilesFile } = await import('./api-profile-store');
      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);

      const result = await getAPIProfileEnv();
      expect(result).toEqual({});
    });

    it('should handle missing models object', async () => {
      const mockFile: ProfilesFile = {
        profiles: [
          {
            id: 'profile-1',
            name: 'Test Profile',
            baseUrl: 'https://api.example.com',
            apiKey: 'sk-test-key-12345678',
            createdAt: Date.now(),
            updatedAt: Date.now()
            // No models property
          }
        ],
        activeProfileId: 'profile-1',
        version: 1
      };

      const { loadProfilesFile } = await import('./api-profile-store');
      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);

      const result = await getAPIProfileEnv();

      expect(result).toEqual({
        ANTHROPIC_BASE_URL: 'https://api.example.com',
        ANTHROPIC_AUTH_TOKEN: 'sk-test-key-12345678'
      });
      expect(result).not.toHaveProperty('ANTHROPIC_MODEL');
      expect(result).not.toHaveProperty('ANTHROPIC_DEFAULT_HAIKU_MODEL');
      expect(result).not.toHaveProperty('ANTHROPIC_DEFAULT_SONNET_MODEL');
      expect(result).not.toHaveProperty('ANTHROPIC_DEFAULT_OPUS_MODEL');
    });

    it('should handle partial model configurations', async () => {
      const mockFile: ProfilesFile = {
        profiles: [
          {
            id: 'profile-1',
            name: 'Test Profile',
            baseUrl: 'https://api.example.com',
            apiKey: 'sk-test-key-12345678',
            models: {
              default: 'claude-sonnet-4-5-20250929'
              // Only default model set
            },
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        ],
        activeProfileId: 'profile-1',
        version: 1
      };

      const { loadProfilesFile } = await import('./api-profile-store');
      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);

      const result = await getAPIProfileEnv();

      expect(result).toEqual({
        ANTHROPIC_BASE_URL: 'https://api.example.com',
        ANTHROPIC_AUTH_TOKEN: 'sk-test-key-12345678',
        ANTHROPIC_MODEL: 'claude-sonnet-4-5-20250929'
      });
      expect(result).not.toHaveProperty('ANTHROPIC_DEFAULT_HAIKU_MODEL');
      expect(result).not.toHaveProperty('ANTHROPIC_DEFAULT_SONNET_MODEL');
      expect(result).not.toHaveProperty('ANTHROPIC_DEFAULT_OPUS_MODEL');
    });

    it('should find active profile by id when multiple profiles exist', async () => {
      const mockFile: ProfilesFile = {
        profiles: [
          {
            id: 'profile-1',
            name: 'Profile One',
            baseUrl: 'https://api1.example.com',
            apiKey: 'sk-key-one-12345678',
            createdAt: Date.now(),
            updatedAt: Date.now()
          },
          {
            id: 'profile-2',
            name: 'Profile Two',
            baseUrl: 'https://api2.example.com',
            apiKey: 'sk-key-two-12345678',
            models: { default: 'claude-sonnet-4-5-20250929' },
            createdAt: Date.now(),
            updatedAt: Date.now()
          },
          {
            id: 'profile-3',
            name: 'Profile Three',
            baseUrl: 'https://api3.example.com',
            apiKey: 'sk-key-three-12345678',
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        ],
        activeProfileId: 'profile-2',
        version: 1
      };

      const { loadProfilesFile } = await import('./api-profile-store');
      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);

      const result = await getAPIProfileEnv();

      expect(result).toEqual({
        ANTHROPIC_BASE_URL: 'https://api2.example.com',
        ANTHROPIC_AUTH_TOKEN: 'sk-key-two-12345678',
        ANTHROPIC_MODEL: 'claude-sonnet-4-5-20250929'
      });
    });

    it('should handle profile not found (activeProfileId points to non-existent profile)', async () => {
      const mockFile: ProfilesFile = {
        profiles: [
          {
            id: 'profile-1',
            name: 'Profile One',
            baseUrl: 'https://api1.example.com',
            apiKey: 'sk-key-one-12345678',
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        ],
        activeProfileId: 'non-existent-id', // Points to profile that doesn't exist
        version: 1
      };

      const { loadProfilesFile } = await import('./api-profile-store');
      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);

      const result = await getAPIProfileEnv();

      // Should return empty object gracefully
      expect(result).toEqual({});
    });

    it('should trim whitespace from values before filtering', async () => {
      const mockFile: ProfilesFile = {
        profiles: [
          {
            id: 'profile-1',
            name: 'Test Profile',
            baseUrl: '  https://api.example.com  ', // Has whitespace
            apiKey: 'sk-test-key-12345678',
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        ],
        activeProfileId: 'profile-1',
        version: 1
      };

      const { loadProfilesFile } = await import('./api-profile-store');
      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);

      const result = await getAPIProfileEnv();

      // Whitespace should be trimmed, not filtered out
      expect(result).toEqual({
        ANTHROPIC_BASE_URL: 'https://api.example.com', // Trimmed
        ANTHROPIC_AUTH_TOKEN: 'sk-test-key-12345678'
      });
    });

    it('should filter out whitespace-only values', async () => {
      const mockFile: ProfilesFile = {
        profiles: [
          {
            id: 'profile-1',
            name: 'Test Profile',
            baseUrl: '   ', // Whitespace only
            apiKey: 'sk-test-key-12345678',
            models: {
              default: '   ' // Whitespace only
            },
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        ],
        activeProfileId: 'profile-1',
        version: 1
      };

      const { loadProfilesFile } = await import('./api-profile-store');
      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);

      const result = await getAPIProfileEnv();

      // Whitespace-only values should be filtered out
      expect(result).not.toHaveProperty('ANTHROPIC_BASE_URL');
      expect(result).not.toHaveProperty('ANTHROPIC_MODEL');
      expect(result).toEqual({
        ANTHROPIC_AUTH_TOKEN: 'sk-test-key-12345678'
      });
    });
  });

  describe('testConnection', () => {
    const KEY = 'sk-ant-test-key-12';
    const TIMEOUT_MESSAGE = 'Connection timeout. The endpoint did not respond.';
    const NETWORK_MESSAGE = 'Network error. Please check your internet connection.';
    const AUTH_MESSAGE = 'Authentication failed. Please check your API key.';
    const UNKNOWN_MESSAGE = 'Connection test failed. Please try again.';

    beforeEach(() => {
      mockFetch.mockReset();
    });

    it('should return success for valid credentials (200 response)', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      const result = await testConnection('https://api.anthropic.com', KEY);

      expect(result).toEqual({ success: true, message: 'Connection successful' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should send GET /v1/models?limit=1 with x-api-key and anthropic-version headers and no Authorization', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      await testConnection('https://api.anthropic.com/', KEY);

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.anthropic.com/v1/models?limit=1');
      expect(init.method).toBe('GET');
      const headers = init.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe(KEY);
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('authorization');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('should return auth error for invalid API key (401 response)', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 401));

      const result = await testConnection('https://api.anthropic.com', 'sk-invalid-key-12');

      expect(result).toEqual({ success: false, errorType: 'auth', message: AUTH_MESSAGE });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should return network error for connection refused', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

      const result = await testConnection('https://unreachable.example.com', 'sk-test-key-12chars');

      expect(result).toEqual({ success: false, errorType: 'network', message: NETWORK_MESSAGE });
    });

    it('should return timeout error when the 10 s timeout fires', async () => {
      const timeoutController = new AbortController();
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal);
      mockFetch.mockImplementationOnce(abortableFetch);

      const pending = testConnection('https://slow.example.com', 'sk-test-key-12chars');
      timeoutController.abort(new DOMException('The operation timed out.', 'TimeoutError'));
      const result = await pending;

      expect(timeoutSpy).toHaveBeenCalledWith(10000);
      expect(result).toEqual({ success: false, errorType: 'timeout', message: TIMEOUT_MESSAGE });
      timeoutSpy.mockRestore();
    });

    it('should return timeout error and not call fetch when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await testConnection('https://api.anthropic.com', KEY, controller.signal);

      expect(result).toEqual({ success: false, errorType: 'timeout', message: TIMEOUT_MESSAGE });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return unknown error when the caller aborts mid-flight and pass a linked signal to fetch', async () => {
      const controller = new AbortController();
      let fetchSignal: AbortSignal | undefined;
      mockFetch.mockImplementationOnce((url: string, init: RequestInit) => {
        fetchSignal = init.signal as AbortSignal;
        return abortableFetch(url, init);
      });

      const pending = testConnection('https://api.anthropic.com', KEY, controller.signal);
      expect(fetchSignal?.aborted).toBe(false);
      controller.abort();
      const result = await pending;

      expect(fetchSignal?.aborted).toBe(true);
      expect(result).toEqual({ success: false, errorType: 'unknown', message: UNKNOWN_MESSAGE });
    });

    it('should auto-prepend https:// if missing', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      const result = await testConnection('api.anthropic.com', 'sk-test-key-12chars');

      expect(result).toEqual({ success: true, message: 'Connection successful' });
      expect(mockFetch.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/models?limit=1');
    });

    it('should return error for empty baseUrl', async () => {
      const result = await testConnection('', 'sk-test-key-12chars');

      expect(result).toEqual({
        success: false,
        errorType: 'endpoint',
        message: 'Invalid endpoint. Please check the Base URL.'
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return error for invalid API key format', async () => {
      const result = await testConnection('https://api.anthropic.com', 'short');

      expect(result).toEqual({ success: false, errorType: 'auth', message: AUTH_MESSAGE });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    describe('/v1/messages fallback after 404 on /v1/models', () => {
      it.each([400, 422, 200])('should succeed when /v1/messages returns %i', async (status) => {
        mockFetch
          .mockResolvedValueOnce(jsonResponse({}, 404))
          .mockResolvedValueOnce(jsonResponse({}, status));

        const result = await testConnection('https://api.minimax.example.com', KEY);

        expect(result).toEqual({ success: true, message: 'Connection successful' });
        expect(mockFetch).toHaveBeenCalledTimes(2);
        const [url, init] = mockFetch.mock.calls[1] as [string, RequestInit];
        expect(url).toBe('https://api.minimax.example.com/v1/messages');
        expect(init.method).toBe('POST');
        const headers = init.headers as Record<string, string>;
        expect(headers['x-api-key']).toBe(KEY);
        expect(headers['anthropic-version']).toBe('2023-06-01');
      });

      it('should return auth error when /v1/messages returns 401', async () => {
        mockFetch
          .mockResolvedValueOnce(jsonResponse({}, 404))
          .mockResolvedValueOnce(jsonResponse({}, 401));

        const result = await testConnection('https://api.example.com', KEY);

        expect(result).toEqual({ success: false, errorType: 'auth', message: AUTH_MESSAGE });
      });

      it('should return endpoint error with URL suggestion when both endpoints return 404', async () => {
        mockFetch
          .mockResolvedValueOnce(jsonResponse({}, 404))
          .mockResolvedValueOnce(jsonResponse({}, 404));

        const result = await testConnection('https://a.io', KEY);

        expect(result).toEqual({
          success: false,
          errorType: 'endpoint',
          message: 'Invalid endpoint. Please check the Base URL. Check for typos in domain name'
        });
      });

      it('should return plain endpoint error when both 404 and the URL has no suggestions', async () => {
        mockFetch
          .mockResolvedValueOnce(jsonResponse({}, 404))
          .mockResolvedValueOnce(jsonResponse({}, 404));

        const result = await testConnection('https://api.example-gateway.com', KEY);

        expect(result).toEqual({
          success: false,
          errorType: 'endpoint',
          message: 'Invalid endpoint. Please check the Base URL.'
        });
      });

      it('should return network error when /v1/messages request fails', async () => {
        mockFetch
          .mockResolvedValueOnce(jsonResponse({}, 404))
          .mockRejectedValueOnce(new TypeError('fetch failed'));

        const result = await testConnection('https://api.example.com', KEY);

        expect(result).toEqual({ success: false, errorType: 'network', message: NETWORK_MESSAGE });
      });
    });

    it.each([403, 429, 500])('should return unknown error for %i response', async (status) => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, status));

      const result = await testConnection('https://api.anthropic.com', KEY);

      expect(result).toEqual({ success: false, errorType: 'unknown', message: UNKNOWN_MESSAGE });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('discoverModels', () => {
    const KEY = 'sk-ant-test-key-12';

    beforeEach(() => {
      mockFetch.mockReset();
    });

    const catchError = async (promise: Promise<unknown>) =>
      (await promise.catch((e) => e)) as Error & { errorType?: string };

    it('should return list of models for successful response', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        data: [
          { id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5', created_at: '2024-10-22', type: 'model' },
          { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', created_at: '2024-10-22', type: 'model' }
        ]
      }));

      const result = await discoverModels('https://api.anthropic.com', KEY);

      expect(result).toEqual({
        models: [
          { id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5' },
          { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5' }
        ]
      });
    });

    it('should request ?limit=1000 with x-api-key and anthropic-version headers', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      await discoverModels('https://api.anthropic.com/', KEY);

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.anthropic.com/v1/models?limit=1000');
      expect(init.method).toBe('GET');
      const headers = init.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe(KEY);
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('authorization');
    });

    it('should fall back to id when display_name is missing and drop entries with empty id', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        data: [
          { id: 'model-a' },
          { id: '', display_name: 'No Id' },
          { display_name: 'Missing Id' },
          { id: 'model-b', display_name: 'Model B' }
        ]
      }));

      const result = await discoverModels('https://api.anthropic.com', KEY);

      expect(result).toEqual({
        models: [
          { id: 'model-a', display_name: 'model-a' },
          { id: 'model-b', display_name: 'Model B' }
        ]
      });
    });

    it('should throw auth error for 401 response', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 401));

      const error = await catchError(discoverModels('https://api.anthropic.com', 'sk-invalid-key'));

      expect(error).toBeInstanceOf(Error);
      expect(error.errorType).toBe('auth');
      expect(error.message).toBe('Authentication failed. Please check your API key.');
    });

    it('should throw not_supported error for 404 response', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 404));

      const error = await catchError(discoverModels('https://custom-api.com', 'sk-test-key-12345678'));

      expect(error).toBeInstanceOf(Error);
      expect(error.errorType).toBe('not_supported');
      expect(error.message).toBe(
        'This API endpoint does not support model listing. Please enter the model name manually.'
      );
    });

    it('should throw network error when fetch fails', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

      const error = await catchError(discoverModels('https://api.anthropic.com', KEY));

      expect(error.errorType).toBe('network');
      expect(error.message).toBe('Network error. Please check your internet connection.');
    });

    it('should throw timeout error when the 10 s timeout fires', async () => {
      const timeoutController = new AbortController();
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal);
      mockFetch.mockImplementationOnce(abortableFetch);

      const pending = catchError(discoverModels('https://slow.example.com', KEY));
      timeoutController.abort(new DOMException('The operation timed out.', 'TimeoutError'));
      const error = await pending;

      expect(timeoutSpy).toHaveBeenCalledWith(10000);
      expect(error.errorType).toBe('timeout');
      expect(error.message).toBe('Connection timeout. The endpoint did not respond.');
      timeoutSpy.mockRestore();
    });

    it('should throw unknown error for 500 response', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));

      const error = await catchError(discoverModels('https://api.anthropic.com', KEY));

      expect(error.errorType).toBe('unknown');
      expect(error.message).toBe('Connection test failed. Please try again.');
    });

    it('should throw unknown error for invalid JSON body', async () => {
      mockFetch.mockResolvedValueOnce(new Response('not json', { status: 200 }));

      const error = await catchError(discoverModels('https://api.anthropic.com', KEY));

      expect(error.errorType).toBe('unknown');
      expect(error.message).toBe('Connection test failed. Please try again.');
    });

    it('should throw timeout error without calling fetch when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const error = await catchError(discoverModels('https://api.anthropic.com', KEY, controller.signal));

      expect(error.errorType).toBe('timeout');
      expect(error.message).toBe('Connection timeout. The endpoint did not respond.');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should propagate aborting the caller signal to fetch', async () => {
      const controller = new AbortController();
      let fetchSignal: AbortSignal | undefined;
      mockFetch.mockImplementationOnce((url: string, init: RequestInit) => {
        fetchSignal = init.signal as AbortSignal;
        return abortableFetch(url, init);
      });

      const pending = catchError(discoverModels('https://api.anthropic.com', KEY, controller.signal));
      expect(fetchSignal?.aborted).toBe(false);
      controller.abort();
      const error = await pending;

      expect(fetchSignal?.aborted).toBe(true);
      expect(error.errorType).toBe('unknown');
    });

    it('should auto-prepend https:// if missing', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      const result = await discoverModels('api.anthropic.com', 'sk-test-key-12chars');

      expect(result).toEqual({ models: [] });
      expect(mockFetch.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/models?limit=1000');
    });
  });
});
