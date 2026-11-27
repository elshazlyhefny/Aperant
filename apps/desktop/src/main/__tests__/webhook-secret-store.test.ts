import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isWindows } from '../platform';
import { hashWebhookUrl } from '../project-webhook-approval';
import {
  createProjectWebhookSecret,
  getProjectWebhookSigningRecord,
  removeProjectWebhookSigning,
  setProjectWebhookUnsigned
} from '../webhook-secret-store';

const state = vi.hoisted(() => ({
  dir: '',
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((s: string) => Buffer.from(`x:${s}`)),
  decryptString: vi.fn((b: Buffer) => b.toString().slice(2))
}));
vi.mock('electron', () => ({
  app: { getPath: () => state.dir },
  safeStorage: {
    isEncryptionAvailable: state.isEncryptionAvailable,
    encryptString: state.encryptString,
    decryptString: state.decryptString
  }
}));

const STORE_NAME = 'webhook-signing-secrets.json';
const PROJECT = resolve('project');
const URL_HASH = hashWebhookUrl('https://example.test/hooks/one');
const OTHER_HASH = hashWebhookUrl('https://example.test/hooks/two');

function storePath(): string {
  return join(state.dir, STORE_NAME);
}

beforeEach(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'webhook-secret-store-'));
});

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  rmSync(state.dir, { recursive: true, force: true });
});

describe('webhook-secret-store', () => {
  it('returns no record when the store is missing', () => {
    expect(getProjectWebhookSigningRecord(PROJECT)).toBeNull();
  });

  it('round-trips an encrypted key without writing the plaintext or leaving a temp file', () => {
    const secret = createProjectWebhookSecret(PROJECT, URL_HASH);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const record = getProjectWebhookSigningRecord(PROJECT);
    expect(record).toEqual({ urlHash: URL_HASH, mode: 'signed', secret, createdAt: expect.any(String) });
    expect(new Date(record?.createdAt ?? '').toISOString()).toBe(record?.createdAt);
    const raw = readFileSync(storePath(), 'utf-8');
    expect(raw).not.toContain(secret);
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      projects: {
        [PROJECT]: { ...record, secret: `enc:${Buffer.from(`x:${secret}`).toString('base64')}` }
      }
    });
    expect(readdirSync(state.dir)).toEqual([STORE_NAME]);
    if (!isWindows()) expect(statSync(storePath()).mode & 0o777).toBe(0o600);
  });

  it('rotates the stored key and binds it to the supplied URL hash', () => {
    const original = createProjectWebhookSecret(PROJECT, URL_HASH);
    const rotated = createProjectWebhookSecret(PROJECT, URL_HASH);
    expect(rotated).not.toBe(original);
    expect(getProjectWebhookSigningRecord(PROJECT)?.secret).toBe(rotated);
    const newDestination = createProjectWebhookSecret(PROJECT, OTHER_HASH);
    expect(newDestination).not.toBe(rotated);
    expect(getProjectWebhookSigningRecord(PROJECT)).toMatchObject({ urlHash: OTHER_HASH, secret: newDestination });
  });

  it('discards the key when switching to unsigned and supports removing the record', () => {
    createProjectWebhookSecret(PROJECT, URL_HASH);
    setProjectWebhookUnsigned(PROJECT, URL_HASH);
    expect(getProjectWebhookSigningRecord(PROJECT)).toMatchObject({ urlHash: URL_HASH, mode: 'unsigned', secret: '' });
    expect(JSON.parse(readFileSync(storePath(), 'utf-8')).projects[PROJECT]).not.toHaveProperty('secret');
    removeProjectWebhookSigning(PROJECT);
    expect(getProjectWebhookSigningRecord(PROJECT)).toBeNull();
  });

  it('returns no record for corrupt JSON and recovers on write', () => {
    writeFileSync(storePath(), '{not json');
    expect(getProjectWebhookSigningRecord(PROJECT)).toBeNull();
    const secret = createProjectWebhookSecret(PROJECT, URL_HASH);
    expect(getProjectWebhookSigningRecord(PROJECT)?.secret).toBe(secret);
  });

  it('drops malformed entries without discarding a valid record', () => {
    const valid = { urlHash: URL_HASH, mode: 'unsigned', createdAt: new Date().toISOString() };
    const invalid = [
      null,
      { ...valid, urlHash: 'invalid hash' },
      { ...valid, mode: 'invalid mode' },
      { ...valid, createdAt: 0 },
      { ...valid, mode: 'signed' },
      { ...valid, mode: 'signed', secret: 42 }
    ];
    const projects = { [PROJECT]: valid, ...Object.fromEntries(invalid.map((entry, i) => [resolve(`bad${i}`), entry])) };
    writeFileSync(storePath(), JSON.stringify({ version: 1, projects }));
    for (let i = 0; i < invalid.length; i++) {
      expect(getProjectWebhookSigningRecord(resolve(`bad${i}`))).toBeNull();
    }
    expect(getProjectWebhookSigningRecord(PROJECT)).toEqual({ ...valid, secret: '' });
    setProjectWebhookUnsigned(PROJECT, URL_HASH);
    expect(Object.keys(JSON.parse(readFileSync(storePath(), 'utf-8')).projects)).toEqual([PROJECT]);
  });

  it('normalises paths and isolates projects', () => {
    const secret = createProjectWebhookSecret(`parent/../project/`, URL_HASH);
    const other = resolve('other');
    setProjectWebhookUnsigned(other, OTHER_HASH);
    expect(getProjectWebhookSigningRecord(PROJECT)?.secret).toBe(secret);
    expect(getProjectWebhookSigningRecord(other)).toMatchObject({ urlHash: OTHER_HASH, secret: '' });
    removeProjectWebhookSigning('parent/../project/');
    expect(getProjectWebhookSigningRecord(PROJECT)).toBeNull();
    expect(getProjectWebhookSigningRecord(other)?.mode).toBe('unsigned');
  });

  it('retains the signed record with no usable secret when decryption throws', () => {
    createProjectWebhookSecret(PROJECT, URL_HASH);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    state.decryptString.mockImplementationOnce(() => {
      throw new Error('Decryption failed');
    });
    expect(getProjectWebhookSigningRecord(PROJECT)).toMatchObject({ urlHash: URL_HASH, mode: 'signed', secret: '' });
  });

  it('rejects plaintext fallbacks and preserves the existing record when secure storage is unavailable', () => {
    createProjectWebhookSecret(PROJECT, URL_HASH);
    const before = readFileSync(storePath(), 'utf-8');
    state.isEncryptionAvailable.mockReturnValue(false);
    expect(getProjectWebhookSigningRecord(PROJECT)).toMatchObject({ urlHash: URL_HASH, mode: 'signed', secret: '' });
    expect(() => createProjectWebhookSecret(PROJECT, OTHER_HASH)).toThrow('Secure storage is unavailable');
    expect(readFileSync(storePath(), 'utf-8')).toBe(before);
  });

  it('does not accept a plaintext value from a signed record as a key', () => {
    writeFileSync(storePath(), JSON.stringify({
      version: 1,
      projects: { [PROJECT]: { urlHash: URL_HASH, mode: 'signed', createdAt: '', secret: 'not encrypted' } }
    }));
    expect(getProjectWebhookSigningRecord(PROJECT)).toMatchObject({ urlHash: URL_HASH, mode: 'signed', secret: '' });
    expect(state.decryptString).not.toHaveBeenCalled();
  });
});
