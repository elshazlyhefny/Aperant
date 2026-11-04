/**
 * zeenha fork: the Memory settings page reads the database path and the
 * project's memory count from CONTEXT_MEMORY_STATUS.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@libsql/client';

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, fn) },
}));
vi.mock('../../../project-store', () => ({
  projectStore: { getProject: (id: string) => (id === 'project-1' ? { id } : undefined) },
}));

let db: Client;
vi.mock('../../../ai/memory/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../ai/memory/db')>();
  return {
    ...real,
    getMemoryClient: async () => db,
    getMemoryDbPath: async () => '/home/user/.config/aperant/memory.db',
  };
});

let serviceFails = false;
vi.mock('../memory-service-factory', () => ({
  getMemoryService: async () => {
    if (serviceFails) throw new Error('no db');
    return {};
  },
  getEmbeddingProvider: () => 'ollama-0.6b',
}));

const ollama = {
  status: vi.fn(async (..._args: unknown[]) => ({ docker: 'ok', container: 'running' })),
  start: vi.fn(async (..._args: unknown[]) => ({ docker: 'ok', container: 'running' })),
};
vi.mock('../../../ollama-container', () => ({
  getOllamaContainerStatus: (...args: unknown[]) => ollama.status(...args),
  startOllamaContainer: (...args: unknown[]) => ollama.start(...args),
}));

import { getInMemoryClient } from '../../../ai/memory/db';
import { buildMemoryStatus, registerMemoryStatusHandlers } from '../memory-status-handlers';
import { IPC_CHANNELS } from '../../../../shared/constants';

async function addMemory(id: string, projectId: string, deprecated = 0): Promise<void> {
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO memories (id, type, content, created_at, last_accessed_at, project_id, deprecated)
          VALUES (?, 'gotcha', 'x', ?, ?, ?, ?)`,
    args: [id, now, now, projectId, deprecated],
  });
}

describe('buildMemoryStatus', () => {
  beforeEach(async () => {
    serviceFails = false;
    db = await getInMemoryClient();
  });

  it('reports the database path and counts only the project\'s live memories', async () => {
    await addMemory('a', 'project-1');
    await addMemory('b', 'project-1');
    await addMemory('c', 'project-1', 1);
    await addMemory('d', 'project-2');

    const status = await buildMemoryStatus('project-1');

    expect(status).toMatchObject({
      available: true,
      embeddingProvider: 'ollama-0.6b',
      dbPath: '/home/user/.config/aperant/memory.db',
      projectMemoryCount: 2,
    });
  });

  it('reports zero for a project with no memories, and no count without a project', async () => {
    expect((await buildMemoryStatus('empty')).projectMemoryCount).toBe(0);
    expect(await buildMemoryStatus()).not.toHaveProperty('projectMemoryCount');
  });

  it('omits the count when it cannot be read, and stays available', async () => {
    db.close();
    const status = await buildMemoryStatus('project-1');
    expect(status.available).toBe(true);
    expect(status).not.toHaveProperty('projectMemoryCount');
  });

  it('is unavailable when the memory service cannot start', async () => {
    serviceFails = true;
    expect(await buildMemoryStatus('project-1')).toEqual({
      enabled: false,
      available: false,
      reason: 'Memory service initialization failed',
    });
  });
});

describe('CONTEXT_MEMORY_STATUS', () => {
  const ask = (projectId: string) => {
    const handler = handlers.get(IPC_CHANNELS.CONTEXT_MEMORY_STATUS);
    if (!handler) throw new Error('handler not registered');
    return handler({}, projectId);
  };

  beforeEach(async () => {
    serviceFails = false;
    db = await getInMemoryClient();
    handlers.clear();
    registerMemoryStatusHandlers(() => null);
  });

  it('counts the asked project\'s memories', async () => {
    await addMemory('a', 'project-1');
    const result = await ask('project-1');
    expect(result).toMatchObject({ success: true, data: { projectMemoryCount: 1 } });
  });

  it('refuses an unknown project', async () => {
    const result = await ask('nope');
    expect(result).toEqual({ success: false, error: 'Project not found' });
  });
});

describe('Ollama container IPC', () => {
  beforeEach(() => {
    handlers.clear();
    registerMemoryStatusHandlers(() => null);
    ollama.status.mockClear();
    ollama.start.mockClear();
  });

  it('passes nothing from the renderer through to Docker', async () => {
    const start = handlers.get(IPC_CHANNELS.OLLAMA_CONTAINER_START);
    const status = handlers.get(IPC_CHANNELS.OLLAMA_CONTAINER_STATUS);
    if (!start || !status) throw new Error('handlers not registered');

    expect(await start({}, 'other-container; rm -rf /')).toEqual({ success: true, data: { docker: 'ok', container: 'running' } });
    expect(ollama.start).toHaveBeenCalledWith();
    await status({}, '--privileged');
    expect(ollama.status).toHaveBeenCalledWith();
  });

  it('turns a failed start into an error result', async () => {
    ollama.start.mockRejectedValueOnce(new Error('Error response from daemon: boom'));
    const start = handlers.get(IPC_CHANNELS.OLLAMA_CONTAINER_START);
    expect(await start?.({})).toEqual({ success: false, error: 'Error response from daemon: boom' });
  });
});
