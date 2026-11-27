/**
 * Profile IPC Handlers
 *
 * IPC handlers for API profile management:
 * - profiles:get - Get all profiles
 * - profiles:save - Save/create a profile
 * - profiles:update - Update an existing profile
 * - profiles:delete - Delete a profile
 * - profiles:setActive - Set active profile
 * - profiles:test-connection - Test API profile connection
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult } from '../../shared/types';
import type { APIProfile, ProfileFormData, ProfilesFile, TestConnectionResult, DiscoverModelsResult } from '@shared/types/profile';
import {
  loadProfilesFile,
  validateFilePermissions,
  getProfilesFilePath,
  atomicModifyProfiles,
  createProfile,
  updateProfile,
  deleteProfile,
  testConnection,
  discoverModels
} from '../services/profile';

import { SecureStorageUnavailableError } from '../secure-storage/secret-storage';
import { recordApiKeyOutcome, outcomeFromConnectionError } from '../services/api-key-status-recorder';
import { resolveSavedProviderKey } from '../services/profile/provider-account-key-resolver';

// Track active test connection requests for cancellation
const activeTestConnections = new Map<number, AbortController>();

// Track active discover models requests for cancellation
const activeDiscoverModelsRequests = new Map<number, AbortController>();

function resolveProfileCredentials(baseUrl: string, apiKey: string, accountId?: string) {
  const hasSuppliedKey = typeof apiKey === 'string' && apiKey.trim() !== '';
  if (!hasSuppliedKey && accountId) {
    const saved = resolveSavedProviderKey(accountId, baseUrl);
    return saved.ok ? { ...saved, savedKey: saved.apiKey } : saved;
  }

  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    return { ok: false, error: 'Base URL is required' } as const;
  }
  if (!hasSuppliedKey) return { ok: false, error: 'API key is required' } as const;
  return { ok: true, baseUrl, apiKey, savedKey: undefined } as const;
}

/**
 * Register all profile-related IPC handlers
 */
export function registerProfileHandlers(): void {
  /**
   * Get all profiles
   */
  ipcMain.handle(
    IPC_CHANNELS.PROFILES_GET,
    async (): Promise<IPCResult<ProfilesFile>> => {
      try {
        const profiles = await loadProfilesFile();
        return { success: true, data: profiles };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to load profiles'
        };
      }
    }
  );

  /**
   * Save/create a profile
   */
  ipcMain.handle(
    IPC_CHANNELS.PROFILES_SAVE,
    async (
      _,
      profileData: ProfileFormData
    ): Promise<IPCResult<APIProfile>> => {
      try {
        // Use createProfile from service layer (handles validation)
        const newProfile = await createProfile(profileData);

        // Set file permissions to user-readable only
        await validateFilePermissions(getProfilesFilePath()).catch((err) => {
          console.warn('[profile-handlers] Failed to set secure file permissions:', err);
        });

        return { success: true, data: newProfile };
      } catch (error) {
        // zeenha fork: report refused key persistence without exposing backend errors.
        if (error instanceof SecureStorageUnavailableError) return { success: false, error: error.code };
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to save profile'
        };
      }
    }
  );

  /**
   * Update an existing profile
   */
  ipcMain.handle(
    IPC_CHANNELS.PROFILES_UPDATE,
    async (_, profileData: APIProfile): Promise<IPCResult<APIProfile>> => {
      try {
        // Use updateProfile from service layer (handles validation)
        const updatedProfile = await updateProfile({
          id: profileData.id,
          name: profileData.name,
          baseUrl: profileData.baseUrl,
          apiKey: profileData.apiKey,
          models: profileData.models
        });

        // Set file permissions to user-readable only
        await validateFilePermissions(getProfilesFilePath()).catch((err) => {
          console.warn('[profile-handlers] Failed to set secure file permissions:', err);
        });

        return { success: true, data: updatedProfile };
      } catch (error) {
        if (error instanceof SecureStorageUnavailableError) return { success: false, error: error.code };
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update profile'
        };
      }
    }
  );

  /**
   * Delete a profile
   */
  ipcMain.handle(
    IPC_CHANNELS.PROFILES_DELETE,
    async (_, profileId: string): Promise<IPCResult> => {
      try {
        // Use deleteProfile from service layer (handles validation)
        await deleteProfile(profileId);

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to delete profile'
        };
      }
    }
  );

  /**
   * Set active profile
   * - If profileId is provided, set that profile as active
   * - If profileId is null, clear active profile (switch to OAuth)
   * Uses atomic operation to prevent race conditions
   */
  ipcMain.handle(
    IPC_CHANNELS.PROFILES_SET_ACTIVE,
    async (_, profileId: string | null): Promise<IPCResult> => {
      try {
        await atomicModifyProfiles((file) => {
          // If switching to OAuth (null), clear active profile
          if (profileId === null) {
            file.activeProfileId = null;
            return file;
          }

          // Check if profile exists
          const profileExists = file.profiles.some((p) => p.id === profileId);
          if (!profileExists) {
            throw new Error('Profile not found');
          }

          // Set active profile
          file.activeProfileId = profileId;
          return file;
        });

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to set active profile'
        };
      }
    }
  );

  /**
   * Test API profile connection
   * - Tests credentials by making a minimal API request
   * - Returns detailed error information for different failure types
   * - Includes configurable timeout (defaults to 15 seconds)
   * - Supports cancellation via PROFILES_TEST_CONNECTION_CANCEL
   */
  ipcMain.handle(
    IPC_CHANNELS.PROFILES_TEST_CONNECTION,
    async (_event, baseUrl: string, apiKey: string, requestId: number, profileId?: string): Promise<IPCResult<TestConnectionResult>> => {
      // Create AbortController for timeout and cancellation
      const controller = new AbortController();
      const timeoutMs = 15000; // 15 seconds

      // Track this request for cancellation
      activeTestConnections.set(requestId, controller);

      // Set timeout to abort the request
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      let savedKey: string | undefined;
      try {
        const credentials = resolveProfileCredentials(baseUrl, apiKey, profileId);
        if (!credentials.ok) return { success: false, error: credentials.error };
        savedKey = credentials.savedKey;

        const result = await testConnection(credentials.baseUrl, credentials.apiKey, controller.signal);

        // Record the outcome for a saved profile (only an auth failure rejects a key)
        if (profileId) {
          if (result.success) {
            await recordApiKeyOutcome(profileId, 'valid');
          } else if (outcomeFromConnectionError(result.errorType) === 'rejected') {
            await recordApiKeyOutcome(profileId, 'rejected');
          }
        }

        const data = credentials.savedKey ? {
          ...result,
          message: result.message.replaceAll(credentials.savedKey, '[redacted]')
        } : result;
        return { success: true, data };
      } catch (error) {
        // Handle abort errors (timeout or explicit cancellation)
        if (error instanceof Error && error.name === 'AbortError') {
          return {
            success: false,
            error: 'Connection timeout. The request took too long to complete.'
          };
        }

        const message = error instanceof Error ? error.message : 'Failed to test connection';
        return { success: false, error: savedKey ? message.replaceAll(savedKey, '[redacted]') : message };
      } finally {
        clearTimeout(timeoutId);
        if (activeTestConnections.get(requestId) === controller) activeTestConnections.delete(requestId);
      }
    }
  );

  /**
   * Cancel an active test connection request
   */
  ipcMain.on(
    IPC_CHANNELS.PROFILES_TEST_CONNECTION_CANCEL,
    (_event, requestId: number) => {
      const controller = activeTestConnections.get(requestId);
      if (controller) {
        controller.abort();
        activeTestConnections.delete(requestId);
      }
    }
  );

  /**
   * Discover available models from API endpoint
   * - Fetches list of models from /v1/models endpoint
   * - Returns model IDs and display names for dropdown selection
   * - Supports cancellation via PROFILES_DISCOVER_MODELS_CANCEL
   */
  ipcMain.handle(
    IPC_CHANNELS.PROFILES_DISCOVER_MODELS,
    async (_event, baseUrl: string, apiKey: string, requestId: number, accountId?: string): Promise<IPCResult<DiscoverModelsResult>> => {
      // Create AbortController for timeout and cancellation
      const controller = new AbortController();
      const timeoutMs = 15000; // 15 seconds

      // Track this request for cancellation
      activeDiscoverModelsRequests.set(requestId, controller);

      // Set timeout to abort the request
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      let savedKey: string | undefined;
      try {
        const credentials = resolveProfileCredentials(baseUrl, apiKey, accountId);
        if (!credentials.ok) return { success: false, error: credentials.error };
        savedKey = credentials.savedKey;

        const result = await discoverModels(credentials.baseUrl, credentials.apiKey, controller.signal);

        // zeenha fork: do not return model metadata that echoes the stored credential.
        const key = credentials.savedKey;
        const data = key ? {
          models: result.models.filter(({ id, display_name }) => !id.includes(key) && !display_name.includes(key))
        } : result;
        return { success: true, data };
      } catch (error) {
        // Handle abort errors (timeout or explicit cancellation)
        if (error instanceof Error && error.name === 'AbortError') {
          return {
            success: false,
            error: 'Connection timeout. The request took too long to complete.'
          };
        }

        const message = error instanceof Error ? error.message : 'Failed to discover models';
        return { success: false, error: savedKey ? message.replaceAll(savedKey, '[redacted]') : message };
      } finally {
        clearTimeout(timeoutId);
        if (activeDiscoverModelsRequests.get(requestId) === controller) activeDiscoverModelsRequests.delete(requestId);
      }
    }
  );

  /**
   * Cancel an active discover models request
   */
  ipcMain.on(
    IPC_CHANNELS.PROFILES_DISCOVER_MODELS_CANCEL,
    (_event, requestId: number) => {
      const controller = activeDiscoverModelsRequests.get(requestId);
      if (controller) {
        controller.abort();
        activeDiscoverModelsRequests.delete(requestId);
      }
    }
  );
}
