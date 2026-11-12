/**
 * Memory Service Factory
 *
 * Singleton factory for MemoryServiceImpl backed by libSQL.
 * Lazily initialized on first call; subsequent calls return the same instance.
 */

import { getMemoryClient } from '../../ai/memory/db';
import { EmbeddingService } from '../../ai/memory/embedding-service';
import type { EmbeddingConfig } from '../../ai/memory/embedding-service';
import { RetrievalPipeline } from '../../ai/memory/retrieval/pipeline';
import { Reranker } from '../../ai/memory/retrieval/reranker';
import { MemoryServiceImpl } from '../../ai/memory/memory-service';
import { readSettingsFile } from '../../settings-utils';

let _instance: MemoryServiceImpl | null = null;
let _initPromise: Promise<MemoryServiceImpl> | null = null;
let _embeddingProvider: string | null = null;

function buildEmbeddingConfig(): EmbeddingConfig | undefined {
  const settings = readSettingsFile();
  if (!settings?.memoryEmbeddingProvider) return undefined;
  return {
    provider: settings.memoryEmbeddingProvider,
    openaiApiKey: settings.globalOpenAIApiKey,
    openaiEmbeddingModel: settings.memoryOpenaiEmbeddingModel,
    googleApiKey: settings.globalGoogleApiKey,
    googleEmbeddingModel: settings.memoryGoogleEmbeddingModel,
    azureApiKey: settings.memoryAzureApiKey,
    azureBaseUrl: settings.memoryAzureBaseUrl,
    azureDeployment: settings.memoryAzureEmbeddingDeployment,
    voyageApiKey: settings.memoryVoyageApiKey,
    voyageModel: settings.memoryVoyageEmbeddingModel,
    ollamaBaseUrl: settings.ollamaBaseUrl,
    ollamaModel: settings.memoryOllamaEmbeddingModel,
  };
}

/**
 * Get or create the singleton MemoryServiceImpl.
 * Initialization is lazy and idempotent — safe to call from multiple places.
 */
export async function getMemoryService(): Promise<MemoryServiceImpl> {
  if (_instance) return _instance;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const db = await getMemoryClient();
    const embeddingService = new EmbeddingService(db, buildEmbeddingConfig());
    await embeddingService.initialize();
    _embeddingProvider = embeddingService.getProvider();
    const reranker = new Reranker();
    await reranker.initialize();
    const pipeline = new RetrievalPipeline(db, embeddingService, reranker);
    _instance = new MemoryServiceImpl(db, embeddingService, pipeline);
    return _instance;
  })();

  return _initPromise;
}

/**
 * Get the detected embedding provider string (e.g. 'ollama-4b', 'openai', 'onnx').
 * Returns null if the service has not been initialized yet.
 */
export function getEmbeddingProvider(): string | null {
  return _embeddingProvider;
}

/**
 * zeenha fork: whether agents (task workers, PR review) read and write memory.
 * On unless the user switched it off in the memory settings: the store is a
 * local libSQL file, and embeddings only leave the machine when the user
 * configured a hosted embedding provider themselves.
 */
export function isAgentMemoryEnabled(): boolean {
  return readSettingsFile()?.memoryEnabled !== false;
}

/**
 * Reset the singleton (e.g. for tests or after closing the DB).
 */
export function resetMemoryService(): void {
  _instance = null;
  _initPromise = null;
  _embeddingProvider = null;
}
