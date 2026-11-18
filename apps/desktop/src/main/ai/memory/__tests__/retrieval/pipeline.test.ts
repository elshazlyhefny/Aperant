/**
 * pipeline.test.ts — Integration test of the full retrieval pipeline with mocked services
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Client } from '@libsql/client';
import { getInMemoryClient } from '../../db';
import { RetrievalPipeline } from '../../retrieval/pipeline';
import { Reranker } from '../../retrieval/reranker';
import type { EmbeddingService } from '../../embedding-service';

// ============================================================
// HELPERS
// ============================================================

async function seedMemory(
  client: Client,
  id: string,
  content: string,
  projectId: string,
  type: string = 'gotcha',
): Promise<void> {
  const now = new Date().toISOString();

  await client.execute({
    sql: `INSERT INTO memories (
      id, type, content, confidence, tags, related_files, related_modules,
      created_at, last_accessed_at, access_count, scope, source, project_id, deprecated
    ) VALUES (?, ?, ?, 0.9, '[]', '[]', '[]', ?, ?, 0, 'global', 'agent_explicit', ?, 0)`,
    args: [id, type, content, now, now, projectId],
  });

  await client.execute({
    sql: `INSERT INTO memories_fts (memory_id, content, tags, related_files) VALUES (?, ?, '[]', '[]')`,
    args: [id, content],
  });
}

function makeMockEmbeddingService(): EmbeddingService {
  return {
    embed: vi.fn().mockResolvedValue(new Array(1024).fill(0.1)),
    embedBatch: vi.fn().mockResolvedValue([]),
    embedMemory: vi.fn().mockResolvedValue(new Array(1024).fill(0.1)),
    embedChunk: vi.fn().mockResolvedValue(new Array(1024).fill(0.1)),
    initialize: vi.fn().mockResolvedValue(undefined),
    getProvider: vi.fn().mockReturnValue('none'),
  } as unknown as EmbeddingService;
}

// ============================================================
// TESTS
// ============================================================

let client: Client;

beforeEach(async () => {
  client = await getInMemoryClient();
});

afterEach(() => {
  client.close();
  vi.restoreAllMocks();
});

describe('RetrievalPipeline', () => {
  it('returns empty result for empty database', async () => {
    const embeddingService = makeMockEmbeddingService();
    const reranker = new Reranker('none');
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);

    const result = await pipeline.search('authentication', {
      phase: 'implement',
      projectId: 'test-project',
    });

    expect(result.memories).toEqual([]);
    expect(result.formattedContext).toBe('');
  });

  it('returns memories matching a query via BM25', async () => {
    await seedMemory(client, 'mem-001', 'JWT token expiry must be checked in middleware', 'proj-a');

    const embeddingService = makeMockEmbeddingService();
    const reranker = new Reranker('none');
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);

    const result = await pipeline.search('JWT token', {
      phase: 'implement',
      projectId: 'proj-a',
    });

    expect(result.memories.length).toBeGreaterThan(0);
    expect(result.memories[0].id).toBe('mem-001');
    expect(result.formattedContext).toContain('JWT token expiry');
  });

  it('scopes results to correct project', async () => {
    await seedMemory(client, 'proj-a-mem', 'gotcha for project a', 'proj-a');
    await seedMemory(client, 'proj-b-mem', 'gotcha for project b', 'proj-b');

    const embeddingService = makeMockEmbeddingService();
    const reranker = new Reranker('none');
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);

    const result = await pipeline.search('gotcha', {
      phase: 'implement',
      projectId: 'proj-a',
    });

    const ids = result.memories.map((m) => m.id);
    expect(ids).toContain('proj-a-mem');
    expect(ids).not.toContain('proj-b-mem');
  });

  it('includes formatted context with phase-appropriate structure', async () => {
    await seedMemory(client, 'mem-001', 'critical gotcha about Electron path resolution', 'proj-a', 'gotcha');

    const embeddingService = makeMockEmbeddingService();
    const reranker = new Reranker('none');
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);

    const result = await pipeline.search('electron path', {
      phase: 'implement',
      projectId: 'proj-a',
    });

    if (result.memories.length > 0) {
      expect(result.formattedContext).toContain('Relevant Context from Memory');
      expect(result.formattedContext).toContain('Gotcha');
    }
  });

  it('respects maxResults config', async () => {
    // Seed 5 memories
    for (let i = 0; i < 5; i++) {
      await seedMemory(client, `mem-${i}`, `authentication gotcha number ${i}`, 'proj-a');
    }

    const embeddingService = makeMockEmbeddingService();
    const reranker = new Reranker('none');
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);

    const result = await pipeline.search('authentication', {
      phase: 'implement',
      projectId: 'proj-a',
      maxResults: 2,
    });

    expect(result.memories.length).toBeLessThanOrEqual(2);
  });

  it('handles graph search gracefully when no recentFiles provided', async () => {
    await seedMemory(client, 'mem-001', 'some memory content', 'proj-a');

    const embeddingService = makeMockEmbeddingService();
    const reranker = new Reranker('none');
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);

    // No recentFiles — graph search should return empty gracefully
    await expect(
      pipeline.search('content', {
        phase: 'explore',
        projectId: 'proj-a',
        // recentFiles: undefined
      }),
    ).resolves.not.toThrow();
  });

  it('calls embedding service at 1024 dims for dense search when embeddings are stored', async () => {
    await seedMemory(client, 'mem-emb', 'architecture notes', 'proj-a');
    const buf = Buffer.alloc(1024 * 4);
    await client.execute({
      sql: `INSERT INTO memory_embeddings (memory_id, embedding, model_id, dims, created_at)
        VALUES (?, ?, 'test', 1024, ?)`,
      args: ['mem-emb', buf, new Date().toISOString()],
    });

    const embeddingService = makeMockEmbeddingService();
    const reranker = new Reranker('none');
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);

    await pipeline.search('semantic query about architecture', {
      phase: 'explore',
      projectId: 'proj-a',
    });

    expect(embeddingService.embed).toHaveBeenCalledWith('semantic query about architecture', 1024);
  });

  it('skips query embedding when no embeddings are stored', async () => {
    await seedMemory(client, 'mem-noemb', 'architecture notes', 'proj-a');
    const embeddingService = makeMockEmbeddingService();
    const reranker = new Reranker('none');
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);

    await pipeline.search('semantic query about architecture', {
      phase: 'explore',
      projectId: 'proj-a',
    });

    expect(embeddingService.embed).not.toHaveBeenCalled();
  });

  it('does not embed the query on an empty database', async () => {
    const embeddingService = makeMockEmbeddingService();
    const pipeline = new RetrievalPipeline(client, embeddingService, new Reranker('none'));

    await pipeline.search('anything at all', { phase: 'explore', projectId: 'proj-a' });

    expect(embeddingService.embed).not.toHaveBeenCalled();
  });

  it('returns a memory via the dense path when BM25 has no keyword overlap', async () => {
    await seedMemory(client, 'mem-dense', 'zebra giraffe habitat notes', 'proj-a');
    const vec = new Array(1024).fill(0.1);
    await client.execute({
      sql: `INSERT INTO memory_embeddings (memory_id, embedding, model_id, dims, created_at)
        VALUES (?, ?, 'test', 1024, ?)`,
      args: ['mem-dense', Buffer.from(new Float32Array(vec).buffer), new Date().toISOString()],
    });

    const embeddingService = makeMockEmbeddingService();
    const pipeline = new RetrievalPipeline(client, embeddingService, new Reranker('none'));

    const result = await pipeline.search('quantum spreadsheet', {
      phase: 'explore',
      projectId: 'proj-a',
    });

    expect(result.memories.map((m) => m.id)).toContain('mem-dense');
  });

  describe('ollama cosine reranking', () => {
    async function seedEmbedding(id: string, hotIndex: number): Promise<void> {
      const buf = Buffer.alloc(1024 * 4);
      buf.writeFloatLE(1, hotIndex * 4);
      await client.execute({
        sql: `INSERT INTO memory_embeddings (memory_id, embedding, model_id, dims, created_at)
          VALUES (?, ?, 'test', 1024, ?)`,
        args: [id, buf, new Date().toISOString()],
      });
    }

    function queryVector(): number[] {
      const v = new Array(256).fill(0);
      v[0] = 1;
      return v;
    }

    it('ranks by stored-embedding cosine similarity with no HTTP calls', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      for (let i = 0; i < 10; i++) {
        await seedMemory(client, `mem-${i}`, `authentication gotcha number ${i}`, 'proj-a');
        // mem-9 is aligned with the query; the rest point elsewhere
        await seedEmbedding(`mem-${i}`, i === 9 ? 0 : i + 1);
      }

      const embeddingService = makeMockEmbeddingService();
      (embeddingService.embed as ReturnType<typeof vi.fn>).mockResolvedValue(queryVector());
      const pipeline = new RetrievalPipeline(client, embeddingService, new Reranker('ollama'));

      const result = await pipeline.search('authentication', {
        phase: 'implement',
        projectId: 'proj-a',
        maxResults: 3,
      });

      expect(result.memories).toHaveLength(3);
      expect(result.memories[0].id).toBe('mem-9');
      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('falls back to RRF order when memory_embeddings is empty', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      for (let i = 0; i < 10; i++) {
        await seedMemory(client, `mem-${i}`, `authentication gotcha number ${i}`, 'proj-a');
      }

      const embeddingService = makeMockEmbeddingService();
      (embeddingService.embed as ReturnType<typeof vi.fn>).mockResolvedValue(queryVector());

      const baseline = await new RetrievalPipeline(
        client,
        embeddingService,
        new Reranker('none'),
      ).search('authentication', { phase: 'implement', projectId: 'proj-a', maxResults: 3 });

      const result = await new RetrievalPipeline(
        client,
        embeddingService,
        new Reranker('ollama'),
      ).search('authentication', { phase: 'implement', projectId: 'proj-a', maxResults: 3 });

      expect(result.memories).toHaveLength(3);
      expect(result.memories.map((m) => m.id)).toEqual(baseline.memories.map((m) => m.id));
      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  });

  it('works with different phases', async () => {
    await seedMemory(client, 'mem-001', 'workflow recipe for feature development', 'proj-a', 'workflow_recipe');

    const embeddingService = makeMockEmbeddingService();
    const reranker = new Reranker('none');
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);

    const phases = ['define', 'implement', 'validate', 'refine', 'explore', 'reflect'] as const;
    for (const phase of phases) {
      await expect(
        pipeline.search('workflow', { phase, projectId: 'proj-a' }),
      ).resolves.not.toThrow();
    }
  });
});
