/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/app',
    getPath: () => '/tmp',
    isPackaged: false
  }
}));

const mockRunInsightsQuery = vi.fn();
vi.mock('../ai/runners/insights', () => ({
  runInsightsQuery: (...args: unknown[]) => mockRunInsightsQuery(...args)
}));

vi.mock('../rate-limit-detector', () => ({
  detectRateLimit: () => ({ isRateLimited: false }),
  createSDKRateLimitInfo: vi.fn()
}));

import { InsightsExecutor } from '../insights/insights-executor';
import type { InsightsConfig } from '../insights/config';

const image = (id: string, data?: string) => ({
  id,
  filename: `${id}.png`,
  mimeType: 'image/png',
  size: 3,
  data
});

describe('InsightsExecutor image delivery', () => {
  let executor: InsightsExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRunInsightsQuery.mockResolvedValue({ text: 'ok', taskSuggestion: null, toolCalls: [] });
    executor = new InsightsExecutor({} as InsightsConfig);
  });

  it('forwards only images that carry data to a vision model', async () => {
    await executor.execute(
      'p1',
      '/project',
      'look',
      [],
      { profileId: 'x', model: 'sonnet', thinkingLevel: 'medium' } as never,
      [image('a', 'QUJD'), image('b')]
    );

    const config = mockRunInsightsQuery.mock.calls[0][0];
    expect(config.images).toEqual([{ data: 'QUJD', mimeType: 'image/png' }]);
    expect(config.message).toBe('look');
  });

  it('drops images and notes it for a text-only model without throwing', async () => {
    await expect(
      executor.execute(
        'p1',
        '/project',
        'look',
        [],
        { profileId: 'x', model: 'glm-5', thinkingLevel: 'medium' } as never,
        [image('a', 'QUJD')]
      )
    ).resolves.toBeDefined();

    const config = mockRunInsightsQuery.mock.calls[0][0];
    expect(config.images).toBeUndefined();
    expect(config.message).toContain('[User attached 1 image(s); this model cannot view images]');
  });
});
