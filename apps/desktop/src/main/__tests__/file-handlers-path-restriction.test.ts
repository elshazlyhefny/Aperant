import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { IPC_CHANNELS } from '../../shared/constants';

let projectDir = '';
const handlers = new Map<string, (...args: any[]) => Promise<any>>();

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...args: any[]) => Promise<any>) => handlers.set(ch, fn) }
}));
vi.mock('../ipc-sender-validation', () => ({ assertTrustedSender: () => true }));
vi.mock('../project-store', () => ({
  projectStore: { getProjects: () => [{ id: 'p1', path: projectDir }] }
}));

import { registerFileHandlers } from '../ipc-handlers/file-handlers';

const list = (p: string) => handlers.get(IPC_CHANNELS.FILE_EXPLORER_LIST)!({}, p);
const read = (p: string) => handlers.get(IPC_CHANNELS.FILE_EXPLORER_READ)!({}, p);

let base = '';
let evilDir = '';

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fh-')));
  projectDir = path.join(base, 'proj');
  evilDir = path.join(base, 'proj-evil');
  fs.mkdirSync(projectDir);
  fs.mkdirSync(evilDir);
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(evilDir, 'secret.txt'), 'secret');
  fs.symlinkSync(evilDir, path.join(projectDir, 'link'));
  registerFileHandlers();
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('file explorer path restriction', () => {
  it('lists and reads inside the project', async () => {
    const l = await list(projectDir);
    expect(l.success).toBe(true);
    const r = await read(path.join(projectDir, 'a.txt'));
    expect(r).toEqual({ success: true, data: 'hello' });
  });

  it('rejects paths outside registered projects', async () => {
    const r = await read('/etc/passwd');
    expect(r).toEqual({ success: false, error: 'Path is outside registered projects' });
    expect((await list(os.homedir())).success).toBe(false);
  });

  it('rejects ../ escapes', async () => {
    const r = await read(path.join(projectDir, '..', 'proj-evil', 'secret.txt'));
    expect(r.success).toBe(false);
    expect(r.error).toBe('Path is outside registered projects');
  });

  it('rejects symlinks pointing outside the project', async () => {
    const r = await read(path.join(projectDir, 'link', 'secret.txt'));
    expect(r.success).toBe(false);
    expect((await list(path.join(projectDir, 'link'))).success).toBe(false);
  });

  it('rejects sibling directories sharing the path prefix', async () => {
    const r = await read(path.join(evilDir, 'secret.txt'));
    expect(r.success).toBe(false);
    expect((await list(evilDir)).success).toBe(false);
  });
});
