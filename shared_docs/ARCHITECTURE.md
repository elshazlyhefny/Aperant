# Aperant Architecture

## Table of Contents

1. [Overview](#overview)
2. [Task Lifecycle / Data Flow](#task-lifecycle--data-flow)
   - [Session Runtime](#session-runtime)
   - [Events Crossing the Worker Boundary](#events-crossing-the-worker-boundary)
3. [Agent Types, Prompts and Tools](#agent-types-prompts-and-tools)
4. [Providers and Model Resolution](#providers-and-model-resolution)
5. [Memory System](#memory-system)
6. [Cross-Platform Development](#cross-platform-development)
7. [End-to-End Testing](#end-to-end-testing)

All paths below are relative to `apps/desktop/src/main/` unless stated otherwise.

## Overview

Aperant is an Electron desktop app. A user describes a goal as a task. The main process runs the task through a planner, coder and QA pipeline inside worker threads, using the Vercel AI SDK v6 (`ai` package). All work happens in a git worktree. The renderer talks to the main process over IPC (`window.electronAPI.*`).

## Task Lifecycle / Data Flow

```
Renderer (window.electronAPI.*)
   |  IPC_CHANNELS.TASK_START / TASK_UPDATE_STATUS / TASK_REVIEW
   v
ipc-handlers/task-handlers.ts -> registerTaskHandlers  (re-export of ipc-handlers/task/index.ts)
   crud-handlers.ts       create, read, update, delete
   execution-handlers.ts  start, stop, review, recover
   worktree-handlers.ts   status, diff, merge, discard
   |  agentManager.startSpecCreation() / startTaskExecution() / startQAProcess()
   v
agent/agent-manager.ts  AgentManager
   resolves auth, creates the worktree (ai/worktree createOrGetWorktree),
   builds an AgentExecutorConfig
   |  processManager.spawnWorkerProcess(taskId, config, {}, processType, projectId)
   v
agent/agent-process.ts  AgentProcessManager
   creates one WorkerBridge per task and re-emits its events on the AgentManager emitter
   |  bridge.spawn(executorConfig)
   v
ai/agent/worker-bridge.ts  WorkerBridge   <== postMessage ==>   ai/agent/worker.ts  (worker_threads)
   (ai/agent/executor.ts AgentExecutor wraps the bridge: start / stop / retry)
                                                                  |
                                       run() routes by session.agentType
        +-----------------------+----------------------+-----------+----------------------+
        |                       |                      |                                  |
 'build_orchestrator'     'qa_reviewer'      'spec_orchestrator'                     other agent types
 runBuildOrchestrator()   runQALoop()        runSpecOrchestrator() or                runDefaultSession()
        |                       |            runAgenticSpecOrchestrator()                 |
        v                       v                      |                                  v
 BuildOrchestrator.run()     QALoop.run()      SpecOrchestrator                   runAgentSession()
 (build-orchestrator.ts)    (qa-loop.ts)       (spec-orchestrator.ts)             (ai/session/runner.ts)
   runPlanningPhase()
   runCodingPhase() -> iterateSubtasks()   (subtask-iterator.ts)
        |                 executeParallel() (parallel-executor.ts)
        |                 SubagentExecutorImpl (subagent-executor.ts, agentic spec mode)
   runQAPhase()  ---------> QALoop (qa-loop.ts), qa-reports.ts, recovery-manager.ts
        |
        v
 every phase runs runAgentSession() for each agent session
        |
        v
 BuildOutcome -> buildOutcomeTaskEvents() (ai/agent/build-outcome-events.ts)
        -> 'task-event' messages (QA_PASSED, BUILD_COMPLETE, PLANNING_FAILED, CODING_FAILED, QA_MAX_ITERATIONS)
        |
        v
 User review -> ipc-handlers/task/worktree-handlers.ts
        -> MergeOrchestrator.mergeTask() (ai/merge/orchestrator.ts)
        -> merge into the main branch
```

### Stages

1. **IPC handlers.** `ipc-handlers/task-handlers.ts` only re-exports `registerTaskHandlers` from `ipc-handlers/task/`. `execution-handlers.ts` handles `IPC_CHANNELS.TASK_START`, `TASK_STOP`, `TASK_REVIEW`, `TASK_UPDATE_STATUS`, `TASK_RESUME_PAUSED` and `TASK_RECOVER_STUCK`. It calls `startSpecCreation()` when the task has no spec yet, and `startTaskExecution()` or `startQAProcess()` otherwise.
2. **Agent layer.** `AgentManager` (`agent/agent-manager.ts`) owns the three entry points. They set `processType` to `'spec-creation'`, `'task-execution'` or `'qa-process'`. `agent/agent-queue.ts` (`AgentQueueManager`) is not on the task path. It runs roadmap and ideation generation. `AgentProcessManager.spawnWorkerProcess()` in `agent/agent-process.ts` creates the `WorkerBridge`, kills any earlier process for the same `taskId`, and tracks the worker in `AgentState`.
3. **Worker thread.** `WorkerBridge.spawn()` starts `ai/agent/worker.ts` with a serializable `WorkerConfig`. The model, tool context and security profile are rebuilt inside the worker, because `LanguageModel` instances and `Set` objects cannot cross the boundary. `run()` in `worker.ts` picks the pipeline from `session.agentType`.
4. **Build pipeline.** `BuildOrchestrator.run()` runs `runPlanningPhase()`, `runCodingPhase()` and `runQAPhase()`. Coding goes through `iterateSubtasks()`, which can use `executeParallel()`. `SubagentExecutorImpl` backs the `SpawnSubagent` tool when `useAgenticOrchestration` is set. Spec creation uses `SpecOrchestrator` (`ComplexityTier`: `simple`, `standard`, `complex`).
5. **QA loop.** `QALoop.run()` alternates reviewer and fixer sessions. It writes iteration history and escalation reports through `qa-reports.ts` (`generateQAReport`, `generateEscalationReport`). `RecoveryManager` classifies failures (`FailureType`) and keeps `BuildCheckpoint` data. `pause-handler.ts` provides the rate-limit and auth pause files (`RATE_LIMIT_PAUSE`, `AUTH_PAUSE`, `RESUME`, `PAUSE`).
6. **Worktree and merge.** `createOrGetWorktree()` (`ai/worktree/worktree-manager.ts`) gives the task its isolated worktree before the worker starts. After QA, the user reviews the worktree. `worktree-handlers.ts` then calls `MergeOrchestrator.mergeTask()` (`ai/merge/orchestrator.ts`). It uses `semantic-analyzer`, `conflict-detector`, `auto-merger`, `file-evolution` and `timeline-tracker`, with an `AiResolverFn` for conflicts the auto-merger cannot resolve.

### Session Runtime

`runAgentSession()` in `ai/session/runner.ts` is the one place that calls the model. Its internal `executeStream()` does the following:

- It calls `streamText()` (imported from `claude-code/sdk`) with the system prompt, `initialMessages` and the tools for the agent.
- It sets `stopWhen: stepCountIs(maxSteps)`. `maxSteps` defaults to `DEFAULT_MAX_STEPS`. With a memory context it uses `buildMemoryAwareStopCondition()` instead, which applies the calibration factor.
- It tracks prompt tokens per step against `contextWindowLimit` and aborts through its own `AbortController` when the context window is used up.
- `stream-handler.ts` (`createStreamHandler`) turns AI SDK `fullStream` parts into `StreamEvent`s for the `SessionEventCallback`. The parts are `text-delta`, `reasoning-delta`, `tool-call`, `tool-result`, `tool-error`, `finish-step` and `error`.
- `error-classifier.ts` (`classifyError`) maps errors to an `ErrorCode`: `rate_limited`, `billing_error`, `auth_failure`, `concurrency_error`, `tool_execution_error`, `aborted`, `max_steps_reached` or `generic_error`. Helpers include `isRateLimitError`, `isAuthenticationError` and `isBillingError`.
- `progress-tracker.ts` (`ProgressTracker`) infers the phase, current subtask and completed phases from stream events.
- `continuation.ts` (`runContinuableSession`) re-runs a session that stopped at the step limit. `maxContinuations` defaults to 5.
- The result is a `SessionResult` whose `outcome` is `completed`, `max_steps`, `context_window`, `cancelled` or an error outcome. `WorkerBridge.handleResult()` maps `completed`, `max_steps` and `context_window` to exit code 0 and everything else to 1.

### Events Crossing the Worker Boundary

Types live in `ai/agent/types.ts`.

**Worker to main (`WorkerMessage`).** The worker posts these with `parentPort.postMessage()` through `postMessage()`, `postLog()`, `postError()` and `postTaskEvent()` in `worker.ts`:

| `type` | Payload | `WorkerBridge.handleWorkerMessage()` |
|---|---|---|
| `log` | `data: string` | emits `log` |
| `error` | `data: string` | emits `error`, then finalizes memory as failure, emits `exit` with code 1 and releases the worker |
| `execution-progress` | `ExecutionProgressData` | `progressTracker.forcePhase()`, then emits `execution-progress` |
| `stream-event` | `StreamEvent` | feeds `ProgressTracker.processEvent()`, emits a derived `execution-progress`, and emits `log` for `text-delta` |
| `task-event` | `Record<string, unknown>` | emits `task-event` |
| `result` | `SessionResult` | `handleResult()` logs a summary and emits `exit` |

Every message carries `taskId` and an optional `projectId`.

**Main to worker (`MainToWorkerMessage`).** The only message is `{ type: 'abort' }`, sent by `WorkerBridge` when the task is stopped.

**Task events.** `task-event` messages carry the events that drive the XState task machine. `buildOutcomeTaskEvents()` (`ai/agent/build-outcome-events.ts`) chooses them from the `BuildOutcome`:

- success: `QA_PASSED`, then `BUILD_COMPLETE`
- coding finished, QA failed: `QA_MAX_ITERATIONS`
- coding never started: `PLANNING_FAILED`
- otherwise: `CODING_FAILED`

**Relay to the manager.** `AgentProcessManager.spawnWorkerProcess()` subscribes to the bridge events `log`, `error`, `execution-progress`, `task-event` and `exit`, and re-emits them on the `AgentManager` emitter. These are the `AgentManagerEvents` declared in `agent/types.ts`. On a non-zero exit code it first emits an `execution-progress` with phase `failed`.

**Phase and task markers.** The renderer-facing phase protocol still has a text form: lines containing `__EXEC_PHASE__:{json}`, parsed by `parsePhaseEvent()` and `hasPhaseMarker()` in `agent/phase-event-parser.ts`. `agent/task-event-parser.ts` and `task-event-schema.ts` do the same for task events from child-process output. `AgentEvents.handleStructuredProgress()` in `agent/agent-events.ts` takes the typed worker payload (`StructuredProgressEvent`) and returns a phase update, or null if the phase would go backwards (`wouldPhaseRegress`).


## Agent Types, Prompts and Tools

All paths in this section are under `apps/desktop/src/main/ai/` unless they start with `apps/desktop/prompts/`.

### How an agent type is resolved

An agent type (`AgentType` in `config/agent-configs.ts`) is a string key. It selects three things:

1. **Configuration.** `AGENT_CONFIGS` maps each type to `{ tools, mcpServers, mcpServersOptional?, thinkingDefault }`. `getAgentConfig()` throws on an unknown type, and `getDefaultThinkingLevel()` reads `thinkingDefault`.
2. **System prompt.** The prompt is a Markdown file in `apps/desktop/prompts/`, loaded by `prompts/prompt-loader.ts`. The agent type does not name the file by itself. Each caller picks the file: `agent/worker.ts` (`specPhaseToPromptName()` and the build and QA sessions), `orchestration/subagent-executor.ts` (`resolvePromptName()`) and the runners (`runners/roadmap.ts`, `runners/github/parallel-orchestrator.ts`).
3. **Tool set.** `ToolRegistry.getToolsForAgent(agentType, context)` in `tools/registry.ts` keeps only the registered tools whose names appear in `config.tools`, and binds each to a `ToolContext`.

### Prompt loading

`loadPrompt(name)` reads `<promptsDir>/<name>.md` and throws if it is missing. `tryLoadPrompt()` returns null instead. `name` may contain a subfolder, such as `github/pr_security_agent` or `mcp_tools/electron_validation`.

`resolvePromptsDir()` finds the directory:

- packaged app (`app.isPackaged`): `process.resourcesPath/prompts`
- dev and tests: it tries several relative candidates from `__dirname` and picks the first that contains `planner.md`

The worker (`agent/worker.ts`) has its own `loadPrompt()` with the same search idea, and falls back to `buildFallbackPrompt()` when the file is not found. `assemblePrompt()` then calls `injectContext()` to add the spec directory, project directory and project instructions (`AGENTS.md`, or `CLAUDE.md` as a fallback), for every provider. `prompts/subtask-prompt-generator.ts` and `prompts/subtask-brief.ts` build the per-subtask prompt from the planner and coder prompts.

Prompt files that exist today: `planner`, `coder`, `coder_recovery`, `followup_planner`, `qa_reviewer`, `qa_fixer`, `spec_gatherer`, `spec_researcher`, `spec_writer`, `spec_critic`, `spec_quick`, `spec_orchestrator_agentic`, `qa_orchestrator_agentic`, `complexity_assessor`, `validation_fixer`, `insight_extractor`, `roadmap_discovery`, `roadmap_features`, `competitor_analysis`, seven `ideation_*` files, plus the folders `github/` (PR review, triage and issue prompts) and `mcp_tools/` (`api_validation`, `chrome_devtools_browser`, `database_validation`, `electron_validation`).

### Builtin tools

`tools/build-registry.ts` (`buildToolRegistry()`) registers the builtin tools from `tools/builtin/`. The worker threads, the runners and the client factory all use it. `tools/define.ts` provides `Tool.define()`, which wraps an AI SDK `tool()` with a Zod input schema, permission metadata and `bind(context)`. `tools/truncation.ts` limits tool output size.

| Registry name | File |
|---|---|
| `Read` | `tools/builtin/read.ts` |
| `Write` | `tools/builtin/write.ts` |
| `Edit` | `tools/builtin/edit.ts` |
| `Bash` | `tools/builtin/bash.ts` |
| `Glob` | `tools/builtin/glob.ts` |
| `Grep` | `tools/builtin/grep.ts` |
| `WebFetch` | `tools/builtin/web-fetch.ts` |
| `WebSearch` | `tools/builtin/web-search.ts` |
| `SpawnSubagent` | `tools/builtin/spawn-subagent.ts` |

`SpawnSubagent` is the ninth tool, not counted in older docs. It lets an orchestrator agent start a sub-session of another type through `orchestration/subagent-executor.ts`. Only `spec_orchestrator` and `build_orchestrator` have it in their tool list.

### Security layer

Tool permission is enforced when a tool runs, not by hiding tools, so most agents receive the full builtin set. The code is in `security/`:

- `bash-validator.ts`, `command-parser.ts` and `security-profile.ts` check each Bash command against a denylist (allow-by-default, a guardrail rather than a sandbox). `validators/` holds the per-command checks (`shell`, `git`, `filesystem`, `process`, `database`, `landing`).
- `path-containment.ts` keeps file tools inside the allowed project and worktree directories.
- `denylist.ts` blocks protected paths and commands.
- `child-env.ts` scrubs credential variables from the environment of Bash and MCP child processes.
- `sandbox.ts` is the opt-in OS sandbox (bubblewrap or `sandbox-exec`), the real isolation control.
- `secret-scanner.ts` detects secrets.
- `tool-input-validator.ts` checks tool inputs before execution.

### MCP servers

`mcpServers` in an agent config names MCP servers, not tools. `getRequiredMcpServers()` (`config/agent-configs.ts`) resolves them for a run:

- `context7` is dropped when `context7Enabled` is false.
- `memory` is kept only when `memoryEnabled` is true.
- `browser` becomes `electron` for an Electron project with Electron MCP on, otherwise `chrome-devtools` when it is enabled, otherwise nothing.
- per-agent add and remove lists (`agentMcpAdd`, `agentMcpRemove`) and custom server ids are applied last.

`mcp/registry.ts` holds the server definitions (stdio or streamable HTTP), `mcp/client.ts` connects them (`createMcpClientsForAgent()`, `mergeMcpTools()`, `closeAllMcpClients()`), and `mcp/command-policy.ts` and `mcp/project-settings.ts` restrict and configure them. MCP tools appear with names such as `mcp__context7__query-docs`. The worker connects servers per agent type and shares clients by server id.

### Agent types

The table lists every key of `AGENT_CONFIGS`. "Builtin" is `ALL` for the full set (Read, Glob, Grep, Write, Edit, Bash, WebFetch, WebSearch), `SPEC` for Read, Glob, Grep, Write, WebFetch and WebSearch, and `READ` for Read, Glob, Grep. "Prompt" is the file the caller most likely loads. The `github/` names are inferred from file names, not traced in every case.

| Agent type | Builtin tools | MCP servers | Thinking | Prompt |
|---|---|---|---|---|
| `spec_gatherer` | SPEC | context7 | medium | `spec_gatherer` |
| `spec_researcher` | SPEC | context7 | medium | `spec_researcher` |
| `spec_writer` | SPEC | context7 | high | `spec_writer` |
| `spec_critic` | SPEC | context7 | high | `spec_critic` |
| `spec_discovery` | SPEC | context7 | medium | `spec_gatherer` |
| `spec_context` | SPEC | context7 | medium | `spec_writer` |
| `spec_validation` | SPEC | context7 | high | `spec_writer` |
| `spec_compaction` | SPEC | context7 | medium | none traced |
| `spec_orchestrator` | ALL + SpawnSubagent | context7 | high | `spec_orchestrator_agentic` |
| `build_orchestrator` | ALL + SpawnSubagent | context7, memory | high | none traced; the build pipeline is code in `orchestration/` |
| `planner` | ALL | context7, memory | high | `planner` |
| `coder` | ALL | context7, memory | low | `coder` (`coder_recovery` on recovery) |
| `qa_reviewer` | ALL | context7, memory, browser | high | `qa_reviewer` |
| `qa_fixer` | ALL | context7, memory, browser | medium | `qa_fixer` |
| `insights` | ALL | none | low | built in `runners/insights.ts` |
| `merge_resolver` | none | none | low | built in the merge code |
| `commit_message` | none | none | low | built inline |
| `pr_template_filler` | ALL | none | low | `github/pr_template_filler` |
| `pr_reviewer` | ALL | context7 | high | `github/pr_reviewer` |
| `pr_orchestrator_parallel` | ALL | context7 | high | `github/pr_parallel_orchestrator` |
| `pr_followup_parallel` | ALL | context7 | high | `github/pr_followup_orchestrator` |
| `pr_followup_extraction` | none | none | low | `github/pr_followup` family |
| `pr_finding_validator` | ALL | none | medium | `github/pr_finding_validator` |
| `pr_security_specialist` | READ | none | medium | `github/pr_security_agent` |
| `pr_quality_specialist` | READ | none | medium | `github/pr_quality_agent` |
| `pr_logic_specialist` | READ | none | medium | `github/pr_logic_agent` |
| `pr_codebase_fit_specialist` | READ | none | medium | `github/pr_codebase_fit_agent` |
| `analysis` | ALL | context7 | medium | runner specific |
| `batch_analysis` | ALL | none | low | runner specific |
| `batch_validation` | ALL | none | low | runner specific |
| `roadmap_discovery` | ALL | context7 | high | `roadmap_discovery` |
| `competitor_analysis` | ALL | context7 | high | `competitor_analysis` |
| `ideation` | ALL | none | high | `ideation_*` |

Rows marked "runner specific", "none traced" or "built inline" are agent types whose prompt text I did not find loaded from one named file. Check the calling runner before relying on those cells.


## Providers and Model Resolution

### Rule

Every model call goes through the Vercel AI SDK (`ai`, v6). Code builds a model with `createProvider()` and calls `streamText()` or `generateText()`. `@anthropic-ai/sdk` is not used. The one non-obvious exception to "call `ai` directly" is the Claude Code engine, described below. It still presents an AI SDK model.

### Supported providers

`providers/types.ts` defines `SupportedProvider`, and `providers/registry.ts` and `providers/factory.ts` handle each one in an exhaustive `switch`. There are eleven, not the nine that older notes list:

| Id | SDK package or adapter | Notes |
|---|---|---|
| `anthropic` | `@ai-sdk/anthropic` | OAuth tokens use `authToken` and a beta header; see the Claude Code engine |
| `openai` | `@ai-sdk/openai` | Codex OAuth accounts and Codex models use `.responses()`, others `.chat()` |
| `google` | `@ai-sdk/google` | |
| `bedrock` | `@ai-sdk/amazon-bedrock` | region defaults to `us-east-1` |
| `azure` | `@ai-sdk/azure` | uses the deployment name through `.chat()` |
| `mistral` | `@ai-sdk/mistral` | |
| `groq` | `@ai-sdk/groq` | |
| `xai` | `@ai-sdk/xai` | |
| `openrouter` | `@openrouter/ai-sdk-provider` | |
| `zai` | `@ai-sdk/openai-compatible` | default base URL `https://api.z.ai/api/paas/v4` |
| `ollama` | `@ai-sdk/openai-compatible` | default `http://localhost:11434`, `/v1` is appended |

### Factory, registry and transforms

- `providers/factory.ts`: `createProvider({ config, modelId })` returns a `LanguageModel`. `detectProviderFromModel()` and `createProviderFromModelId()` infer the provider from a model id prefix, using `MODEL_PROVIDER_MAP` in `config/types.ts` (`claude-`, `gpt-`, `o1-`, `o3-`, `o4-`, `codex-`, `gemini-`, `mistral-`, `codestral-`, `llama-`, `grok-`, `glm-`).
- `providers/registry.ts`: `buildRegistry()` wraps `createProviderRegistry()` so a model can be addressed as `provider:model`.
- `providers/transforms.ts`: normalizes thinking settings per provider (`transformThinkingConfig()`, `getThinkingKwargsForModel()`, `isAdaptiveModel()`), tool ids (`normalizeToolId()`), and prompt-cache breakpoints (`getCacheBreakpoints()`, `meetsCacheThreshold()`).
- `providers/oauth-fetch.ts`: `createOAuthProviderFetch()` returns a `fetch` that injects a file-based OAuth token and rewrites URLs; it is used for OpenAI Codex accounts. `ensureValidOAuthToken()` refreshes the token.

### Credentials

`auth/resolver.ts` resolves credentials with `resolveAuth()` and, for account queues, `resolveAuthFromQueue()`. It reuses `claude-profile/` (`token-refresh`, `profile-scorer`, credential storage) instead of storing credentials itself. The order is: profile OAuth token, profile API key from settings, provider environment variable (`PROVIDER_ENV_VARS` in `auth/types.ts`), then default credentials such as Ollama needing none. `auth/codex-oauth.ts` handles Codex OAuth. Z.AI keys are routed to the general or the coding endpoint.

### Client factory

`client/factory.ts` is the usual entry point:

- `createAgentClient()` resolves auth, picks the model with `resolveModelId()`, calls `createProvider()`, connects MCP servers for the agent type, builds the tool set from `buildToolRegistry()` and `AGENT_CONFIGS`, and returns everything `runAgentSession()` needs plus a `cleanup()`. Default `maxSteps` is 200.
- `createSimpleClient()` is the light version for utility runners (commit messages, PR templates, analysis), with a default of 1 step.

### Phase-based model and thinking resolution

`config/phase-config.ts` works with the four phases `spec`, `planning`, `coding` and `qa`. Defaults are in `config/types.ts`: model `sonnet` for all phases, and thinking `medium`, `high`, `medium`, `high` respectively.

- `getPhaseModel(specDir, phase, cliModel?)`: a CLI model wins; then, for an auto profile, the phase entry in `task_metadata.json`; then the single task model; then the default. The result goes through `resolveModelId()` (shorthand to full id via `MODEL_ID_MAP`).
- `getPhaseThinking()` uses the same order for the thinking level.
- `resolveSessionModelId()` (a zeenha fork addition) applies a phase's model only when the worker is on Anthropic and the result is a Claude model, so a phase can never mismatch the worker's provider.
- `getThinkingBudget()`, `getPhaseConfig()` and `getPhaseClientThinkingKwargs()` turn a level into provider options; adaptive models use an effort level, others a token budget. `getModelBetas()` adds beta headers such as the 1M context window.
- `SPEC_PHASE_THINKING_LEVELS` sets thinking per spec sub-phase, and the agent's own `thinkingDefault` applies when nothing else does.

### Claude Code engine (alternate path for subscriptions)

When an Anthropic credential is an OAuth token (`sk-ant-oa…` or `sk-ant-ort…`), `usesClaudeCodeEngine()` in `providers/factory.ts` is true and `createProvider()` returns `createClaudeCodeModel()` from `claude-code/model.ts` instead of an API model. Setting `APERANT_CLAUDE_ENGINE=api` turns this off. The reason is in the source comment: the Messages API refuses subscription tokens from clients other than Claude Code.

The code in `claude-code/`:

- `model.ts`: a spec-v3 `LanguageModel` that answers single requests without tools.
- `sdk.ts`: drop-in `streamText()` and `generateText()`. For any model other than a Claude Code model, or a Claude Code model without tools, they call the AI SDK unchanged. With tools, they run the whole loop in the CLI. `session/runner.ts`, the runners and the subagent executor import these instead of `ai`.
- `engine.ts` and `cli-args.ts`: spawn `claude -p`, build its arguments and environment (`CLAUDE_CONFIG_DIR` of the chosen profile), and stream the output.
- `cli-events.ts`: parse the CLI's event stream into parts and steps.
- `tool-bridge.ts`: serves Aperant's own tools to the CLI, so the security layer still applies.

Limits on this path: `prepareStep` cannot inject text between steps, so mid-session nudges and memory injection do not happen, and the CLI compacts its own context.

## Memory System

Memory is a local, TypeScript implementation under `ai/memory/`. CLAUDE.md describes it as a Graphiti knowledge graph reached through a Python MCP sidecar. That describes only an optional add-on today.

### Where the code differs from the CLAUDE.md summary

- The primary memory store is a libSQL (SQLite) file written by TypeScript code in the Electron main process. It is not Graphiti.
- No Python Graphiti sidecar is in this repository (the repo has only `apps/desktop/`). The memory MCP server exists only as a client-side hook. `ai/mcp/registry.ts` builds a `memory` server (StreamableHTTP) only when `GRAPHITI_MCP_URL` is set, and `agent/agent-manager.ts` sets `memoryEnabled` from that variable. Without a sidecar behind that URL, nothing uses it.
- `ai/context/graphiti-integration.ts` is a stub. `isMemoryEnabled()` always returns `false` and `fetchGraphHints()` returns `[]`. Its own header says memory now lives in `ai/memory/`. `isGraphitiEnabled` is a deprecated alias.
- The "knowledge graph" in the local store is a code graph (files, symbols and their edges, built with tree-sitter), not Graphiti's entity graph.

### Local store

- `db.ts`: `getMemoryClient()` lazily loads `@libsql/client/sqlite3` through CJS `require()`, so the native module resolves from `Resources/node_modules/` in a packaged app. The factory documents three modes (local file, Turso embedded replica, pure cloud). In Electron the file is `memory.db` in `app.getPath('userData')`, shared by every project; rows carry a `project_id`. `getInMemoryClient()` serves tests.
- `schema.ts`: `MEMORY_SCHEMA_SQL` creates `memories`, `memory_embeddings`, the `memories_fts` FTS5 table, `embedding_cache` (7-day TTL), the `observer_*` tables (file nodes, co-access edges, error patterns, module session counts, synthesis log) and the graph tables (`graph_nodes`, `graph_edges`, `graph_closure`, `graph_index_state`, `scip_symbols`). `MEMORY_PRAGMA_SQL` runs separately.
- `types.ts`: a memory has a `MemoryType` (`gotcha`, `decision`, `preference`, `pattern`, `requirement`, `error_pattern`, `module_insight`, `prefetch_pattern`, `work_state`, `causal_dependency`, `task_calibration`, `e2e_observation`, `dead_end`, `work_unit_outcome`, `workflow_recipe`, `context_cost`), a `MemorySource` (`agent_explicit`, `observer_inferred`, `qa_auto`, `mcp_auto`, `commit_auto`, `user_taught`) and a `MemoryScope` (`global`, `module`, `work_unit`, `session`).
- `memory-service.ts`: `MemoryServiceImpl` offers `store`, `search`, `searchByPattern`, `insertUserTaught`, `searchWorkflowRecipe`, `updateAccessCount`, `deprecateMemory`, `verifyMemory`, `pinMemory` and `deleteMemory`.
- `embedding-service.ts`: `EmbeddingService` picks a provider (OpenAI, Google, Azure, Voyage, or an Ollama model such as qwen3-embedding 8b/4b/0.6b or another embedding model) and falls back to a hash-based embedding with no semantic similarity. It prepends file or module context to each text and caches vectors in `embedding_cache`.

### Retrieval (`retrieval/`)

`RetrievalPipeline` combines BM25 (`bm25-search.ts`), dense search, graph search and optional HyDE. `query-classifier.ts` weights the paths per query type, `rrf-fusion.ts` merges them with weighted reciprocal rank fusion, `graph-boost.ts` boosts graph neighbours, `reranker.ts` reranks, and `context-packer.ts` fits the result to a token budget.

### Code graph (`graph/`)

`tree-sitter-loader.ts`, `ast-extractor.ts` and `ast-chunker.ts` parse source. `graph-database.ts` stores nodes and edges, `incremental-indexer.ts` keeps them current, and `impact-analyzer.ts` answers "what does this change affect".

### How memories are recorded

1. `agent/worker-bridge.ts` creates a `MainMemoryHandler` (`memory/ipc/main-memory-handler.ts`) per agent worker on the main thread, attached to a dedicated `MessagePort` (`memoryPort`), not the worker's event channel.
2. In the worker, `agent/worker.ts` builds a `WorkerObserverProxy` on that port. It gives agents two tools, `record_memory` and `search_memory` (`memory/tools/`), and passes `memoryContext` to the session runner.
3. `observer/memory-observer.ts` watches tool calls and other signals (`signals.ts`) and keeps candidates in a scratchpad. `trust-gate.ts`, `promotion.ts` and `dead-end-detector.ts` decide what gets promoted.
4. On `finalize()`, the main-thread handler promotes the candidates and stores them through `MemoryServiceImpl`. The handler, not the worker message, supplies `projectId` and `sessionId`, and it rewrites file paths relative to the project so worktrees share memories.

### How memories are injected

- `session/runner.ts`: when `memoryContext` is present, `prepareStep` uses `StepInjectionDecider` and `StepMemoryState` (`injection/`) to add relevant memories between steps, and `buildMemoryAwareStopCondition` adjusts the step limit using a calibration factor.
- `injection/planner-memory-context.ts`, `prefetch-builder.ts` and `qa-context.ts` build context for the planner, file prefetch and QA sessions.
- The Claude Code engine path cannot inject between steps, so it gets no mid-session memory (see the limits under [Providers and Model Resolution](#providers-and-model-resolution)).

### Other pieces

- `ipc-handlers/memory-handlers.ts` is not the memory store's API. It registers only the Ollama handlers (status, install check, install, list models, list embedding models, pull model with progress), which serve the embedding setup.
- `Memory.md` at the repository root is the original design document ("V5"). Treat it as design intent, not as a description of the code.

## Cross-Platform Development

Aperant runs on Windows, macOS and Linux. Platform logic lives in `platform/`, and the rule is: **never read `process.platform` directly outside that module**. Import from it instead. (A few older files still read it directly, for example `utils/windows-paths.ts` and `claude-profile/credential-utils.ts`; do not copy them.)

### The platform module

- `platform/types.ts`: the `OS` enum, `ShellType`, `PathConfig`, `ShellConfig` and `BinaryDirectories`.
- `platform/index.ts`:
  - Detection: `getCurrentOS()`, `isWindows()`, `isMacOS()`, `isLinux()`, `isUnix()`, `getPlatformDescription()`.
  - Paths: `getPathConfig()`, `getPathDelimiter()` (`;` on Windows, `:` elsewhere), `joinPaths(...)`, `normalizePath()`, `isSecurePath()` (rejects traversal and unsafe characters), `getHomebrewPath()`, `getBinaryDirectories()`.
  - Executables: `findExecutable(name, additionalPaths)` searches `PATH`, then platform binary directories, then common install locations, and returns a path or `null`. `getExecutableExtension()` and `withExecutableExtension()` add `.exe` where needed. `getNpmCommand()` and `getNpxCommand()` return the right binary name.
  - Shells: `getShellConfig(preferredShell)` and `requiresShell(command)`. On Windows, `.cmd` and `.bat` files need a shell to run.
  - Environment and processes: `getEnvVar()` (case-insensitive on Windows) and `killProcessGracefully()` with `GRACEFUL_KILL_TIMEOUT_MS`.
- `platform/paths.ts`: tool lookup lists such as `getClaudeExecutablePath()`, `getPythonCommands()`, `getGitExecutablePath()`, `getNodeExecutablePath()`, `getNpmExecutablePath()`, `getWindowsShellPaths()`, `expandWindowsEnvVars()`, `getOllamaExecutablePaths()`, `getOllamaInstallCommand()`, `getWhichCommand()` and `getWindowsToolPath()`. `index.ts` re-exports some of them.

Practical rules: look up tools with `findExecutable()` instead of hardcoding paths, build paths with `joinPaths()` instead of string concatenation, and check `requiresShell()` before spawning anything that could be a `.cmd` or `.bat` file.

### Guides

- [guides/windows-development.md](../guides/windows-development.md): Windows-specific development notes.
- [guides/linux.md](../guides/linux.md): Linux installation and building (Flatpak and other packages).

### CI in this fork

`.github/workflows/ci.yml` runs the `test-frontend` job on a matrix of `ubuntu-latest` and `macos-latest` (type check, unit tests, integration tests, build). CI does not run on Windows for this fork, so keep Windows paths working by reading the code, and test them by hand where you can.

## End-to-End Testing

There are two separate things: QA agents driving a running Electron app through an MCP server, and Playwright tests for the app.

### Electron MCP for QA agents

1. Start the app with remote debugging: `npm run dev:mcp` (`electron-vite dev -- --remote-debugging-port=9222`), or `npm run start:mcp` (`electron . --remote-debugging-port=9222`) for a built app. `npm run dev:debug` only sets `DEBUG=true` and does not open the debugging port.
2. Set `ELECTRON_MCP_ENABLED=true` in the project's `.env`. The settings UI writes it through `ipc-handlers/env-handlers.ts`, and `ai/mcp/project-settings.ts` reads it as `electronMcpEnabled`.
3. `ai/mcp/registry.ts` defines the `electron` server: stdio, `npx -y electron-mcp-server`, off by default, for QA agents only, and it attaches to the app over the Chrome DevTools Protocol. The registry only launches that external package; no CDP server is implemented in this repository.
4. `ai/config/agent-configs.ts` lists the tools a QA agent may call (`ELECTRON_TOOLS`): `mcp__electron__get_electron_window_info`, `mcp__electron__take_screenshot`, `mcp__electron__send_command_to_electron` and `mcp__electron__read_electron_logs`. `ai/tools/registry.ts` reads `ELECTRON_MCP_ENABLED` when it assembles tools.

The tool names `click_by_text`, `fill_input`, `get_page_structure`, `send_keyboard_shortcut` and `eval` that CLAUDE.md lists do not appear in this repository. They may be commands accepted by `send_command_to_electron` in the external `electron-mcp-server`, but this code does not confirm that.

### Playwright

- `npm run test:e2e` runs `npx playwright test --config=e2e/playwright.config.ts`. The config in `apps/desktop/e2e/` matches `**/*.e2e.ts`, runs one worker serially, allows 60 s per test, retries twice in CI, and takes screenshots on failure. The specs are `claude-accounts.e2e.ts`, `flows.e2e.ts` and `terminal-copy-paste.e2e.ts`, with `electron-helper.ts` as the launcher helper.
- `.github/workflows/e2e.yml` builds the app and runs `xvfb-run --auto-servernum npm run test:e2e` on `ubuntu-latest`.
- Vitest also runs unit tests (`npm run test:unit`) and integration tests (`npm run test:integration`). `src/__tests__/e2e/smoke.test.ts` is a Vitest test with mocked IPC, not a Playwright test.

### Dev-instance isolation

An unpackaged app keeps its data and default Claude profile in `apps/desktop/.dev-user-data/` (`main/dev-instance-isolation.ts`). It does not use the installed app's accounts, so use a dev run to test the UI, not to run real agents. Start only one dev instance at a time, because task worktrees share the Vite cache. If startup fails with `does not provide an export named 'app'`, run `unset ELECTRON_RUN_AS_NODE` first.
