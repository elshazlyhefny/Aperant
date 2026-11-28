/**
 * zeenha fork: build a MemoryServiceImpl on an open database client. Shared by
 * the desktop factory (ipc-handlers/context/memory-service-factory.ts) and the
 * headless CLI, so this file must stay free of Electron and settings imports.
 */

import type { Client } from '@libsql/client';
import { EmbeddingService } from './embedding-service';
import type { EmbeddingConfig } from './embedding-service';
import { RetrievalPipeline } from './retrieval/pipeline';
import { Reranker } from './retrieval/reranker';
import { MemoryServiceImpl } from './memory-service';

export interface CreatedMemoryService {
  service: MemoryServiceImpl;
  /** The detected embedding provider (e.g. 'ollama-4b', 'openai'). */
  embeddingProvider: string;
}

export async function createMemoryService(
  db: Client,
  embeddingConfig: EmbeddingConfig | undefined,
): Promise<CreatedMemoryService> {
  const embeddingService = new EmbeddingService(db, embeddingConfig);
  await embeddingService.initialize();
  const embeddingProvider = embeddingService.getProvider();
  const reranker = new Reranker();
  await reranker.initialize();
  const pipeline = new RetrievalPipeline(db, embeddingService, reranker);
  return { service: new MemoryServiceImpl(db, embeddingService, pipeline), embeddingProvider };
}
