/**
 * Profile Service - Validation and CRUD for API profiles
 *
 * Provides validation (URL, API key, name uniqueness), create/update/delete,
 * connection testing and model discovery for API (custom endpoint) profiles.
 * Built on api-profile-store.ts, which owns profiles.json; Claude OAuth
 * accounts are managed separately by claude-profile-manager.ts.
 * Uses atomic operations with file locking to prevent TOCTOU race conditions.
 */

import { loadProfilesFile, generateProfileId, atomicModifyProfiles } from './api-profile-store';
import { withKeyStatusReset } from '../../../shared/utils/api-key-status';
import type { APIProfile, TestConnectionResult, ModelInfo, DiscoverModelsResult } from '@shared/types/profile';

/** Error categories shared by testConnection and discoverModels */
type ProfileErrorKind = 'auth' | 'endpoint' | 'timeout' | 'network' | 'unknown';

const PROFILE_REQUEST_TIMEOUT_MS = 10000;
const ANTHROPIC_VERSION = '2023-06-01';

const PROFILE_ERROR_MESSAGES: Record<Exclude<ProfileErrorKind, 'endpoint'>, string> = {
  auth: 'Authentication failed. Please check your API key.',
  timeout: 'Connection timeout. The endpoint did not respond.',
  network: 'Network error. Please check your internet connection.',
  unknown: 'Connection test failed. Please try again.'
};

/** Request failed before an HTTP response was received */
class ProfileRequestError extends Error {
  constructor(public readonly kind: ProfileErrorKind) {
    super(`Profile request failed: ${kind}`);
    this.name = 'ProfileRequestError';
  }
}

/** Release the connection when the response body is not going to be read */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Body already consumed or closed; nothing to release
  }
}

/**
 * fetch against an Anthropic-compatible endpoint with the 10 s timeout and no retries.
 * Does not throw on non-2xx; throws ProfileRequestError for timeout/network/user abort.
 */
async function anthropicFetch(
  url: string,
  apiKey: string,
  options: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal } = {}
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(PROFILE_REQUEST_TIMEOUT_MS);
  const combined = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const headers: Record<string, string> = {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    accept: 'application/json'
  };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  try {
    return await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: combined
    });
  } catch {
    if (options.signal?.aborted) {
      throw new ProfileRequestError('unknown'); // user abort, like the SDK's APIUserAbortError
    }
    if (timeoutSignal.aborted) {
      throw new ProfileRequestError('timeout');
    }
    throw new ProfileRequestError('network');
  }
}

/** Map an HTTP status of a failed response to an error kind */
function mapStatusToErrorKind(status: number): ProfileErrorKind {
  if (status === 401) return 'auth';
  if (status === 404) return 'endpoint';
  return 'unknown';
}

/** Map a thrown value from anthropicFetch to an error kind */
function mapFailureToErrorKind(error: unknown): ProfileErrorKind {
  return error instanceof ProfileRequestError ? error.kind : 'unknown';
}


/**
 * Input type for creating a profile (without id, createdAt, updatedAt)
 */
export type CreateProfileInput = Omit<APIProfile, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * Input type for updating a profile (with id, without createdAt, updatedAt)
 */
export type UpdateProfileInput = Pick<APIProfile, 'id'> & CreateProfileInput;

/**
 * Validate base URL format
 * Accepts HTTP(S) URLs with valid endpoints
 */
export function validateBaseUrl(baseUrl: string): boolean {
  if (!baseUrl || baseUrl.trim() === '') {
    return false;
  }

  try {
    const url = new URL(baseUrl);
    // Only allow http and https protocols
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate API key format
 * Accepts various API key formats (Anthropic, OpenAI, custom)
 */
export function validateApiKey(apiKey: string): boolean {
  if (!apiKey || apiKey.trim() === '') {
    return false;
  }

  const trimmed = apiKey.trim();

  // Too short to be a real API key
  if (trimmed.length < 12) {
    return false;
  }

  // Accept common API key formats
  // Anthropic: sk-ant-...
  // OpenAI: sk-proj-... or sk-...
  // Custom: any reasonable length key with alphanumeric chars
  const hasValidChars = /^[a-zA-Z0-9\-_+.]+$/.test(trimmed);

  return hasValidChars;
}

/**
 * Validate that profile name is unique (case-insensitive, trimmed)
 *
 * WARNING: This is for UX feedback only. Do NOT rely on this for correctness.
 * The actual uniqueness check happens atomically inside create/update operations
 * to prevent TOCTOU race conditions.
 */
export async function validateProfileNameUnique(name: string): Promise<boolean> {
  const trimmed = name.trim().toLowerCase();

  const file = await loadProfilesFile();

  // Check if any profile has the same name (case-insensitive)
  const exists = file.profiles.some(
    (p) => p.name.trim().toLowerCase() === trimmed
  );

  return !exists;
}

/**
 * Delete a profile with validation
 * Throws errors for validation failures
 * Uses atomic operation to prevent race conditions
 */
export async function deleteProfile(id: string): Promise<void> {
  await atomicModifyProfiles((file) => {
    // Find the profile
    const profileIndex = file.profiles.findIndex((p) => p.id === id);
    if (profileIndex === -1) {
      throw new Error('Profile not found');
    }

    // Active Profile Check: Cannot delete active profile (AC3)
    if (file.activeProfileId === id) {
      throw new Error('Cannot delete active profile. Please switch to another profile or OAuth first.');
    }

    // Remove profile
    file.profiles.splice(profileIndex, 1);

    // Last Profile Fallback: If no profiles remain, set activeProfileId to null (AC4)
    if (file.profiles.length === 0) {
      file.activeProfileId = null;
    }

    return file;
  });
}

/**
 * Create a new profile with validation
 * Throws errors for validation failures
 * Uses atomic operation to prevent race conditions in concurrent profile creation
 */
export async function createProfile(input: CreateProfileInput): Promise<APIProfile> {
  // Validate base URL
  if (!validateBaseUrl(input.baseUrl)) {
    throw new Error('Invalid base URL');
  }

  // Validate API key
  if (!validateApiKey(input.apiKey)) {
    throw new Error('Invalid API key');
  }

  // Use atomic operation to ensure uniqueness check and creation happen together
  // This prevents TOCTOU race where another process creates the same profile name
  // between our check and write
  const newProfile = await atomicModifyProfiles((file) => {
    // Re-check uniqueness within the lock (this is the authoritative check)
    const trimmed = input.name.trim().toLowerCase();
    const exists = file.profiles.some(
      (p) => p.name.trim().toLowerCase() === trimmed
    );

    if (exists) {
      throw new Error('A profile with this name already exists');
    }

    // Create new profile
    const now = Date.now();
    const profile: APIProfile = {
      id: generateProfileId(),
      name: input.name.trim(),
      baseUrl: input.baseUrl.trim(),
      apiKey: input.apiKey.trim(),
      models: input.models,
      createdAt: now,
      updatedAt: now
    };

    // Add to profiles list
    file.profiles.push(profile);

    // Set as active if it's the first profile
    if (file.profiles.length === 1) {
      file.activeProfileId = profile.id;
    }

    return file;
  });

  // Find and return the newly created profile
  const createdProfile = newProfile.profiles[newProfile.profiles.length - 1];
  return createdProfile;
}

/**
 * Update an existing profile with validation
 * Throws errors for validation failures
 * Uses atomic operation to prevent race conditions in concurrent profile updates
 */
export async function updateProfile(input: UpdateProfileInput): Promise<APIProfile> {
  // Validate base URL
  if (!validateBaseUrl(input.baseUrl)) {
    throw new Error('Invalid base URL');
  }

  // Validate API key
  if (!validateApiKey(input.apiKey)) {
    throw new Error('Invalid API key');
  }

  // Use atomic operation to ensure uniqueness check and update happen together
  const modifiedFile = await atomicModifyProfiles((file) => {
    // Find the profile
    const profileIndex = file.profiles.findIndex((p) => p.id === input.id);
    if (profileIndex === -1) {
      throw new Error('Profile not found');
    }

    const existingProfile = file.profiles[profileIndex];

    // Validate profile name uniqueness (exclude current profile from check)
    // This check happens atomically within the lock
    if (input.name.trim().toLowerCase() !== existingProfile.name.trim().toLowerCase()) {
      const trimmed = input.name.trim().toLowerCase();
      const nameExists = file.profiles.some(
        (p) => p.id !== input.id && p.name.trim().toLowerCase() === trimmed
      );
      if (nameExists) {
        throw new Error('A profile with this name already exists');
      }
    }

    // Update profile (including name)
    const newBaseUrl = input.baseUrl.trim();
    const newApiKey = input.apiKey.trim();
    const credentialsChanged =
      newBaseUrl !== existingProfile.baseUrl || newApiKey !== existingProfile.apiKey;

    // A changed key or endpoint starts unverified (drops any stale 'rejected')
    const base = credentialsChanged ? withKeyStatusReset(existingProfile) : existingProfile;
    const updated: APIProfile = {
      ...base,
      name: input.name.trim(),
      baseUrl: newBaseUrl,
      apiKey: newApiKey,
      models: input.models,
      updatedAt: Date.now()
    };

    // Replace in profiles list
    file.profiles[profileIndex] = updated;

    return file;
  });

  // Find and return the updated profile
  const updatedProfile = modifiedFile.profiles.find((p) => p.id === input.id)!;
  return updatedProfile;
}

/**
 * Get environment variables for the active API profile
 *
 * Maps the active API profile to SDK environment variables for injection
 * into Python subprocess. Returns empty object when no profile is active
 * (OAuth mode), allowing CLAUDE_CODE_OAUTH_TOKEN to be used instead.
 *
 * Environment Variable Mapping:
 * - profile.baseUrl → ANTHROPIC_BASE_URL
 * - profile.apiKey → ANTHROPIC_AUTH_TOKEN
 * - profile.models.default → ANTHROPIC_MODEL
 * - profile.models.haiku → ANTHROPIC_DEFAULT_HAIKU_MODEL
 * - profile.models.sonnet → ANTHROPIC_DEFAULT_SONNET_MODEL
 * - profile.models.opus → ANTHROPIC_DEFAULT_OPUS_MODEL
 *
 * Empty string values are filtered out (not set as env vars).
 *
 * @returns Promise<Record<string, string>> Environment variables for active profile
 */
export async function getAPIProfileEnv(): Promise<Record<string, string>> {
  // Load profiles.json
  const file = await loadProfilesFile();

  // If no active profile (null/empty), return empty object (OAuth mode)
  if (!file.activeProfileId || file.activeProfileId === '') {
    return {};
  }

  // Find active profile by activeProfileId
  const profile = file.profiles.find((p) => p.id === file.activeProfileId);

  // If profile not found, return empty object (shouldn't happen with valid data)
  if (!profile) {
    return {};
  }

  // Map profile fields to SDK env vars
  const envVars: Record<string, string> = {
    ANTHROPIC_BASE_URL: profile.baseUrl || '',
    ANTHROPIC_AUTH_TOKEN: profile.apiKey || '',
    ANTHROPIC_MODEL: profile.models?.default || '',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: profile.models?.haiku || '',
    ANTHROPIC_DEFAULT_SONNET_MODEL: profile.models?.sonnet || '',
    ANTHROPIC_DEFAULT_OPUS_MODEL: profile.models?.opus || '',
  };

  // Filter out empty/whitespace string values (only set env vars that have values)
  // This handles empty strings, null, undefined, and whitespace-only values
  const filteredEnvVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(envVars)) {
    const trimmedValue = value?.trim();
    if (trimmedValue && trimmedValue !== '') {
      filteredEnvVars[key] = trimmedValue;
    }
  }

  return filteredEnvVars;
}

/**
 * Test API profile connection
 *
 * Validates credentials by making a minimal API request to the /v1/models endpoint.
 * Uses fetch with a 10 s timeout and no retries for immediate feedback.
 *
 * @param baseUrl - API base URL (will be normalized)
 * @param apiKey - API key for authentication
 * @param signal - Optional AbortSignal for cancelling the request
 * @returns Promise<TestConnectionResult> Result of connection test
 */
export async function testConnection(
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<TestConnectionResult> {
  // Validate API key first (key format doesn't depend on URL normalization)
  if (!validateApiKey(apiKey)) {
    return {
      success: false,
      errorType: 'auth',
      message: 'Authentication failed. Please check your API key.'
    };
  }

  // Normalize baseUrl BEFORE validation (allows auto-prepending https://)
  let normalizedUrl = baseUrl.trim();

  // Store original URL for error suggestions
  const originalUrl = normalizedUrl;

  // If empty, return error
  if (!normalizedUrl) {
    return {
      success: false,
      errorType: 'endpoint',
      message: 'Invalid endpoint. Please check the Base URL.'
    };
  }

  // Ensure https:// prefix (auto-prepend if NO protocol exists)
  if (!normalizedUrl.includes('://')) {
    normalizedUrl = `https://${normalizedUrl}`;
  }

  // Remove trailing slash
  normalizedUrl = normalizedUrl.replace(/\/+$/, '');

  // Helper function to generate URL suggestions
  const getUrlSuggestions = (url: string): string[] => {
    const suggestions: string[] = [];

    if (!url.includes('://')) {
      suggestions.push('Ensure URL starts with https://');
    }

    if (url.endsWith('/')) {
      suggestions.push('Remove trailing slashes from URL');
    }

    const domainMatch = url.match(/:\/\/([^/]+)/);
    if (domainMatch) {
      const domain = domainMatch[1];
      if (domain.includes('anthropiic') || domain.includes('anthhropic') ||
          domain.includes('anhtropic') || domain.length < 10) {
        suggestions.push('Check for typos in domain name');
      }
    }

    return suggestions;
  };

  // Validate the normalized baseUrl
  if (!validateBaseUrl(normalizedUrl)) {
    const suggestions = getUrlSuggestions(originalUrl);
    const message = suggestions.length > 0
      ? `Invalid endpoint. Please check the Base URL.${suggestions.map(s => ' ' + s).join('')}`
      : 'Invalid endpoint. Please check the Base URL.';

    return {
      success: false,
      errorType: 'endpoint',
      message
    };
  }

  // Check if signal already aborted
  if (signal?.aborted) {
    return {
      success: false,
      errorType: 'timeout',
      message: 'Connection timeout. The endpoint did not respond.'
    };
  }

  const endpointResult = (): TestConnectionResult => {
    const suggestions = getUrlSuggestions(baseUrl.trim());
    const message = suggestions.length > 0
      ? `Invalid endpoint. Please check the Base URL.${suggestions.map(s => ' ' + s).join('')}`
      : 'Invalid endpoint. Please check the Base URL.';
    return { success: false, errorType: 'endpoint', message };
  };
  const failureResult = (kind: ProfileErrorKind): TestConnectionResult =>
    kind === 'endpoint'
      ? endpointResult()
      : { success: false, errorType: kind, message: PROFILE_ERROR_MESSAGES[kind] };

  try {
    // Make minimal request to test connection (pass signal for cancellation)
    // Try models list first, but some Anthropic-compatible APIs don't support it
    const modelsResponse = await anthropicFetch(`${normalizedUrl}/v1/models?limit=1`, apiKey, { signal });
    await discardBody(modelsResponse);

    if (modelsResponse.ok) {
      return { success: true, message: 'Connection successful' };
    }

    if (modelsResponse.status !== 404) {
      return failureResult(mapStatusToErrorKind(modelsResponse.status));
    }

    // Models endpoint returned 404: try messages endpoint instead
    // Many Anthropic-compatible APIs (e.g., MiniMax) only support /v1/messages
    // The test request is invalid (400/422) but proves the endpoint is reachable
    const messagesResponse = await anthropicFetch(`${normalizedUrl}/v1/messages`, apiKey, {
      method: 'POST',
      body: { model: 'test', max_tokens: 1, messages: [{ role: 'user', content: 'test' }] },
      signal
    });
    await discardBody(messagesResponse);

    if (messagesResponse.ok || messagesResponse.status === 400 || messagesResponse.status === 422) {
      return { success: true, message: 'Connection successful' };
    }
    return failureResult(mapStatusToErrorKind(messagesResponse.status));
  } catch (error) {
    return failureResult(mapFailureToErrorKind(error));
  }
}

/**
 * Discover available models from API endpoint
 *
 * Fetches the list of available models from the Anthropic-compatible /v1/models endpoint.
 * Uses fetch with a 10 s timeout and no retries for immediate feedback.
 *
 * @param baseUrl - API base URL (will be normalized)
 * @param apiKey - API key for authentication
 * @param signal - Optional AbortSignal for cancelling the request (checked before request)
 * @returns Promise<DiscoverModelsResult> List of available models
 * @throws Error with errorType for auth/network/endpoint/timeout/not_supported failures
 */
export async function discoverModels(
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<DiscoverModelsResult> {
  // Validate API key first
  if (!validateApiKey(apiKey)) {
    const error: Error & { errorType?: string } = new Error('Authentication failed. Please check your API key.');
    error.errorType = 'auth';
    throw error;
  }

  // Normalize baseUrl BEFORE validation
  let normalizedUrl = baseUrl.trim();

  // If empty, throw error
  if (!normalizedUrl) {
    const error: Error & { errorType?: string } = new Error('Invalid endpoint. Please check the Base URL.');
    error.errorType = 'endpoint';
    throw error;
  }

  // Ensure https:// prefix (auto-prepend if NO protocol exists)
  if (!normalizedUrl.includes('://')) {
    normalizedUrl = `https://${normalizedUrl}`;
  }

  // Remove trailing slash
  normalizedUrl = normalizedUrl.replace(/\/+$/, '');

  // Validate the normalized baseUrl
  if (!validateBaseUrl(normalizedUrl)) {
    const error: Error & { errorType?: string } = new Error('Invalid endpoint. Please check the Base URL.');
    error.errorType = 'endpoint';
    throw error;
  }

  // Check if signal already aborted
  if (signal?.aborted) {
    const error: Error & { errorType?: string } = new Error('Connection timeout. The endpoint did not respond.');
    error.errorType = 'timeout';
    throw error;
  }

  try {
    // Fetch models (1000 limit to get all), pass signal for cancellation
    const response = await anthropicFetch(`${normalizedUrl}/v1/models?limit=1000`, apiKey, { signal });

    if (!response.ok) {
      await discardBody(response);
      const kind = mapStatusToErrorKind(response.status);
      throw new ProfileRequestError(kind);
    }

    let payload: { data?: Array<{ id?: string; display_name?: string }> };
    try {
      payload = await response.json();
    } catch {
      throw new ProfileRequestError('unknown');
    }
    if (!payload || !Array.isArray(payload.data)) {
      throw new ProfileRequestError('unknown');
    }

    const models: ModelInfo[] = payload.data
      .map((model) => ({
        id: model?.id || '',
        display_name: model?.display_name || model?.id || ''
      }))
      .filter((model) => model.id.length > 0);

    return { models };
  } catch (error) {
    const kind = mapFailureToErrorKind(error);
    // For model listing a 404 means the endpoint has no models route
    const isNotSupported = kind === 'endpoint';
    const message = isNotSupported
      ? 'This API endpoint does not support model listing. Please enter the model name manually.'
      : PROFILE_ERROR_MESSAGES[kind as Exclude<ProfileErrorKind, 'endpoint'>];
    const thrown: Error & { errorType?: string } = new Error(message);
    thrown.errorType = isNotSupported ? 'not_supported' : kind;
    throw thrown;
  }
}
