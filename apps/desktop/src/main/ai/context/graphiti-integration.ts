/**
 * Memory Knowledge Graph Integration (stub)
 *
 * Intentional stub kept for the graph-hints call sites in context/builder.ts.
 * The real memory system lives in apps/desktop/src/main/ai/memory/.
 *
 * isMemoryEnabled() here always returns false and is NOT the switch for agent
 * memory; that is isAgentMemoryEnabled() in
 * ipc-handlers/context/memory-service-factory.ts. It is also a different
 * function from isMemoryEnabled() in ipc-handlers/context/utils.ts, which
 * reads GRAPHITI_ENABLED.
 */

/**
 * Returns whether the memory system is currently enabled.
 * For now this always returns false; can be wired to an env/setting later.
 */
export function isMemoryEnabled(): boolean {
  return false;
}

/** @deprecated Use isMemoryEnabled instead */
export const isGraphitiEnabled = isMemoryEnabled;

/**
 * Fetch historical hints for a query from the memory knowledge graph.
 *
 * @param _query       Task description or search query.
 * @param _projectId   Project identifier (typically the project root path).
 * @param _maxResults  Maximum number of hints to return.
 * @returns Empty array until memory integration is implemented.
 */
export async function fetchGraphHints(
  _query: string,
  _projectId: string,
  _maxResults = 5,
): Promise<Record<string, unknown>[]> {
  if (!isMemoryEnabled()) return [];

  // Future: call memory MCP server here
  return [];
}
