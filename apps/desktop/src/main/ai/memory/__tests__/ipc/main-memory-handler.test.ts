/**
 * MainMemoryHandler Tests (zeenha fork)
 *
 * Drives the REAL WorkerObserverProxy over a REAL MessageChannel against the
 * handler, so the request/response encoding is checked from both ends.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { MessageChannel } from 'worker_threads';
import type { MessagePort } from 'worker_threads';
import { WorkerObserverProxy } from '../../ipc/worker-observer-proxy';
import {
  MainMemoryHandler,
  MAX_INFERRED_PER_SESSION,
  toProjectRelative,
} from '../../ipc/main-memory-handler';
import type { Memory, MemoryRecordEntry, MemorySearchFilters, MemoryService } from '../../types';

const PROJECT = '/home/u/repo';
const WORKTREE = `${PROJECT}/.auto-claude/worktrees/tasks/007-fix`;

class FakeService {
  stored: Array<MemoryRecordEntry & { id: string }> = [];
  searches: MemorySearchFilters[] = [];
  existing: Memory[] = [];

  async store(entry: MemoryRecordEntry): Promise<string> {
    const id = `mem-${this.stored.length + 1}`;
    this.stored.push({ ...entry, id });
    return id;
  }

  async search(filters: MemorySearchFilters): Promise<Memory[]> {
    this.searches.push(filters);
    const pool = this.existing.filter((m) => !filters.filter || filters.filter(m));
    if (filters.relatedFiles?.length) {
      return pool.filter((m) => m.relatedFiles.some((f) => filters.relatedFiles?.includes(f)));
    }
    return pool;
  }
}

function memory(overrides: Partial<Memory>): Memory {
  return {
    id: 'm-x',
    type: 'gotcha',
    content: 'content',
    confidence: 0.9,
    tags: [],
    relatedFiles: [],
    relatedModules: [],
    createdAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    accessCount: 0,
    scope: 'module',
    source: 'agent_explicit',
    sessionId: 's',
    provenanceSessionIds: [],
    projectId: 'proj-real',
    ...overrides,
  };
}

const opened: MessagePort[] = [];

function setup() {
  const service = new FakeService();
  const { port1, port2 } = new MessageChannel();
  opened.push(port1, port2);
  const handler = new MainMemoryHandler({
    sessionId: 'task-7:1',
    sessionType: 'build',
    projectId: 'proj-real',
    roots: [WORKTREE, PROJECT],
    getService: async () => service as unknown as MemoryService,
  });
  handler.attach(port1);
  const proxy = new WorkerObserverProxy(port2);
  return { service, handler, proxy };
}

/** Let fire-and-forget messages cross the channel. */
const flush = () => new Promise((r) => setTimeout(r, 20));

afterEach(() => {
  for (const p of opened.splice(0)) p.close();
});

describe('toProjectRelative', () => {
  it('strips a task worktree prefix even from another task', () => {
    expect(toProjectRelative(`${PROJECT}/.auto-claude/worktrees/tasks/012-other/app/x.ts`, [WORKTREE])).toBe('app/x.ts');
  });

  it('strips a root and leaves foreign paths alone', () => {
    expect(toProjectRelative(`${PROJECT}/backend/a.php`, [WORKTREE, PROJECT])).toBe('backend/a.php');
    expect(toProjectRelative('/etc/hosts', [PROJECT])).toBe('/etc/hosts');
    expect(toProjectRelative(`${PROJECT}-other/a.ts`, [PROJECT])).toBe(`${PROJECT}-other/a.ts`);
  });
});

describe('record and search through the proxy', () => {
  it('stores with the handler project id, not the worker label, and relative paths', async () => {
    const { service, proxy } = setup();

    const id = await proxy.recordMemory({
      type: 'gotcha',
      content: 'Run migrate --force after pulling a branch with migrations',
      relatedFiles: [`${WORKTREE}/backend/database/migrations/x.php`],
      projectId: 'worker-label-ignored',
      sessionId: 'worker-session-ignored',
      confidence: 7,
    });

    expect(id).toBe('mem-1');
    expect(service.stored).toHaveLength(1);
    expect(service.stored[0]).toMatchObject({
      projectId: 'proj-real',
      sessionId: 'task-7:1',
      source: 'agent_explicit',
      confidence: 1,
      relatedFiles: ['backend/database/migrations/x.php'],
    });
  });

  it('scopes searches to the project and clamps the limit', async () => {
    const { service, proxy } = setup();
    service.existing = [memory({ id: 'm1', relatedFiles: ['app/a.ts'] })];

    const found = await proxy.searchMemory({
      query: 'a',
      projectId: 'other-project',
      relatedFiles: [`${WORKTREE}/app/a.ts`],
      limit: 500,
    });

    expect(found.map((m) => m.id)).toEqual(['m1']);
    expect(service.searches[0]).toMatchObject({ projectId: 'proj-real', limit: 20, relatedFiles: ['app/a.ts'] });
  });
});

describe('step injection encoding', () => {
  it('returns a gotcha for a file the agent just read, and null otherwise', async () => {
    const { service, proxy } = setup();
    service.existing = [memory({ id: 'g1', content: 'Never truncate() in a test', relatedFiles: ['tests/A.php'] })];

    const hit = await proxy.requestStepInjection(5, {
      toolCalls: [{ toolName: 'Read', args: { file_path: `${WORKTREE}/tests/A.php` } }],
      injectedMemoryIds: new Set(),
    });
    expect(hit?.type).toBe('gotcha_injection');
    expect(hit?.memoryIds).toEqual(['g1']);

    const miss = await proxy.requestStepInjection(6, {
      toolCalls: [{ toolName: 'Read', args: { file_path: `${WORKTREE}/tests/A.php` } }],
      injectedMemoryIds: new Set(['g1']),
    });
    expect(miss).toBeNull();
  });
});

describe('finalize', () => {
  it('stores observer-inferred memories for review, once, and closes the port', async () => {
    const { service, handler, proxy } = setup();
    proxy.onReasoning('Wait, the factory needs the tenant first', 3);
    await flush();

    const first = await handler.finalize('success');
    const again = await handler.finalize('success');

    expect(first).toEqual({ recorded: 0, inferred: 1 });
    expect(again).toBe(first);
    expect(service.stored).toHaveLength(1);
    expect(service.stored[0]).toMatchObject({
      type: 'gotcha',
      source: 'observer_inferred',
      needsReview: true,
      projectId: 'proj-real',
    });

    // Port closed: a later request times out to null rather than storing.
    const late = await proxy.recordMemory({ type: 'gotcha', content: 'too late to be kept', projectId: 'x' });
    expect(late).toBeNull();
    expect(service.stored).toHaveLength(1);
  }, 10_000);

  it('stores nothing inferred from a failed session', async () => {
    const { service, handler, proxy } = setup();
    proxy.onReasoning('Wait, that was wrong', 2);
    proxy.onReasoning("This approach won't work, abandoning it", 4);
    await flush();

    const summary = await handler.finalize('failure');

    // Self-corrections are dropped from a failure; a backtrack needs two
    // sessions before it is a dead end, and only one has been seen.
    expect(summary.inferred).toBe(0);
    expect(service.stored).toHaveLength(0);
  });

  it('skips a candidate whose content already exists', async () => {
    const { service, handler, proxy } = setup();
    proxy.onReasoning('Wait, the factory needs the tenant first', 3);
    await flush();
    const content = 'Self-correction detected: Wait, the factory needs the tenant first';
    service.existing = [memory({ content })];

    const summary = await handler.finalize('success');

    expect(summary.inferred).toBe(0);
    expect(service.stored).toHaveLength(0);
  });

  it(`does not store single-session co-access, and at most ${MAX_INFERRED_PER_SESSION} in all`, async () => {
    const { service, handler, proxy } = setup();
    for (let i = 0; i < 6; i++) {
      for (let j = i + 1; j < 6; j++) {
        proxy.onToolCall('Read', { file_path: `${WORKTREE}/f${i}.ts` }, i);
        proxy.onToolCall('Read', { file_path: `${WORKTREE}/f${j}.ts` }, i);
      }
    }
    proxy.onReasoning('Wait, f0 imports f1', 9);
    await flush();

    await handler.finalize('success');

    expect(service.stored.length).toBeLessThanOrEqual(MAX_INFERRED_PER_SESSION);
    expect(service.stored.map((s) => s.tags)).toEqual([['signal:self_correction']]);
  });

  it(`caps a session at ${MAX_INFERRED_PER_SESSION} inferred memories`, async () => {
    const { service, handler, proxy } = setup();
    for (let i = 0; i < MAX_INFERRED_PER_SESSION + 3; i++) {
      proxy.onReasoning(`Correction: helper number ${i} lives elsewhere`, i + 1);
    }
    await flush();

    const summary = await handler.finalize('success');

    expect(summary.inferred).toBe(MAX_INFERRED_PER_SESSION);
    expect(service.stored).toHaveLength(MAX_INFERRED_PER_SESSION);
  });
});
