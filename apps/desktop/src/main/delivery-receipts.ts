/** zeenha fork: desktop and headless share a project-local, observational delivery history. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
// @ts-expect-error - no types available for proper-lockfile
import * as lockfile from 'proper-lockfile';
import { z } from 'zod';
import {
  DELIVERY_EVENTS,
  DELIVERY_OPERATIONS,
  DELIVERY_PROVIDERS,
  DELIVERY_REASONS,
  type DeliveryOperation,
  type DeliveryReceipt,
  type DeliveryResult,
} from '../shared/types/delivery-receipt';
import { isValidTaskId } from './utils/spec-path-helpers';

const LIMIT = 200;
const MAX_FILE_BYTES = 128 * 1024;
const FILE_NAME = 'delivery-receipts.json';
const STORE_UNAVAILABLE = 'Delivery receipt history is unreadable.';
const WRITE_WARNING = '[delivery-receipts] Could not save delivery history.';
const UNCONFIRMED = { status: 'unknown', reason: 'unconfirmed' } as const;

const operationSchema = z.object({
  operation: z.enum(DELIVERY_OPERATIONS),
  event: z.enum(DELIVERY_EVENTS),
  provider: z.enum(DELIVERY_PROVIDERS).optional(),
});
const resultFields = {
  attempts: z.number().int().min(1).max(3).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
};
const delivered = { ...resultFields, status: z.literal('delivered') };
const skipped = { ...resultFields, status: z.literal('skipped'), reason: z.enum(DELIVERY_REASONS.skipped) };
const failed = { ...resultFields, status: z.literal('failed'), reason: z.enum(DELIVERY_REASONS.failed) };
const unknown = { ...resultFields, status: z.literal('unknown'), reason: z.enum(DELIVERY_REASONS.unknown) };
const resultSchema = z.discriminatedUnion('status', [z.object(delivered), z.object(skipped), z.object(failed), z.object(unknown)]);
const receiptFields = {
  ...operationSchema.shape,
  id: z.uuidv4(),
  createdAt: z.iso.datetime({ precision: 3 }),
  completedAt: z.iso.datetime({ precision: 3 }).optional(),
};
const receiptSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...receiptFields, ...delivered }),
  z.strictObject({ ...receiptFields, ...skipped }),
  z.strictObject({ ...receiptFields, ...failed }),
  z.strictObject({ ...receiptFields, ...unknown }),
]).refine((receipt) => receipt.completedAt === undefined
  ? receipt.status === 'unknown' && receipt.reason === 'unconfirmed'
  : receipt.completedAt >= receipt.createdAt);
const storeSchema = z.strictObject({
  version: z.literal(1),
  rows: z.array(z.strictObject({ specHash: z.string().regex(/^[a-f0-9]{64}$/), receipt: receiptSchema })).max(LIMIT),
});
type StoredRow = z.infer<typeof storeSchema>['rows'][number];

function scope(specId: string): string | undefined {
  return isValidTaskId(specId) ? createHash('sha256').update(specId).digest('hex') : undefined;
}

function newestFirst(a: DeliveryReceipt, b: DeliveryReceipt): number {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
  return a.id === b.id ? 0 : a.id > b.id ? -1 : 1;
}

async function statIfPresent(file: string): Promise<Stats | undefined> {
  try {
    return await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function sameEntry(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

async function checkDirectory(dir: string, expected: Stats): Promise<void> {
  const current = await lstat(dir);
  if (!current.isDirectory() || !sameEntry(current, expected)) throw new Error(STORE_UNAVAILABLE);
}

async function readRows(file: string, directory: Stats): Promise<StoredRow[]> {
  const entry = await statIfPresent(file);
  if (!entry) return [];
  if (!entry.isFile() || entry.size > MAX_FILE_BYTES) throw new Error(STORE_UNAVAILABLE);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || (!constants.O_NOFOLLOW && !sameEntry(opened, entry))) throw new Error(STORE_UNAVAILABLE);
    await checkDirectory(path.dirname(file), directory);
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_FILE_BYTES) throw new Error(STORE_UNAVAILABLE);
    const parsed = storeSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))));
    if (!parsed.success) throw new Error(STORE_UNAVAILABLE);
    const { rows } = parsed.data;
    if (new Set(rows.map(({ receipt }) => receipt.id)).size !== rows.length) throw new Error(STORE_UNAVAILABLE);
    return rows;
  } finally {
    await handle.close();
  }
}

/** projectRoot is the trusted registered project path, not an input worktree or spec path. */
export async function readDeliveryReceipts(projectRoot: string, specId: string): Promise<DeliveryReceipt[]> {
  const specHash = scope(specId);
  if (!specHash) throw new Error('Invalid spec ID for delivery history.');
  try {
    const dir = path.join(await realpath(projectRoot), '.auto-claude');
    const directory = await statIfPresent(dir);
    if (!directory) return [];
    if (!directory.isDirectory()) throw new Error(STORE_UNAVAILABLE);
    const rows = await readRows(path.join(dir, FILE_NAME), directory);
    return rows.filter((row) => row.specHash === specHash).map(({ receipt }) => receipt).sort(newestFirst);
  } catch {
    // Never reflect paths, file contents, parser diagnostics, or OS errors.
    throw new Error(STORE_UNAVAILABLE);
  }
}

async function replaceRows(file: string, rows: StoredRow[], directory: Stats, checkLock: () => void): Promise<void> {
  const dir = path.dirname(file);
  const temporary = path.join(dir, `.${FILE_NAME}.${randomUUID()}.tmp`);
  await checkDirectory(dir, directory);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify({ version: 1, rows }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await checkDirectory(dir, directory);
    checkLock();
    await rename(temporary, file);
  } catch (error) {
    // Do not clean up via a directory path that has since been replaced.
    await checkDirectory(dir, directory).then(() => unlink(temporary)).catch(() => {});
    throw error;
  }
}

// Queue per canonical path so aliases share a queue and unrelated projects don't block each other.
const queues = new Map<string, Promise<void>>();

async function saveReceipt(projectRoot: string, row: StoredRow, replace: boolean): Promise<void> {
  const dir = path.join(await realpath(projectRoot), '.auto-claude');
  const file = path.join(dir, FILE_NAME);
  const lockPath = `${file}.lock`;
  const previous = queues.get(file) ?? Promise.resolve();
  const next = previous.then(async () => {
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const directory = await lstat(dir);
    if (!directory.isDirectory()) throw new Error(STORE_UNAVAILABLE);
    const lockEntry = await statIfPresent(lockPath);
    if (lockEntry && !lockEntry.isDirectory()) throw new Error(STORE_UNAVAILABLE);
    let compromised = false;
    const release: () => Promise<void> = await lockfile.lock(file, {
      realpath: false,
      lockfilePath: lockPath,
      retries: { retries: 4, minTimeout: 25, maxTimeout: 100 },
      onCompromised: () => { compromised = true; },
    });
    try {
      await checkDirectory(dir, directory);
      const rows = await readRows(file, directory);
      if (replace) {
        const index = rows.findIndex(({ receipt, specHash }) => receipt.id === row.receipt.id && specHash === row.specHash);
        if (index === -1) return; // The marker was pruned or could not be saved.
        rows[index] = row;
      } else {
        rows.push(row);
      }
      rows.sort((a, b) => newestFirst(a.receipt, b.receipt));
      await replaceRows(file, rows.slice(0, LIMIT), directory, () => {
        if (compromised) throw new Error(STORE_UNAVAILABLE);
      });
    } finally {
      await release();
    }
  });
  const tail = next.catch(() => {});
  queues.set(file, tail);
  try {
    await next;
  } finally {
    if (queues.get(file) === tail) queues.delete(file);
  }
}

type SkippedResult = Extract<DeliveryResult, { status: 'skipped' }>;

export interface DeliveryReceiptRecorder {
  skip(operation: DeliveryOperation, reason: SkippedResult['reason']): Promise<DeliveryReceipt | undefined>;
  /** Call the existing sender once. Unexpected sender errors propagate after recording unknown. */
  track(operation: DeliveryOperation, send: () => Promise<DeliveryResult>): Promise<DeliveryReceipt | undefined>;
  snapshot(): DeliveryReceipt[];
}

/** One recorder per outcome. Only safe projections survive even when disk is unavailable. */
export function createDeliveryReceiptRecorder(projectRoot: string, specId: string): DeliveryReceiptRecorder {
  const specHash = scope(specId);
  const receipts = new Map<string, DeliveryReceipt>();

  function start(operation: DeliveryOperation, result: DeliveryResult): DeliveryReceipt | undefined {
    const parsed = operationSchema.safeParse(operation);
    if (!parsed.success) return;
    return { ...parsed.data, ...result, id: randomUUID(), createdAt: new Date().toISOString() };
  }

  async function remember(receipt: DeliveryReceipt, replace = false): Promise<void> {
    receipts.set(receipt.id, receipt);
    try {
      if (!specHash) throw new Error(STORE_UNAVAILABLE);
      await saveReceipt(projectRoot, { specHash, receipt }, replace);
    } catch {
      console.warn(WRITE_WARNING);
    }
  }

  function finish({ id, operation, event, provider, createdAt }: DeliveryReceipt, result: DeliveryResult): DeliveryReceipt {
    const completedAt = new Date().toISOString();
    return { id, operation, event, provider, createdAt, ...result, completedAt: completedAt < createdAt ? createdAt : completedAt };
  }

  return {
    async skip(operation, reason) {
      const result = resultSchema.safeParse({ status: 'skipped', reason });
      if (!result.success) return;
      const receipt = start(operation, result.data);
      if (!receipt) return;
      const completed = finish(receipt, result.data);
      await remember(completed);
      return { ...completed };
    },
    async track(operation, send) {
      // A saved unknown marker says only that no acknowledgment was saved. The
      // process can stop before send even starts, so readers never replay it.
      const marker = start(operation, UNCONFIRMED);
      if (marker) await remember(marker);
      let result: DeliveryResult;
      try {
        const parsed = resultSchema.safeParse(await send());
        result = parsed.success ? parsed.data : UNCONFIRMED;
      } catch (error) {
        if (marker) await remember(finish(marker, UNCONFIRMED), true);
        throw error;
      }
      if (!marker) return;
      const completed = finish(marker, result);
      await remember(completed, true);
      return { ...completed };
    },
    snapshot() {
      return [...receipts.values()].sort(newestFirst).map((receipt) => ({ ...receipt }));
    },
  };
}
