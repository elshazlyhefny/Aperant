// zeenha fork: share the stored format with headless consumers without loading Electron.
export const SECRET_ENVELOPE_PREFIX = 'aperant-secret:v1:';

/** Recognize even malformed envelopes so they are never used as credentials. */
export function isSecretEnvelope(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SECRET_ENVELOPE_PREFIX);
}

export function wrapEnvelope(base64: string): string {
  return SECRET_ENVELOPE_PREFIX + base64;
}

export function unwrapEnvelope(envelope: string): string | null {
  if (!isSecretEnvelope(envelope)) return null;

  const payload = envelope.slice(SECRET_ENVELOPE_PREFIX.length);
  // Buffer's base64 decoder is permissive; reject malformed payloads before decryption.
  return payload.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(payload) ? payload : null;
}
