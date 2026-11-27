// zeenha fork: encrypt settings credentials at the disk boundary, never falling back
// to plaintext for new writes.
import type { AppSettings, ProviderAccount } from '../../shared/types';
import { isSecretEnvelope } from '../../shared/utils/secret-envelope';
import { decryptSecret, encryptSecret, isSecureStorageAvailable, SecureStorageUnavailableError } from './secret-storage';
import { deleteSessionApiKey, getSessionApiKey, setSessionApiKey } from './session-credentials';

const legacyKeyFields = [
  'globalAnthropicApiKey',
  'globalOpenAIApiKey',
  'globalGoogleApiKey',
  'globalGroqApiKey',
  'globalOpenRouterApiKey',
  'globalMistralApiKey',
  'globalXAIApiKey',
  'globalAzureApiKey',
  'memoryVoyageApiKey',
  'memoryAzureApiKey',
  'memoryGoogleApiKey',
] as const satisfies readonly (keyof AppSettings)[];

type OriginalSecret = { plaintext: string; envelope?: string };
// Scope the plaintext-to-envelope cache to one disk snapshot. Matching the field
// as well as the value prevents copying legacy plaintext into new fields and
// preserves distinct envelopes even when two accounts have the same key.
const originalSecrets = new WeakMap<Set<string>, Map<string, OriginalSecret>>();

function visitAccountKeys(
  settings: Partial<AppSettings>,
  visit: (account: ProviderAccount, slot: string) => void,
): void {
  if (!Array.isArray(settings.providerAccounts)) return;

  const occurrences = new Map<string, number>();
  settings.providerAccounts.forEach((account, index) => {
    if (!account || typeof account !== 'object' || Array.isArray(account)) return;
    const id = typeof account.id === 'string' ? account.id : index;
    const identity = JSON.stringify(id);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    visit(account, `providerAccounts:${identity}:${occurrence}`);
  });
}

export function decodeSettingsSecrets(raw: Partial<AppSettings>): {
  settings: Partial<AppSettings>;
  legacyPlaintext: Set<string>;
} {
  const settings = structuredClone(raw);
  const legacyPlaintext = new Set<string>();
  const originals = new Map<string, OriginalSecret>();
  originalSecrets.set(legacyPlaintext, originals);

  function decode(value: unknown, slot: string): string | undefined {
    if (isSecretEnvelope(value)) {
      const plaintext = decryptSecret(value);
      if (plaintext === null) return value;
      originals.set(slot, { plaintext, envelope: value });
      return plaintext;
    }
    if (typeof value === 'string' && value.length > 0) {
      legacyPlaintext.add(value);
      originals.set(slot, { plaintext: value });
    }
    return undefined;
  }

  for (const field of legacyKeyFields) {
    const decoded = decode(settings[field], field);
    if (decoded !== undefined) settings[field] = decoded;
  }
  visitAccountKeys(settings, (account, slot) => {
    const decoded = decode(account.apiKey, slot);
    if (decoded !== undefined) account.apiKey = decoded;
    if (account.apiKeySessionOnly === true && !account.apiKey && typeof account.id === 'string') {
      const sessionKey = getSessionApiKey(account.id);
      if (sessionKey !== undefined) account.apiKey = sessionKey;
    }
  });
  return { settings, legacyPlaintext };
}

/** Encode a decoded snapshot. If supplied, persist must succeed before session keys change. */
export function encodeSettingsSecrets(
  settings: Partial<AppSettings>,
  legacyPlaintext: Set<string>,
  persist?: (encoded: Partial<AppSettings>) => void,
): Partial<AppSettings> {
  const encoded = structuredClone(settings);
  const originals = originalSecrets.get(legacyPlaintext);
  const sessionChanges = new Map<string, string | undefined>();

  function encode(value: unknown, slot: string): string | undefined {
    const original = originals?.get(slot);
    if (original?.envelope && original.plaintext === value) return original.envelope;
    if (isSecretEnvelope(value) || typeof value !== 'string' || value.length === 0) return undefined;
    if (isSecureStorageAvailable()) return encryptSecret(value);
    if (original?.plaintext === value && legacyPlaintext.has(value)) return undefined;
    throw new SecureStorageUnavailableError();
  }

  for (const field of legacyKeyFields) {
    const encrypted = encode(encoded[field], field);
    if (encrypted !== undefined) encoded[field] = encrypted;
  }
  visitAccountKeys(encoded, (account, slot) => {
    if (account.apiKeySessionOnly === true) {
      const key: unknown = account.apiKey;
      if (typeof account.id === 'string') {
        sessionChanges.set(account.id, !isSecretEnvelope(key) && typeof key === 'string' && key ? key : undefined);
      }
      delete account.apiKey;
    } else {
      const encrypted = encode(account.apiKey, slot);
      if (encrypted !== undefined) account.apiKey = encrypted;
      if (typeof account.id === 'string') sessionChanges.set(account.id, undefined);
    }
  });

  persist?.(encoded);
  for (const [id, key] of sessionChanges) {
    if (key === undefined) deleteSessionApiKey(id);
    else setSessionApiKey(id, key);
  }
  return encoded;
}
