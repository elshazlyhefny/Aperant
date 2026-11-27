/**
 * Tests for buildEmbeddingConfig in memory-service-factory.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReadSettingsFile = vi.fn();
vi.mock('../../../settings-utils', () => ({
  readSettingsFile: () => mockReadSettingsFile()
}));
vi.mock('../../../ai/memory/db', () => ({ getMemoryClient: vi.fn() }));
vi.mock('../../../ai/memory/embedding-service', () => ({ EmbeddingService: vi.fn() }));
vi.mock('../../../ai/memory/retrieval/pipeline', () => ({ RetrievalPipeline: vi.fn() }));
vi.mock('../../../ai/memory/retrieval/reranker', () => ({ Reranker: vi.fn() }));
vi.mock('../../../ai/memory/memory-service', () => ({ MemoryServiceImpl: vi.fn() }));

import { buildEmbeddingConfig } from '../memory-service-factory';

const ENVELOPE = 'aperant-secret:v1:Y2lwaGVydGV4dA==';

describe('buildEmbeddingConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes decrypted embedding keys through', () => {
    mockReadSettingsFile.mockReturnValue({
      memoryEmbeddingProvider: 'openai',
      globalOpenAIApiKey: 'sk-openai',
      globalGoogleApiKey: 'g-key',
      memoryAzureApiKey: 'az-key',
      memoryVoyageApiKey: 'voy-key'
    });

    expect(buildEmbeddingConfig()).toMatchObject({
      provider: 'openai',
      openaiApiKey: 'sk-openai',
      googleApiKey: 'g-key',
      azureApiKey: 'az-key',
      voyageApiKey: 'voy-key'
    });
  });

  it('never passes an undecryptable key envelope to an embedding provider', () => {
    mockReadSettingsFile.mockReturnValue({
      memoryEmbeddingProvider: 'openai',
      globalOpenAIApiKey: ENVELOPE,
      globalGoogleApiKey: ENVELOPE,
      memoryAzureApiKey: ENVELOPE,
      memoryVoyageApiKey: ENVELOPE
    });

    const config = buildEmbeddingConfig();

    expect(config?.provider).toBe('openai');
    expect(config?.openaiApiKey).toBeUndefined();
    expect(config?.googleApiKey).toBeUndefined();
    expect(config?.azureApiKey).toBeUndefined();
    expect(config?.voyageApiKey).toBeUndefined();
  });
});
