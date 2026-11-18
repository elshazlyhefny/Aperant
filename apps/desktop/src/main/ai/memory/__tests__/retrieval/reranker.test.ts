/**
 * reranker.test.ts — Ollama provider ranks by cosine similarity of stored embeddings
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Reranker, cosineSimilarity } from '../../retrieval/reranker';
import type { RerankerCandidate } from '../../retrieval/reranker';

function cand(id: string, embedding?: number[]): RerankerCandidate {
  return { memoryId: id, content: id, embedding };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical and 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 2], [1, 2])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('returns 0 for mismatched lengths or zero vectors', () => {
    expect(cosineSimilarity([1], [1, 2])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });
});

describe('Reranker (ollama cosine)', () => {
  const query = [1, 0, 0];

  it('puts the nearest candidate first without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = new Reranker('ollama');
    const result = await r.rerank(
      'q',
      [cand('far', [0, 1, 0]), cand('mid', [1, 1, 0]), cand('near', [1, 0.01, 0])],
      2,
      { queryEmbedding: query },
    );
    expect(result.map((x) => x.memoryId)).toEqual(['near', 'mid']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('truncates 1024-dim stored vectors to a 256-dim query', async () => {
    const q = new Array(256).fill(0);
    q[0] = 1;
    const make = (first: number, tailOnly = false) => {
      const v = new Array(1024).fill(0);
      v[0] = tailOnly ? 0 : first;
      v[1] = tailOnly ? 0 : 1 - first;
      v[900] = 100; // must be ignored by truncation
      return v;
    };
    const r = new Reranker('ollama');
    const result = await r.rerank(
      'q',
      [cand('b', make(0.1)), cand('a', make(1)), cand('c', make(0.5))],
      2,
      { queryEmbedding: q },
    );
    expect(result.map((x) => x.memoryId)).toEqual(['a', 'c']);
  });

  it('passes through when the query embedding is missing', async () => {
    const r = new Reranker('ollama');
    const result = await r.rerank(
      'q',
      [cand('a', [0, 1, 0]), cand('b', [1, 0, 0]), cand('c', [1, 0, 0])],
      2,
    );
    expect(result.map((x) => x.memoryId)).toEqual(['a', 'b']);
  });

  it('passes through when stored vectors are shorter than the query', async () => {
    const r = new Reranker('ollama');
    const result = await r.rerank(
      'q',
      [cand('a', [0, 1]), cand('b', [1, 0]), cand('c', [1, 0])],
      2,
      { queryEmbedding: query },
    );
    expect(result.map((x) => x.memoryId)).toEqual(['a', 'b']);
  });

  it('passes through when fewer than 2 candidates are comparable', async () => {
    const r = new Reranker('ollama');
    const result = await r.rerank(
      'q',
      [cand('a'), cand('b', [1, 0, 0]), cand('c')],
      2,
      { queryEmbedding: query },
    );
    expect(result.map((x) => x.memoryId)).toEqual(['a', 'b']);
  });

  it('sorts candidates without embeddings last', async () => {
    const r = new Reranker('ollama');
    const result = await r.rerank(
      'q',
      [cand('none'), cand('far', [0, 1, 0]), cand('near', [1, 0, 0])],
      2,
      { queryEmbedding: query },
    );
    expect(result.map((x) => x.memoryId)).toEqual(['near', 'far']);
  });

  it('keeps original order for ties', async () => {
    const r = new Reranker('ollama');
    const result = await r.rerank(
      'q',
      [cand('a', [1, 0, 0]), cand('b', [2, 0, 0]), cand('c', [0, 1, 0])],
      2,
      { queryEmbedding: query },
    );
    expect(result.map((x) => x.memoryId)).toEqual(['a', 'b']);
  });
});

describe('Reranker passthrough', () => {
  it("provider 'none' returns positional order", async () => {
    const r = new Reranker('none');
    const result = await r.rerank(
      'q',
      [cand('a', [0, 1, 0]), cand('b', [1, 0, 0]), cand('c', [1, 0, 0])],
      2,
      { queryEmbedding: [1, 0, 0] },
    );
    expect(result.map((x) => x.memoryId)).toEqual(['a', 'b']);
    expect(result[0].score).toBeGreaterThan(result[1].score);
  });

  it('returns all candidates in order when length <= topK', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = new Reranker('ollama');
    const result = await r.rerank('q', [cand('a', [0, 1, 0]), cand('b', [1, 0, 0])], 5, {
      queryEmbedding: [1, 0, 0],
    });
    expect(result.map((x) => x.memoryId)).toEqual(['a', 'b']);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
