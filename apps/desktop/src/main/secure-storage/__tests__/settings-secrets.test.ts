import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAccount } from '../../../shared/types/provider-account';
import { isSecretEnvelope } from '../../../shared/utils/secret-envelope';
import { clearSecretCacheForTests, encryptSecret, SecureStorageUnavailableError } from '../secret-storage';
import { clearSessionApiKeys, getSessionApiKey, setSessionApiKey } from '../session-credentials';
import { decodeSettingsSecrets, encodeSettingsSecrets } from '../settings-secrets';

const safeStorage = vi.hoisted(() => {
  let nonce = 0;
  const transform = (bytes: Buffer) => Buffer.from(bytes.map((byte) => byte ^ 0xff));
  return {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: () => 'gnome_libsecret',
    // Vary ciphertext per encryption so tests can detect unnecessary rewrites.
    encryptString: vi.fn((key: string) => Buffer.concat([Buffer.from([nonce++]), transform(Buffer.from(key))])),
    decryptString: (bytes: Buffer) => transform(bytes.subarray(1)).toString(),
  };
});
vi.mock('electron', () => ({ safeStorage }));

const account = {
  id: 'account-1',
  name: 'Test account',
  provider: 'openai',
  authType: 'api-key',
  billingModel: 'pay-per-use',
  apiKey: 'test-provider-key',
  createdAt: 1,
  updatedAt: 1,
} satisfies ProviderAccount;

const legacyKeys = {
  globalAnthropicApiKey: 'legacy-anthropic',
  globalOpenAIApiKey: 'legacy-openai',
  globalGoogleApiKey: 'legacy-google',
  globalGroqApiKey: 'legacy-groq',
  globalOpenRouterApiKey: 'legacy-openrouter',
  globalMistralApiKey: 'legacy-mistral',
  globalXAIApiKey: 'legacy-xai',
  globalAzureApiKey: 'legacy-azure',
  memoryVoyageApiKey: 'legacy-memory-voyage',
  memoryAzureApiKey: 'legacy-memory-azure',
  memoryGoogleApiKey: 'legacy-memory-google',
};

describe('settings secret codec', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearSecretCacheForTests();
    clearSessionApiKeys();
  });

  it('records and encrypts all legacy key fields without mutating the input', () => {
    const raw = { ...legacyKeys, providerAccounts: [account] };
    const { settings, legacyPlaintext } = decodeSettingsSecrets(raw);
    expect(settings).toEqual(raw);
    expect(settings.providerAccounts?.[0]).not.toBe(raw.providerAccounts[0]);
    expect(legacyPlaintext).toEqual(new Set([...Object.values(legacyKeys), account.apiKey]));

    const encoded = encodeSettingsSecrets(settings, legacyPlaintext);
    const { providerAccounts, ...encodedKeys } = encoded;
    expect(Object.values(encodedKeys).every(isSecretEnvelope)).toBe(true);
    expect(providerAccounts?.[0]).not.toBe(settings.providerAccounts?.[0]);
    expect(isSecretEnvelope(providerAccounts?.[0].apiKey)).toBe(true);
    expect(JSON.stringify(encoded)).not.toContain(account.apiKey);
    expect(settings).toEqual(raw);
    expect(raw).toEqual({ ...legacyKeys, providerAccounts: [account] });
    expect(decodeSettingsSecrets(encoded)).toEqual({ settings: raw, legacyPlaintext: new Set() });
  });

  it('reuses each field’s original envelope even when the plaintext is shared', () => {
    const raw = {
      globalOpenAIApiKey: encryptSecret(account.apiKey),
      providerAccounts: [{ ...account, apiKey: encryptSecret(account.apiKey) }],
    };
    expect(raw.globalOpenAIApiKey).not.toBe(raw.providerAccounts[0].apiKey);
    const { settings, legacyPlaintext } = decodeSettingsSecrets(raw);
    safeStorage.encryptString.mockClear();

    expect(encodeSettingsSecrets(settings, legacyPlaintext)).toEqual(raw);
    expect(encodeSettingsSecrets(raw, new Set())).toEqual(raw);
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
  });

  it('does not let existing plaintext authorize plaintext in a different field', () => {
    safeStorage.isEncryptionAvailable.mockReturnValue(false);
    const raw = { providerAccounts: [account], globalOpenAIApiKey: '', memoryVoyageApiKey: undefined };
    const { settings, legacyPlaintext } = decodeSettingsSecrets(raw);
    expect(encodeSettingsSecrets(settings, legacyPlaintext)).toEqual(raw);

    settings.globalOpenAIApiKey = account.apiKey;
    expect(() => encodeSettingsSecrets(settings, legacyPlaintext)).toThrow(SecureStorageUnavailableError);
  });

  it('injects session keys on read and only updates them after persistence succeeds', () => {
    const { apiKey, ...metadata } = account;
    const raw = { providerAccounts: [{ ...metadata, apiKeySessionOnly: true }] };
    setSessionApiKey(account.id, apiKey);
    const { settings, legacyPlaintext } = decodeSettingsSecrets(raw);
    expect(settings.providerAccounts?.[0].apiKey).toBe(apiKey);
    expect(raw.providerAccounts[0]).not.toHaveProperty('apiKey');

    settings.providerAccounts = [{ ...account, apiKeySessionOnly: true, apiKey: 'new-session-key' }];
    expect(() => encodeSettingsSecrets(settings, legacyPlaintext, () => {
      throw new Error('Disk write failed');
    })).toThrow('Disk write failed');
    expect(getSessionApiKey(account.id)).toBe(apiKey);
    expect(encodeSettingsSecrets(settings, legacyPlaintext)).toEqual(raw);
    expect(getSessionApiKey(account.id)).toBe('new-session-key');
  });
});
