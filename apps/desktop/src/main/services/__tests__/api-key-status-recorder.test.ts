/**
 * Tests for api-key-status-recorder.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProfilesFile } from '@shared/types/profile';

const { mockRead, mockWrite, MockUnreadable } = vi.hoisted(() => ({
  mockRead: vi.fn(),
  mockWrite: vi.fn(),
  MockUnreadable: class extends Error {}
}));

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/mock') } }));
vi.mock('../../settings-utils', () => ({
  updateSettingsFile: vi.fn(async (mutator: (s: Record<string, unknown>) => unknown) => {
    const settings = (mockRead() ?? {}) as Record<string, unknown>;
    const before = JSON.stringify(settings);
    const result = await mutator(settings);
    if (JSON.stringify(settings) !== before) mockWrite(settings);
    return result;
  }),
  SettingsUnreadableError: MockUnreadable
}));

let file: ProfilesFile;
vi.mock('../profile/api-profile-store', () => ({
  atomicModifyProfiles: vi.fn(async (modifier: (f: ProfilesFile) => ProfilesFile) => {
    file = modifier(file);
    return file;
  })
}));

import { recordApiKeyOutcome, outcomeFromConnectionError } from '../api-key-status-recorder';

function profilesFile(extra: Record<string, unknown> = {}): ProfilesFile {
  return {
    profiles: [
      { id: 'p1', name: 'P', baseUrl: 'https://x.test', apiKey: 'sk-12345678901', createdAt: 1, updatedAt: 1, ...extra }
    ],
    activeProfileId: null,
    version: 1
  };
}

describe('recordApiKeyOutcome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRead.mockReturnValue({ providerAccounts: [] });
    file = profilesFile();
  });

  it('writes rejected for a profiles.json profile (bare and api- prefixed id)', async () => {
    expect(await recordApiKeyOutcome('p1', 'rejected')).toBe(true);
    expect(file.profiles[0].keyStatus).toBe('rejected');
    expect(file.profiles[0].keyStatusAt).toBeTypeOf('number');

    file = profilesFile();
    expect(await recordApiKeyOutcome('api-p1', 'rejected')).toBe(true);
    expect(file.profiles[0].keyStatus).toBe('rejected');
  });

  it('valid clears a rejection', async () => {
    file = profilesFile({ keyStatus: 'rejected', keyStatusAt: 5 });
    expect(await recordApiKeyOutcome('p1', 'valid')).toBe(true);
    expect(file.profiles[0].keyStatus).toBe('valid');
  });

  it('does not write when the status is unchanged', async () => {
    file = profilesFile({ keyStatus: 'valid', keyStatusAt: 5 });
    expect(await recordApiKeyOutcome('p1', 'valid')).toBe(false);
    expect(file.profiles[0].keyStatusAt).toBe(5);
  });

  it('records on a ProviderAccount api-key account', async () => {
    mockRead.mockReturnValue({
      providerAccounts: [{ id: 'pa_1', authType: 'api-key', provider: 'openai', name: 'A' }]
    });
    expect(await recordApiKeyOutcome('pa_1', 'rejected')).toBe(true);
    const saved = mockWrite.mock.calls[0][0] as { providerAccounts: Array<{ keyStatus?: string }> };
    expect(saved.providerAccounts[0].keyStatus).toBe('rejected');
  });

  it('ignores OAuth accounts', async () => {
    mockRead.mockReturnValue({
      providerAccounts: [{ id: 'pa_2', authType: 'oauth', provider: 'anthropic', name: 'O' }]
    });
    expect(await recordApiKeyOutcome('pa_2', 'rejected')).toBe(false);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('returns false for unknown ids without throwing', async () => {
    await expect(recordApiKeyOutcome('nope', 'rejected')).resolves.toBe(false);
    await expect(recordApiKeyOutcome('pa_missing', 'rejected')).resolves.toBe(false);
  });

  it('returns false instead of throwing when storage fails', async () => {
    mockRead.mockImplementation(() => {
      throw new Error('disk');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(recordApiKeyOutcome('p1', 'rejected')).resolves.toBe(false);
  });

  it('returns false and warns when settings.json is unreadable', async () => {
    mockRead.mockImplementation(() => {
      throw new MockUnreadable('unreadable');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(recordApiKeyOutcome('pa_1', 'rejected')).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});

describe('outcomeFromConnectionError', () => {
  it.each([
    ['auth', 'rejected'],
    ['network', null],
    ['timeout', null],
    ['endpoint', null],
    ['unknown', null],
    ['not_supported', null],
    [undefined, null]
  ] as const)('%s -> %s', (input, expected) => {
    expect(outcomeFromConnectionError(input)).toBe(expected);
  });
});
