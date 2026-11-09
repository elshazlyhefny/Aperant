/**
 * Profile Service - Barrel Export
 *
 * Re-exports API profile functionality: api-profile-store (profiles.json I/O)
 * and profile-service (validation, CRUD, connection test, model discovery).
 * Claude OAuth accounts live in claude-profile-manager.ts, not here.
 * Main process code should import from this index file.
 */

// API profile store (profiles.json I/O)
export {
  loadProfilesFile,
  saveProfilesFile,
  generateProfileId,
  validateFilePermissions,
  getProfilesFilePath,
  withProfilesLock,
  atomicModifyProfiles
} from './api-profile-store';

// Profile Service
export {
  validateBaseUrl,
  validateApiKey,
  validateProfileNameUnique,
  createProfile,
  updateProfile,
  deleteProfile,
  getAPIProfileEnv,
  testConnection,
  discoverModels
} from './profile-service';

export type { CreateProfileInput, UpdateProfileInput } from './profile-service';

// Re-export types from shared for convenience
export type {
  APIProfile,
  ProfilesFile,
  ProfileFormData,
  TestConnectionResult,
  ModelInfo,
  DiscoverModelsResult,
  DiscoverModelsError
} from '@shared/types/profile';
