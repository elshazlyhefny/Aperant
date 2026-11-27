// zeenha fork: offer session-only keys without writing them to disk.
const sessionApiKeys = new Map<string, string>();

export function setSessionApiKey(accountId: string, apiKey: string): void {
  sessionApiKeys.set(accountId, apiKey);
}

export function getSessionApiKey(accountId: string): string | undefined {
  return sessionApiKeys.get(accountId);
}

export function deleteSessionApiKey(accountId: string): void {
  sessionApiKeys.delete(accountId);
}

export function clearSessionApiKeys(): void {
  sessionApiKeys.clear();
}
