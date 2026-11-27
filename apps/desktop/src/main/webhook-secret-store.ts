/**
 * zeenha fork: project webhook signing keys live in userData, never in the
 * repository or settings.json, so a hostile repository cannot supply or read a key.
 */
import { app } from 'electron';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decryptToken, encryptToken, isTokenEncrypted } from './claude-profile/token-encryption';
import { generateProjectWebhookSecret, type ProjectWebhookSigningRecord } from './project-webhook-signing';

const URL_HASH_PATTERN = /^[0-9a-f]{64}$/;

type StoredSigningRecord = { urlHash: string; createdAt: string } &
  ({ mode: 'signed'; secret: string } | { mode: 'unsigned' });

interface SigningFile {
  version: 1;
  projects: Record<string, StoredSigningRecord>;
}

function getStorePath(): string {
  return path.join(app.getPath('userData'), 'webhook-signing-secrets.json');
}

function parseRecord(value: unknown): StoredSigningRecord | null {
  if (!value || typeof value !== 'object') return null;
  const { urlHash, mode, secret, createdAt } = value as Record<string, unknown>;
  if (typeof urlHash !== 'string' || !URL_HASH_PATTERN.test(urlHash) || typeof createdAt !== 'string') {
    return null;
  }
  if (mode === 'unsigned') return { urlHash, mode, createdAt };
  if (mode === 'signed' && typeof secret === 'string') {
    // Keep the signed intent even if the credential was not safely stored.
    return { urlHash, mode, secret: isTokenEncrypted(secret) ? secret : '', createdAt };
  }
  return null;
}

function readFile(): SigningFile {
  const projects: Record<string, StoredSigningRecord> = Object.create(null);
  const data: SigningFile = { version: 1, projects };
  try {
    const parsed = JSON.parse(readFileSync(getStorePath(), 'utf-8'));
    if (parsed?.version !== 1 || !parsed.projects || typeof parsed.projects !== 'object' || Array.isArray(parsed.projects)) {
      return data;
    }
    for (const [key, value] of Object.entries(parsed.projects)) {
      const record = parseRecord(value);
      if (record) projects[key] = record;
    }
  } catch {
    // Missing or corrupt: no signing records are available.
  }
  return data;
}

function writeFile(data: SigningFile): void {
  const storePath = getStorePath();
  mkdirSync(path.dirname(storePath), { recursive: true });
  const tmp = `${storePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, storePath);
  try {
    chmodSync(storePath, 0o600);
  } catch {
    // Best effort on platforms/filesystems that do not support POSIX modes.
  }
}

function update(projectPath: string, record: StoredSigningRecord): void {
  if (!URL_HASH_PATTERN.test(record.urlHash)) throw new Error('Invalid webhook URL hash');
  const data = readFile();
  data.projects[path.resolve(projectPath)] = record;
  writeFile(data);
}

export function getProjectWebhookSigningRecord(projectPath: string): ProjectWebhookSigningRecord | null {
  const record = readFile().projects[path.resolve(projectPath)];
  if (!record) return null;
  const { urlHash, mode, createdAt } = record;
  const stored = record.mode === 'signed' ? record.secret : '';
  const decrypted = stored ? decryptToken(stored) : '';
  // decryptToken can return the ciphertext unchanged when safeStorage is unavailable.
  return { urlHash, mode, secret: decrypted === stored ? '' : decrypted, createdAt };
}

export function createProjectWebhookSecret(projectPath: string, urlHash: string): string {
  const secret = generateProjectWebhookSecret();
  const encrypted = encryptToken(secret);
  // The legacy token helper falls back to plaintext. Never persist that fallback.
  if (!isTokenEncrypted(encrypted)) throw new Error('Secure storage is unavailable for webhook signing');
  update(projectPath, { urlHash, mode: 'signed', secret: encrypted, createdAt: new Date().toISOString() });
  return secret;
}

export function setProjectWebhookUnsigned(projectPath: string, urlHash: string): void {
  update(projectPath, { urlHash, mode: 'unsigned', createdAt: new Date().toISOString() });
}

export function removeProjectWebhookSigning(projectPath: string): void {
  const data = readFile();
  const key = path.resolve(projectPath);
  if (!data.projects[key]) return;
  delete data.projects[key];
  writeFile(data);
}
