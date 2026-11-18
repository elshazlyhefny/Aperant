/**
 * Reranker
 *
 * Provider auto-detection priority:
 *   1. Ollama — cosine similarity between the query embedding and the stored
 *      memory embeddings (local, zero cost, no HTTP). The Qwen3 reranker model
 *      (qwen3-reranker:0.6b) is only the opt-in signal that selects this
 *      provider; it is not called.
 *   2. Cohere — rerank-v3.5 (~$1/1K queries)
 *   3. None — passthrough (position-based scoring)
 *
 * Gracefully degrades to passthrough if no provider is available or the
 * embeddings needed for cosine scoring are missing or not comparable.
 */

const OLLAMA_BASE_URL = 'http://localhost:11434';
const COHERE_RERANK_URL = 'https://api.cohere.com/v2/rerank';
const QWEN3_RERANKER_MODEL = 'qwen3-reranker:0.6b';

export type RerankerProvider = 'ollama' | 'cohere' | 'none';

export interface RerankerCandidate {
  memoryId: string;
  content: string;
  /** Stored memory embedding, used by the 'ollama' provider for cosine scoring. */
  embedding?: number[];
}

export interface RerankOptions {
  /** Embedding of the query (may be shorter than stored vectors, e.g. 256 vs 1024). */
  queryEmbedding?: number[];
}

export interface RerankerResult {
  memoryId: string;
  score: number;
}

export class Reranker {
  private provider: RerankerProvider;

  constructor(provider?: RerankerProvider) {
    this.provider = provider ?? 'none';
  }

  /**
   * Auto-detect and initialize the best available reranker provider.
   * Call once before using rerank().
   */
  async initialize(): Promise<void> {
    // Check Ollama for Qwen3-Reranker-0.6B
    try {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        const data = (await response.json()) as { models: Array<{ name: string }> };
        const hasReranker = data.models.some((m) =>
          m.name.startsWith(QWEN3_RERANKER_MODEL),
        );
        if (hasReranker) {
          this.provider = 'ollama';
          return;
        }
      }
    } catch {
      // Ollama not available
    }

    // Check for Cohere API key
    if (process.env.COHERE_API_KEY) {
      this.provider = 'cohere';
      return;
    }

    this.provider = 'none';
  }

  getProvider(): RerankerProvider {
    return this.provider;
  }

  /**
   * Rerank candidates.
   * - 'ollama': cosine similarity between options.queryEmbedding and each
   *   candidate's stored embedding. No network calls. Falls back to
   *   passthrough if the query embedding is missing or fewer than 2
   *   candidates have a comparable embedding.
   * - 'cohere': Cohere rerank API.
   * - 'none': passthrough (positional scoring).
   *
   * @param query - The original search query
   * @param candidates - Candidates to rerank with their content
   * @param topK - Number of top results to return
   * @param options - Optional query embedding for cosine scoring
   */
  async rerank(
    query: string,
    candidates: RerankerCandidate[],
    topK: number = 8,
    options?: RerankOptions,
  ): Promise<RerankerResult[]> {
    if (this.provider === 'none' || candidates.length <= topK) {
      return this.passthroughRerank(candidates, topK);
    }

    if (this.provider === 'ollama') {
      return this.rerankOllama(candidates, topK, options?.queryEmbedding);
    }

    return this.rerankCohere(query, candidates, topK);
  }

  // ============================================================
  // PRIVATE: OLLAMA (COSINE SIMILARITY)
  // ============================================================

  /**
   * zeenha fork: the previous implementation sent one uncached
   * /api/embeddings request per candidate (up to 20 per search) and ranked
   * by the L2 norm of the returned vector, which is not a relevance score.
   * This ranks by cosine similarity against embeddings already stored in
   * memory_embeddings, with no HTTP requests.
   */
  private rerankOllama(
    candidates: RerankerCandidate[],
    topK: number,
    queryEmbedding?: number[],
  ): RerankerResult[] {
    if (!queryEmbedding || queryEmbedding.length === 0) {
      return this.passthroughRerank(candidates, topK);
    }

    const dim = queryEmbedding.length;
    const query = l2Normalize(queryEmbedding);
    const scores: Array<number | null> = candidates.map((c) => {
      const e = c.embedding;
      if (!e || e.length < dim) return null;
      return cosineSimilarity(query, l2Normalize(e.length > dim ? e.slice(0, dim) : e));
    });

    const comparable = scores.filter((s): s is number => s !== null);
    if (comparable.length < 2) {
      return this.passthroughRerank(candidates, topK);
    }

    const minScore = Math.min(...comparable);
    return candidates
      .map((c, i) => ({
        memoryId: c.memoryId,
        score: scores[i] ?? minScore,
        index: i,
      }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          Number(scores[a.index] === null) - Number(scores[b.index] === null) ||
          a.index - b.index,
      )
      .slice(0, topK)
      .map(({ memoryId, score }) => ({ memoryId, score }));
  }

  // ============================================================
  // PRIVATE: COHERE RERANKER
  // ============================================================

  /**
   * Rerank using Cohere rerank-v3.5.
   * Cost: ~$1 per 1000 search queries.
   */
  private async rerankCohere(
    query: string,
    candidates: RerankerCandidate[],
    topK: number,
  ): Promise<RerankerResult[]> {
    const cohereKey = process.env.COHERE_API_KEY;
    if (!cohereKey) {
      return this.passthroughRerank(candidates, topK);
    }

    try {
      const response = await fetch(COHERE_RERANK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cohereKey}`,
        },
        body: JSON.stringify({
          model: 'rerank-v3.5',
          query,
          documents: candidates.map((c) => c.content),
          top_n: topK,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        return this.passthroughRerank(candidates, topK);
      }

      const data = (await response.json()) as {
        results: Array<{ index: number; relevance_score: number }>;
      };

      return data.results.map((r) => ({
        memoryId: candidates[r.index].memoryId,
        score: r.relevance_score,
      }));
    } catch {
      return this.passthroughRerank(candidates, topK);
    }
  }

  private passthroughRerank(
    candidates: RerankerCandidate[],
    topK: number,
  ): RerankerResult[] {
    return candidates
      .slice(0, topK)
      .map((c, i) => ({
        memoryId: c.memoryId,
        score: 1 - i / Math.max(candidates.length, 1),
      }));
  }
}

// ============================================================
// VECTOR HELPERS
// ============================================================

function l2Normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  return norm === 0 ? v : v.map((x) => x / norm);
}

/**
 * Cosine similarity of two equal-length vectors. Returns 0 if lengths differ
 * or either vector has zero magnitude.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
