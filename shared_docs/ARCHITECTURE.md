# Aperant Architecture

## Table of Contents

1. [Overview](#overview)
2. [Task Lifecycle / Data Flow](#task-lifecycle--data-flow)
   - [Session Runtime](#session-runtime)
   - [Events Crossing the Worker Boundary](#events-crossing-the-worker-boundary)
3. [Agent Types, Prompts and Tools](#agent-types-prompts-and-tools)
4. [Providers and Model Resolution](#providers-and-model-resolution)

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

- `bash-validator.ts`, `command-parser.ts` and `security-profile.ts` check each Bash command against an allowlist derived from the project's security profile. `validators/` holds the per-command checks (`shell`, `git`, `filesystem`, `process`, `database`, `landing`).
- `path-containment.ts` keeps file tools inside the allowed project and worktree directories.
- `denylist.ts` blocks protected paths and commands.
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
