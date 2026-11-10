/**
 * zeenha fork: TASK_CREATE and TASK_UPDATE validate `metadata.taskDependencies`
 * before writing anything. A rejected save returns a stable machine-readable
 * error and leaves task_metadata.json untouched.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../shared/constants';
import { registerTaskCRUDHandlers } from '../crud-handlers';

const handlers = vi.hoisted(() => new Map<string, Function>());
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: Function) => handlers.set(ch, fn), on: vi.fn() },
  nativeImage: {},
  BrowserWindow: class {},
  shell: { openPath: vi.fn() },
  app: { getPath: () => os.tmpdir(), isPackaged: false, on: vi.fn() },
}));

const ref = vi.hoisted(() => ({
  projectPath: '',
  tasks: [] as Array<Record<string, unknown>>,
  current: { id: 'a', specId: 'a', status: 'backlog', title: 'A', metadata: {} } as Record<string, unknown>,
}));

vi.mock('../shared', () => ({
  findTaskAndProject: () => ({
    task: ref.current,
    project: { id: 'p1', path: ref.projectPath, autoBuildPath: '.auto-claude', settings: {} },
  }),
}));

vi.mock('../../../project-store', () => ({
  projectStore: {
    getProject: () => ({ id: 'p1', path: ref.projectPath, autoBuildPath: '.auto-claude', settings: {} }),
    getTasks: () => ref.tasks,
    invalidateTasksCache: vi.fn(),
  },
}));
vi.mock('../../../title-generator', () => ({ titleGenerator: {} }));
vi.mock('../../../agent', () => ({ AgentManager: class {} }));
vi.mock('../../../task-state-manager', () => ({ taskStateManager: {} }));
vi.mock('../../../sentry', () => ({ safeBreadcrumb: vi.fn() }));

function mkTask(id: string, deps?: string[]) {
  return { id, specId: id, status: 'backlog', title: id, metadata: deps ? { taskDependencies: deps } : {} };
}

function metadataPath(specId: string) {
  return path.join(ref.projectPath, '.auto-claude', 'specs', specId, 'task_metadata.json');
}

function handler(channel: string) {
  // biome-ignore lint/suspicious/noExplicitAny: a minimal AgentManager stand-in
  registerTaskCRUDHandlers({} as any);
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`${channel} handler was not registered`);
  return fn;
}

type Res = { success: boolean; error?: string; data?: { metadata?: { taskDependencies?: string[] } } };
const update = (taskId: string, deps: string[]) =>
  handler(IPC_CHANNELS.TASK_UPDATE)({}, taskId, { metadata: { taskDependencies: deps } }) as Promise<Res>;
const create = (deps: string[]) =>
  handler(IPC_CHANNELS.TASK_CREATE)({}, 'p1', 'New task', 'desc', { taskDependencies: deps }) as Promise<Res>;

beforeEach(() => {
  handlers.clear();
  ref.projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'task-deps-'));
  for (const id of ['a', 'b', 'c']) {
    fs.mkdirSync(path.join(ref.projectPath, '.auto-claude', 'specs', id), { recursive: true });
  }
  ref.tasks = [mkTask('a'), mkTask('b', ['a']), mkTask('c', ['b'])];
  ref.current = ref.tasks[0];
});

describe('TASK_UPDATE dependency validation (zeenha fork)', () => {
  it('rejects a cycle and writes nothing', async () => {
    const res = await update('a', ['c']);
    expect(res.success).toBe(false);
    expect(res.error).toBe('DEPENDENCY_CYCLE:a->c->b->a');
    expect(fs.existsSync(metadataPath('a'))).toBe(false);
  });

  it('rejects a self-dependency', async () => {
    const res = await update('a', ['a']);
    expect(res).toEqual({ success: false, error: 'DEPENDENCY_SELF:a' });
    expect(fs.existsSync(metadataPath('a'))).toBe(false);
  });

  it('rejects an unknown id', async () => {
    const res = await update('a', ['nope']);
    expect(res).toEqual({ success: false, error: 'DEPENDENCY_UNKNOWN:nope' });
    expect(fs.existsSync(metadataPath('a'))).toBe(false);
  });

  it('persists a valid, de-duplicated list', async () => {
    ref.current = ref.tasks[2];
    const res = await update('c', ['a', 'a', 'b']);
    expect(res.success).toBe(true);
    expect(JSON.parse(fs.readFileSync(metadataPath('c'), 'utf-8')).taskDependencies).toEqual(['a', 'b']);
  });

  it('allows clearing the list with an empty array', async () => {
    ref.current = ref.tasks[1];
    const res = await update('b', []);
    expect(res.success).toBe(true);
    expect(JSON.parse(fs.readFileSync(metadataPath('b'), 'utf-8')).taskDependencies).toEqual([]);
  });
});

describe('TASK_CREATE dependency validation (zeenha fork)', () => {
  const specDirs = () => fs.readdirSync(path.join(ref.projectPath, '.auto-claude', 'specs')).sort();

  it('rejects an unknown id and creates nothing', async () => {
    const res = await create(['nope']);
    expect(res).toEqual({ success: false, error: 'DEPENDENCY_UNKNOWN:nope' });
    expect(specDirs()).toEqual(['a', 'b', 'c']);
  });

  it('persists a valid list', async () => {
    const res = await create(['a', 'a', 'b']);
    expect(res.success).toBe(true);
    expect(res.data?.metadata?.taskDependencies).toEqual(['a', 'b']);
    const created = specDirs().find((d) => !['a', 'b', 'c'].includes(d)) as string;
    expect(JSON.parse(fs.readFileSync(metadataPath(created), 'utf-8')).taskDependencies).toEqual(['a', 'b']);
  });

  it('allows an empty list', async () => {
    expect((await create([])).success).toBe(true);
  });
});
