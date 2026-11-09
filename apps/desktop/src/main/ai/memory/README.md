# Agent Memory

This directory is the memory system that actually ships in the app: a TypeScript
implementation on a local libSQL database. It runs in the Electron main process
and in agent workers. No Python sidecar is involved.

The long design document is [Memory.md](../../../../../../Memory.md). It describes
more than is built (see [What is not shipped](#what-is-not-shipped)). Where the two
disagree, this README and the code win.

## What is stored and where

- One libSQL file: `app.getPath('userData')/memory.db`
  (`getMemoryDbPath()` in [db.ts](db.ts)). All projects share it; every row
  carries a `project_id`.
- Tables, from [schema.ts](schema.ts):
  - `memories`, `memory_embeddings`, `memories_fts` (FTS5 keyword index), `embedding_cache`
  - `observer_file_nodes`, `observer_co_access_edges`, `observer_error_patterns`,
    `observer_module_session_counts`, `observer_synthesis_log`
  - `graph_nodes`, `graph_edges`, `graph_closure`, `graph_index_state`, `scip_symbols`
- Memory types ([types.ts](types.ts)): the ones agents write and read are
  `gotcha`, `decision`, `pattern`, `error_pattern`, `module_insight`, `dead_end`,
  `causal_dependency`, `requirement`. The type also holds internal ones used by
  the observer and injection code: `preference`, `prefetch_pattern`, `work_state`,
  `task_calibration`, `e2e_observation`, `work_unit_outcome`, `workflow_recipe`,
  `context_cost`.
- Memory text derived from agent sessions in the user's code is kept locally in
  `memory.db`. It leaves the machine only if a hosted embedding provider is
  configured (see below).

## On and off

Memory runs unless the app-wide `memoryEnabled` setting is `false`. A missing
setting means on. The source of truth is `isAgentMemoryEnabled()` in
[memory-service-factory.ts](../../ipc-handlers/context/memory-service-factory.ts).
It is used by `WorkerBridge.startMemory()` and by
[github/pr-handlers.ts](../../ipc-handlers/github/pr-handlers.ts).

`getMemoryService()` in the same file is the lazy singleton: it opens the DB,
initialises embeddings and the reranker, and builds the retrieval pipeline once.

## Embeddings

`EmbeddingService.initialize()` ([embedding-service.ts](embedding-service.ts))
picks a provider once, at startup, in this order:

1. A hosted provider chosen in settings (`memoryEmbeddingProvider`, mapped in
   `buildEmbeddingConfig()`), only if its key is present: `openai`, `google`,
   `azure_openai` (also needs a deployment), `voyage`.
2. Ollama, if reachable: the configured `memoryOllamaEmbeddingModel` if Ollama
   serves it; else `qwen3-embedding:8b` (only above 32 GB RAM), `:4b`, `:0.6b`;
   else any other model whose name contains `embed`, `minilm` or `bge`.
3. Otherwise provider `none`.

`MemoryEmbeddingProvider` in `shared/types/project.ts` also lists `openrouter`,
but `embedding-service.ts` has no handling for it. Choosing it does not produce
embeddings; initialisation falls through to Ollama, then `none`.

With `none`, `degradedEmbed()` returns hash-based pseudo-vectors with no semantic
similarity. Useful results then come from BM25/FTS keyword search. This matches
the onboarding copy ("Memory will still work with keyword search").

Detection happens at startup. Stored memories are not re-embedded when the model
changes (settings text `embeddingHow`). Hosted providers send memory text to that
provider; local Ollama does not.

An optional reranker ([retrieval/reranker.ts](retrieval/reranker.ts)) is chosen
the same way: Ollama `qwen3-reranker:0.6b`, else Cohere, else passthrough.

## Flow

```
agent session
  -> observer      observe() on the main thread, sync, no DB access
  -> scratchpad    in memory, per session
  -> promotion     staged filter at finalize(), per-session-type limits
  -> store         memory.db via MemoryService
  -> retrieval     BM25 + dense + graph -> RRF -> boost -> rerank -> pack
  -> injection     planner / QA / prefetch / step-level
```

- Observer: [observer/memory-observer.ts](observer/memory-observer.ts) never
  awaits or touches the DB in `observe()`. [observer/scratchpad.ts](observer/scratchpad.ts)
  holds signals in memory for the session.
  [observer/trust-gate.ts](observer/trust-gate.ts) flags signals produced after a
  WebFetch/WebSearch call (confidence x0.7, `needsReview`).
  [observer/promotion.ts](observer/promotion.ts) runs the staged filter at
  `finalize()` with `SESSION_TYPE_PROMOTION_LIMITS` per session type.
  `MainMemoryHandler` additionally caps inferred memories per worker at
  `MAX_INFERRED_PER_SESSION` (5).
- Agent tools: `record_memory` and `search_memory` in [tools/](tools/).
- Retrieval: [retrieval/pipeline.ts](retrieval/pipeline.ts): BM25 + dense + graph
  candidates, weighted RRF fusion, graph neighbourhood boost, reranking,
  phase-aware context packing.
- Injection: builders in [injection/](injection/) for the planner
  (`planner-memory-context.ts`), QA (`qa-context.ts`), prefetch
  (`prefetch-builder.ts`) and step-level injection (`step-injection-decider.ts`).
- Structural graph: [graph/](graph/) does tree-sitter AST extraction, incremental
  indexing and impact analysis, in the same database. Its `index.ts` says it
  replaces the Python sidecar.

## How memory reaches a worker

`WorkerBridge.startMemory()` in [../agent/worker-bridge.ts](../agent/worker-bridge.ts):

- Returns `null` when memory is off or the project cannot be resolved. It never
  throws, so a memory problem cannot stop the agent.
- Otherwise it creates a `MessageChannel`, attaches a `MainMemoryHandler`
  ([ipc/main-memory-handler.ts](ipc/main-memory-handler.ts)) to `port1` and
  passes `port2` to the worker.
- In the worker, `WorkerObserverProxy`
  ([ipc/worker-observer-proxy.ts](ipc/worker-observer-proxy.ts)) sends requests
  with a 3 s timeout. On timeout the agent carries on without memory.
- When the session ends, `finalizeMemory()` calls `handler.finalize(outcome)`.
- `projectId` and `sessionId` come from the handler, not from worker messages.
  File paths are stored project-relative, so worktrees share memories.

```
 main thread                              worker thread
 WorkerBridge.startMemory()
   MainMemoryHandler <--- port1 | port2 ---> WorkerObserverProxy
     MemoryObserver                             (agent tools, observe)
     MemoryService -> memory.db
   finalizeMemory() -> handler.finalize(outcome)
```

## Legacy naming and the MCP path

- `GRAPHITI_ENABLED`, `GRAPHITI_DATABASE`, `GRAPHITI_DB_PATH` and
  `GRAPHITI_EMBEDDER_PROVIDER` are kept for backward compatibility
  (`ipc-handlers/env-handlers.ts`) and are not renamed. They do **not** control
  the shipped agent memory.
- The only Graphiti-style path is an MCP server. `mcp/registry.ts` connects when
  `GRAPHITI_MCP_URL` is set, and `agent/agent-manager.ts` sets
  `mcpOptions.memoryEnabled = !!process.env.GRAPHITI_MCP_URL`. Nothing in `src`
  assigns that variable, and the server must be run externally (the Agent Tools
  page in `AgentTools.tsx` says the same).
- [../context/graphiti-integration.ts](../context/graphiti-integration.ts) is a
  stub: its `isMemoryEnabled()` always returns `false`, so `context/builder.ts`
  never adds graph hints.
- Two different functions are named `isMemoryEnabled()`:
  - `ipc-handlers/context/utils.ts` reads `GRAPHITI_ENABLED` from the project env
    or `process.env`.
  - `ai/context/graphiti-integration.ts` always returns `false`.

  Neither is the switch for agent memory. Use `isAgentMemoryEnabled()`.

## What is not shipped

- Turso cloud sync: `getMemoryClient(tursoSyncUrl, authToken)` and
  `getWebMemoryClient` support it, but no caller passes those arguments, so
  `memory.db` is local only.
- The Convex auth and team features described in [Memory.md](../../../../../../Memory.md)
  do not exist in `src`.
