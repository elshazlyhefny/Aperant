import { describe, it, expect, vi } from 'vitest';
import { createProxyMemorySource } from '../../ipc/proxy-memory-service';
import type { Memory } from '../../types';

function mem(id: string, type: string): Memory {
  return { id, type } as unknown as Memory;
}

describe('createProxyMemorySource', () => {
  it('search forwards filters without the filter callback', async () => {
    const searchMemory = vi.fn().mockResolvedValue([mem('a', 'gotcha')]);
    const src = createProxyMemorySource({ searchMemory });
    const res = await src.search({ query: 'x', limit: 3, filter: () => true } as never);
    expect(res).toHaveLength(1);
    const arg = searchMemory.mock.calls[0][0];
    expect(arg).toEqual({ query: 'x', limit: 3 });
    expect('filter' in arg).toBe(false);
  });

  it('searchWorkflowRecipe queries by description and keeps only recipes within limit', async () => {
    const searchMemory = vi.fn().mockResolvedValue([
      mem('1', 'gotcha'),
      mem('2', 'workflow_recipe'),
      mem('3', 'workflow_recipe'),
      mem('4', 'workflow_recipe'),
    ]);
    const src = createProxyMemorySource({ searchMemory });
    const res = await src.searchWorkflowRecipe('do thing', { limit: 2 });
    expect(searchMemory).toHaveBeenCalledWith({ query: 'do thing', limit: 6 });
    expect(res.map((m) => m.id)).toEqual(['2', '3']);
  });

  it('clamps over-fetch to 20', async () => {
    const searchMemory = vi.fn().mockResolvedValue([]);
    const src = createProxyMemorySource({ searchMemory });
    await src.searchWorkflowRecipe('d', { limit: 15 });
    expect(searchMemory).toHaveBeenCalledWith({ query: 'd', limit: 20 });
  });

  it('returns [] on rejection or empty result', async () => {
    const bad = createProxyMemorySource({ searchMemory: vi.fn().mockRejectedValue(new Error('x')) });
    expect(await bad.search({} as never)).toEqual([]);
    expect(await bad.searchWorkflowRecipe('d')).toEqual([]);
    const empty = createProxyMemorySource({ searchMemory: vi.fn().mockResolvedValue([]) });
    expect(await empty.searchWorkflowRecipe('d')).toEqual([]);
  });
});
