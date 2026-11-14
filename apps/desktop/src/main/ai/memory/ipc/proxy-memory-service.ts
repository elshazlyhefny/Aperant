/**
 * Proxy-backed memory source for worker threads.
 *
 * Workers have no direct DB access; reads go through WorkerObserverProxy to the
 * main thread's MemoryService. Only types are imported here so this module stays
 * free of Electron dependencies.
 */

import type { InjectionMemorySource, Memory } from '../types';
import type { WorkerObserverProxy } from './worker-observer-proxy';

/** Main-thread handler clamps limit to this value. */
const MAX_PROXY_LIMIT = 20;

export function createProxyMemorySource(
  proxy: Pick<WorkerObserverProxy, 'searchMemory'>,
): InjectionMemorySource {
  return {
    async search(filters) {
      try {
        // Functions are not structured-cloneable and would throw DataCloneError.
        const { filter: _filter, ...cloneable } = filters as typeof filters & { filter?: unknown };
        const result = await proxy.searchMemory(cloneable);
        return Array.isArray(result) ? result : [];
      } catch {
        return [];
      }
    },

    async searchWorkflowRecipe(taskDescription, opts) {
      try {
        const limit = opts?.limit ?? 5;
        const result: Memory[] = await proxy.searchMemory({
          query: taskDescription,
          limit: Math.min(limit * 3, MAX_PROXY_LIMIT),
        });
        if (!Array.isArray(result)) return [];
        return result.filter((m) => m.type === 'workflow_recipe').slice(0, limit);
      } catch {
        return [];
      }
    },
  };
}
