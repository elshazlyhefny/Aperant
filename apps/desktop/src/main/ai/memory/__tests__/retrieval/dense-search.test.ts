/**
 * dense-search.test.ts — searchDense against a real in-memory DB
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Client } from '@libsql/client';
import { getInMemoryClient } from '../../db';
import { searchDense, hasEmbeddingsForDims } from '../../retrieval/dense-search';
import type { EmbeddingService } from '../../embedding-service';

const PROJECT = 'proj-a';

async function seed(
  client: Client,
  id: string,
  opts: { projectId?: string; dims?: number; deprecated?: number } = {},
): Promise<void> {
  const { projectId = PROJECT, dims = 1024, deprecated = 0 } = opts;
  const now = new Date().toISOString();
  await client.execute({
    sql: `INSERT INTO memories (
      id, type, content, confidence, tags, related_files, related_modules,
      created_at, last_accessed_at, access_count, scope, source, project_id, deprecated
    ) VALUES (?, 'gotcha', 'content', 0.9, '[]', '[]', '[]', ?, ?, 0, 'global', 'agent_explicit', ?, ?)`,
    args: [id, now, now, projectId, deprecated],
  });
  const vec = new Array(dims).fill(0.1);
  await client.execute({
    sql: `INSERT INTO memory_embeddings (memory_id, embedding, model_id, dims, created_at)
      VALUES (?, ?, 'test', ?, ?)`,
    args: [id, Buffer.from(new Float32Array(vec).buffer), dims, now],
  });
}

function makeService(): EmbeddingService {
  return {
    embed: vi.fn(async (_q: string, dims: number = 1024) => new Array(dims).fill(0.1)),
  } as unknown as EmbeddingService;
}

let client: Client;

beforeEach(async () => {
  client = await getInMemoryClient();
});

afterEach(() => {
  client.close();
  vi.restoreAllMocks();
});

describe('searchDense', () => {
  it('returns a stored 1024-dim memory for a 1024-dim query', async () => {
    await seed(client, 'mem-1');
    const svc = makeService();

    const results = await searchDense(client, 'q', svc, PROJECT, 1024, 30);

    expect(results.map((r) => r.memoryId)).toEqual(['mem-1']);
    expect(svc.embed).toHaveBeenCalledWith('q', 1024);
  });

  it('returns [] for a 256-dim query against 1024-dim rows', async () => {
    await seed(client, 'mem-1');
    const svc = makeService();

    const results = await searchDense(client, 'q', svc, PROJECT, 256, 30);

    expect(results).toEqual([]);
    expect(svc.embed).not.toHaveBeenCalled();
  });

  it('does not embed when the DB is empty', async () => {
    const svc = makeService();
    expect(await searchDense(client, 'q', svc, PROJECT, 1024, 30)).toEqual([]);
    expect(svc.embed).not.toHaveBeenCalled();
  });

  it('does not embed when rows belong to another project or are deprecated', async () => {
    await seed(client, 'other', { projectId: 'proj-b' });
    await seed(client, 'dep', { deprecated: 1 });
    const svc = makeService();

    expect(await searchDense(client, 'q', svc, PROJECT, 1024, 30)).toEqual([]);
    expect(svc.embed).not.toHaveBeenCalled();
  });

  it('caches positive results and skips the existence query on later calls', async () => {
    await seed(client, 'mem-1');
    const svc = makeService();
    const cache = new Map<string, boolean>();

    await searchDense(client, 'q', svc, PROJECT, 1024, 30, cache);
    expect(cache.get(`${PROJECT}:1024`)).toBe(true);

    const spy = vi.spyOn(client, 'execute');
    await searchDense(client, 'q', svc, PROJECT, 1024, 30, cache);
    const existenceCalls = spy.mock.calls.filter((c) => {
      const stmt: unknown = c[0];
      const sql = typeof stmt === 'string' ? stmt : String((stmt as { sql?: string }).sql);
      return sql.includes('SELECT 1 FROM memory_embeddings');
    });
    expect(existenceCalls).toHaveLength(0);
  });

  it('does not cache negative results', async () => {
    const svc = makeService();
    const cache = new Map<string, boolean>();

    expect(await searchDense(client, 'q', svc, PROJECT, 1024, 30, cache)).toEqual([]);
    expect(cache.size).toBe(0);

    await seed(client, 'mem-late');
    const results = await searchDense(client, 'q', svc, PROJECT, 1024, 30, cache);
    expect(results.map((r) => r.memoryId)).toEqual(['mem-late']);
  });
});

describe('hasEmbeddingsForDims', () => {
  it('reflects project, dims and deprecated state', async () => {
    expect(await hasEmbeddingsForDims(client, PROJECT, 1024)).toBe(false);
    await seed(client, 'mem-1');
    expect(await hasEmbeddingsForDims(client, PROJECT, 1024)).toBe(true);
    expect(await hasEmbeddingsForDims(client, PROJECT, 256)).toBe(false);
    expect(await hasEmbeddingsForDims(client, 'proj-b', 1024)).toBe(false);
  });
});
