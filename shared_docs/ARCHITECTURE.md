# Aperant Architecture

## Table of Contents

1. [Overview](#overview)
2. [Task Lifecycle / Data Flow](#task-lifecycle--data-flow)
   - [Session Runtime](#session-runtime)
   - [Events Crossing the Worker Boundary](#events-crossing-the-worker-boundary)

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
