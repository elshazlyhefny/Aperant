import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ipcMain, ipcRenderer } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTaskAPI } from '../../../../preload/api/task-api';
import { IPC_CHANNELS } from '../../../../shared/constants';
import type { Project } from '../../../../shared/types';
import { createDeliveryReceiptRecorder } from '../../../delivery-receipts';
import { projectStore } from '../../../project-store';
import { registerTaskDeliveryReceiptsHandlers } from '../delivery-receipts-handlers';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, ipcRenderer: { invoke: vi.fn() } }));
vi.mock('../../../project-store', () => ({ projectStore: { getProject: vi.fn() } }));

const specId = '001-task';
let fixture: string;
let projectRoot: string;
let otherRoot: string;
let read: ReturnType<typeof createTaskAPI>['getTaskDeliveryReceipts'];

beforeEach(async () => {
  vi.clearAllMocks();
  fixture = await mkdtemp(path.join(os.tmpdir(), 'delivery-receipts-ipc-'));
  projectRoot = path.join(fixture, 'first');
  otherRoot = path.join(fixture, 'second');
  await Promise.all([mkdir(projectRoot), mkdir(otherRoot)]);
  vi.mocked(projectStore.getProject).mockImplementation((id) => {
    if (id === 'first') return { id, path: projectRoot, autoBuildPath: 'custom' } as Project;
    if (id === 'second') return { id, path: otherRoot } as Project;
  });
  registerTaskDeliveryReceiptsHandlers();
  const [[channel, handler]] = vi.mocked(ipcMain.handle).mock.calls;
  vi.mocked(ipcRenderer.invoke).mockImplementation(async (name, ...args) => {
    expect(name).toBe(channel);
    return handler({} as Electron.IpcMainInvokeEvent, ...args);
  });
  read = createTaskAPI().getTaskDeliveryReceipts;
});

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

describe('task delivery receipt IPC', () => {
  it('registers only a read channel and leaves missing storage untouched', async () => {
    expect(ipcMain.handle).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.TASK_DELIVERY_RECEIPTS_GET, expect.any(Function));
    await expect(read('first', specId)).resolves.toEqual({ success: true, data: [] });
    expect(ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.TASK_DELIVERY_RECEIPTS_GET, 'first', specId);
    expect(await readdir(projectRoot)).toEqual([]);
  });

  it('reads only the requested spec in the requested registered project without altering storage', async () => {
    const first = await createDeliveryReceiptRecorder(projectRoot, specId).skip({ operation: 'webhook', event: 'review_ready' }, 'event_disabled');
    const second = await createDeliveryReceiptRecorder(otherRoot, specId).skip({ operation: 'issue_comment', event: 'failed' }, 'not_linked');
    const otherSpec = await createDeliveryReceiptRecorder(projectRoot, '002-task').skip({ operation: 'webhook', event: 'blocked' }, 'event_disabled');
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(otherSpec).toBeDefined();
    const file = path.join(projectRoot, '.auto-claude', 'delivery-receipts.json');
    const before = await readFile(file, 'utf8');

    await expect(read('first', specId)).resolves.toEqual({ success: true, data: [first] });
    await expect(read('second', specId)).resolves.toEqual({ success: true, data: [second] });
    await expect(read('first', '002-task')).resolves.toEqual({ success: true, data: [otherSpec] });
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await readdir(path.dirname(file))).toEqual(['delivery-receipts.json']);
  });

  it.each(['../private-path', 'bad\\path', '\0', '', null, { id: specId }])('rejects malformed spec IDs before looking up projects: %j', async (id) => {
    await expect(read('first', id as string)).resolves.toEqual({ success: false, error: 'Invalid spec ID' });
    expect(projectStore.getProject).not.toHaveBeenCalled();
  });

  it('rejects malformed and unknown project IDs', async () => {
    await expect(read({ path: projectRoot } as unknown as string, specId)).resolves.toEqual({ success: false, error: 'Invalid project ID' });
    expect(projectStore.getProject).not.toHaveBeenCalled();
    await expect(read(projectRoot, specId)).resolves.toEqual({ success: false, error: 'Project not found' });
  });

  it('returns a fixed error for unreadable storage without exposing or rewriting it', async () => {
    const dir = path.join(projectRoot, '.auto-claude');
    await mkdir(dir);
    const sentinel = 'private file contents';
    const file = path.join(dir, 'delivery-receipts.json');
    await writeFile(file, sentinel);

    await expect(read('first', specId)).resolves.toEqual({ success: false, error: 'Delivery receipt history is unreadable.' });
    expect(await readFile(file, 'utf8')).toBe(sentinel);
  });
});
