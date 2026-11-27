/** zeenha fork: exercise the same receipt store the desktop and CLI will share. */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeliveryResult } from '../../shared/types/delivery-receipt';
import { createDeliveryReceiptRecorder, readDeliveryReceipts } from '../delivery-receipts';
import { isWindows } from '../platform';

const spec = '001-private-task-name';
const operation = { operation: 'webhook', event: 'review_ready', provider: 'slack' } as const;
const secret = 'do-not-echo-this-fixture';
const unavailable = 'Delivery receipt history is unreadable.';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('delivery receipts', () => {
  let root: string;
  let dir: string;
  let file: string;
  let project: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'delivery-receipts-test-'));
    project = path.join(root, 'project');
    await mkdir(project);
    dir = path.join(project, '.auto-claude');
    file = path.join(dir, 'delivery-receipts.json');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('reads missing history without creating a directory or file', async () => {
    expect(await readDeliveryReceipts(project, spec)).toEqual([]);
    expect(await readdir(project)).toEqual([]);
    await mkdir(dir);
    expect(await readDeliveryReceipts(project, spec)).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
    await expect(readDeliveryReceipts(project, `../${secret}`)).rejects.toThrow('Invalid spec ID for delivery history.');
  });

  it('saves an unconfirmed marker before entering the sender and replaces that ID on completion', async () => {
    const recorder = createDeliveryReceiptRecorder(project, spec);
    const started = deferred<void>();
    const acknowledgment = deferred<DeliveryResult>();
    const send = vi.fn(() => { started.resolve(); return acknowledgment.promise; });
    const pending = recorder.track({ ...operation, ...{ url: secret } }, send);
    await started.promise;
    const before = await readFile(file, 'utf-8');
    const [marker] = await readDeliveryReceipts(project, spec);
    expect(marker).toMatchObject({ ...operation, status: 'unknown', reason: 'unconfirmed' });
    expect(marker.completedAt).toBeUndefined();
    expect(await readDeliveryReceipts(project, spec)).toEqual([marker]);
    expect(await readFile(file, 'utf-8')).toBe(before);
    expect(before).not.toContain(spec);
    expect(before).not.toContain(secret);
    expect(send).toHaveBeenCalledTimes(1);
    acknowledgment.resolve({ status: 'delivered', attempts: 2, httpStatus: 204, ...{ responseBody: secret } });
    const receipt = await pending;
    expect(receipt).toMatchObject({ ...operation, id: marker.id, createdAt: marker.createdAt, status: 'delivered', attempts: 2, httpStatus: 204 });
    expect(receipt?.reason).toBeUndefined();
    expect(receipt?.completedAt).toBeDefined();
    expect(await readDeliveryReceipts(project, spec)).toEqual([receipt]);
    expect(recorder.snapshot()).toEqual([receipt]);
    expect(await readFile(file, 'utf-8')).not.toContain(secret);
    expect(await readdir(dir)).toEqual(['delivery-receipts.json']);
    if (!isWindows()) expect((await lstat(file)).mode & 0o777).toBe(0o600);
  });

  it('serializes concurrent writes across recorders and scopes rows by project and spec', async () => {
    const otherProject = path.join(root, 'other');
    await mkdir(otherProject);
    const first = createDeliveryReceiptRecorder(project, spec);
    const otherSpec = createDeliveryReceiptRecorder(project, '002-other-task');
    const other = createDeliveryReceiptRecorder(otherProject, spec);
    const writes = Array.from({ length: 20 }, (_, i) => (i % 2 ? first : otherSpec).skip(operation, 'event_disabled'));
    const [, otherReceipt] = await Promise.all([Promise.all(writes), other.skip(operation, 'missing_target')]);
    expect(await readDeliveryReceipts(project, spec)).toEqual(first.snapshot());
    expect(await readDeliveryReceipts(project, spec)).toHaveLength(10);
    expect(await readDeliveryReceipts(project, '002-other-task')).toEqual(otherSpec.snapshot());
    expect(await readDeliveryReceipts(project, '002-other-task')).toHaveLength(10);
    expect(await readDeliveryReceipts(otherProject, spec)).toEqual([otherReceipt]);
  });

  it('caps the project history by creation time and never resurrects a pruned marker', async () => {
    const recorder = createDeliveryReceiptRecorder(project, spec);
    const started = deferred<void>();
    const acknowledgment = deferred<DeliveryResult>();
    const pending = recorder.track(operation, () => { started.resolve(); return acknowledgment.promise; });
    await started.promise;
    const { rows: [marker] } = JSON.parse(await readFile(file, 'utf-8'));
    const otherRecorder = createDeliveryReceiptRecorder(project, '002-other-task');
    const sample = await otherRecorder.skip(operation, 'missing_target');
    const { rows } = JSON.parse(await readFile(file, 'utf-8'));
    const otherHash = rows.find((row: typeof marker) => row.receipt.id === sample?.id).specHash;
    // Fixture history, deliberately unsorted and with tied creation times.
    const later = '2000-01-01T00:00:00.000Z';
    const fixtureRows = Array.from({ length: 199 }, () => ({
      specHash: otherHash,
      receipt: { ...sample, id: randomUUID(), createdAt: later, completedAt: later },
    }));
    await writeFile(file, JSON.stringify({ version: 1, rows: [
      ...fixtureRows, { ...marker, receipt: { ...marker.receipt, createdAt: '1900-01-01T00:00:00.000Z' } },
    ] }));
    const newReceipt = await otherRecorder.skip(operation, 'event_disabled');
    const newest = await readDeliveryReceipts(project, '002-other-task');
    expect(newest.map(({ id }) => id)).toEqual([newReceipt?.id, ...fixtureRows.map(({ receipt }) => receipt.id).sort().reverse()]);
    const capped = await readFile(file, 'utf-8');
    expect(JSON.parse(capped).rows).toHaveLength(200);
    acknowledgment.resolve({ status: 'delivered' });
    expect(await pending).toMatchObject({ status: 'delivered', id: marker.receipt.id });
    expect(await readDeliveryReceipts(project, spec)).toEqual([]);
    expect(await readFile(file, 'utf-8')).toBe(capped);
  });

  it('keeps comment and transition results independent', async () => {
    const recorder = createDeliveryReceiptRecorder(project, spec);
    const comment = await recorder.track({ ...operation, operation: 'issue_comment', provider: 'jira' }, async () => ({
      status: 'failed', reason: 'rate_limited', httpStatus: 429,
    }));
    const transition = await recorder.skip({ ...operation, operation: 'issue_transition', provider: 'jira' }, 'state_unavailable');
    const history = await readDeliveryReceipts(project, spec);
    expect(history).toHaveLength(2);
    expect(history).toEqual(expect.arrayContaining([comment, transition]));
  });

  it('rejects malformed and unsupported history without exposing diagnostics or overwriting it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recorder = createDeliveryReceiptRecorder(project, spec);
    await recorder.skip(operation, 'missing_target');
    const { rows: [valid] } = JSON.parse(await readFile(file, 'utf-8'));
    const malformed = [
      secret,
      JSON.stringify({ version: 2, rows: [] }),
      JSON.stringify({ version: 1, rows: [{ ...valid, receipt: { ...valid.receipt, provider: secret } }] }),
      JSON.stringify({ version: 1, rows: [{ ...valid, receipt: { ...valid.receipt, body: secret } }] }),
      JSON.stringify({ version: 1, rows: [valid, valid] }),
      'x'.repeat(128 * 1024 + 1),
    ];
    for (const content of malformed) {
      await writeFile(file, content);
      await expect(readDeliveryReceipts(project, spec)).rejects.toThrow(unavailable);
    }
    await writeFile(file, secret);
    const send = vi.fn(async () => ({ status: 'delivered' } as const));
    expect(await recorder.track(operation, send)).toMatchObject({ status: 'delivered' });
    expect(recorder.snapshot()).toHaveLength(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await readFile(file, 'utf-8')).toBe(secret);
    expect(warn.mock.calls).toEqual(Array.from({ length: 2 }, () => ['[delivery-receipts] Could not save delivery history.']));
  });

  it('retains only a safe unknown result for invalid or thrown sender results', async () => {
    const recorder = createDeliveryReceiptRecorder(project, spec);
    const invalid = await recorder.track(operation, async () => ({ status: 'delivered', attempts: 4, httpStatus: 600 }));
    expect(invalid).toMatchObject({ status: 'unknown', reason: 'unconfirmed' });
    await expect(recorder.track(operation, async () => { throw new Error(secret); })).rejects.toThrow(secret);
    expect(await readDeliveryReceipts(project, spec)).toEqual(recorder.snapshot());
    expect(recorder.snapshot()).toHaveLength(2);
    expect(await readFile(file, 'utf-8')).not.toContain(secret);
  });

  it('reads without acquiring the receipt lock and continues delivery if the lock is busy', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recorder = createDeliveryReceiptRecorder(project, spec);
    const original = await recorder.skip(operation, 'event_disabled');
    await mkdir(`${file}.lock`);
    expect(await readDeliveryReceipts(project, spec)).toEqual([original]);
    const send = vi.fn(async () => ({ status: 'unknown', reason: 'timeout' } as const));
    expect(await recorder.track(operation, send)).toMatchObject({ status: 'unknown', reason: 'timeout' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await readDeliveryReceipts(project, spec)).toEqual([original]);
    expect((await lstat(`${file}.lock`)).isDirectory()).toBe(true);
  });

  it.skipIf(isWindows())('rejects directory, file and lock symlinks without writing outside the project', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const outsideFile = path.join(root, 'outside.json');
    await writeFile(outsideFile, secret);
    const recorder = createDeliveryReceiptRecorder(project, spec);
    await symlink(root, dir, 'dir');
    await expect(readDeliveryReceipts(project, spec)).rejects.toThrow(unavailable);
    await recorder.skip(operation, 'invalid_target');
    expect(await readdir(root)).toEqual(['outside.json', 'project']);
    await rm(dir);
    await mkdir(dir);
    await symlink(outsideFile, file, 'file');
    await expect(readDeliveryReceipts(project, spec)).rejects.toThrow(unavailable);
    await recorder.skip(operation, 'invalid_target');
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
    expect(await readFile(outsideFile, 'utf-8')).toBe(secret);
    await rm(file);
    await symlink(root, `${file}.lock`, 'dir');
    await recorder.skip(operation, 'invalid_target');
    expect(await readDeliveryReceipts(project, spec)).toEqual([]);
    expect(await readdir(dir)).toEqual(['delivery-receipts.json.lock']);
  });
});
