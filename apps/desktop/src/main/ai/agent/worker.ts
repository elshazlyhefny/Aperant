/**
 * Worker Thread Entry Point
 * =========================
 *
 * Runs in an isolated worker_thread. Receives configuration via `workerData`,
 * executes `runAgentSession()`, and posts structured messages back to the
 * main thread via `parentPort.postMessage()`.
 *
 * Path handling:
 * - Dev: Loaded directly by electron-vite from source
 * - Production: Bundled into app resources (app.isPackaged)
 */

import { parentPort, workerData } from 'worker_threads';
import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

import { runContinuableSession } from '../session/continuation';
import { createProvider } from '../providers/factory';
import type { SupportedProvider } from '../providers/types';
import { getModelContextWindow, modelSupportsVision } from '../../../shared/constants/models';
import { refreshOAuthTokenReactive } from '../auth/resolver';
import { buildToolRegistry } from '../tools/build-registry';
import type { ToolRegistry } from '../tools/registry';
import { SubagentExecutorImpl } from '../orchestration/subagent-executor';
import type { ToolContext } from '../tools/types';
import type { SecurityProfile } from '../security/bash-validator';
import { parseEnvPassthrough } from '../security/child-env';
import { parseSandboxMode } from '../security/sandbox';
import { parseWebFetchProvider } from '../tools/providers/types';
import type {
  WorkerConfig,
  WorkerMessage,
  MainToWorkerMessage,
  SerializableSessionConfig,
  WorkerTaskEventMessage,
} from './types';
import type { Tool as AITool } from 'ai';
import type { SessionConfig, StreamEvent, SessionResult } from '../session/types';
import { BuildOrchestrator } from '../orchestration/build-orchestrator';
import { QALoop } from '../orchestration/qa-loop';
import { SpecOrchestrator } from '../orchestration/spec-orchestrator';
import type { SpecPhase } from '../orchestration/spec-orchestrator';
import type { AgentType } from '../config/agent-configs';
import type { Phase } from '../config/types';
import type { ExecutionPhase } from '../../../shared/constants/phase-protocol';
import { getPhaseThinking, resolveSessionModelId } from '../config/phase-config';
import { TaskLogWriter, phaseEndMessage } from '../logging/task-log-writer';
import { loadProjectInstructions, injectContext, promptSearchDirs } from '../prompts/prompt-loader';
import { buildSubtaskBrief } from '../prompts/subtask-brief';
import { appendRunMetrics, buildSessionEntry, readRunMetrics, SessionMetricsCollector } from '../logging/run-metrics';
import { connectMcpServers, resolveMcpServersForAgent, mergeMcpTools, closeAllMcpClients } from '../mcp/client';
import { mcpResolveOptionsForAgent } from '../mcp/project-settings';
import type { McpClientResult } from '../mcp/types';
import { runProjectIndexer } from '../project/project-indexer';
import { WorkerObserverProxy } from '../memory/ipc/worker-observer-proxy';
import { createRecordMemoryTool } from '../memory/tools/record-memory';
import { createSearchMemoryTool } from '../memory/tools/search-memory';
import type { MemorySessionContext } from '../session/runner';
import { buildOutcomeTaskEvents, budgetPauseMessage, budgetPauseTaskEvents } from './build-outcome-events';
import { budgetGateResult, budgetPauseResult } from './budget-gate';
import { TokenBudgetGuard } from '../session/token-budget';
import { TOKEN_BUDGET_ERROR_CODE } from '../session/types';
import { budgetTokens, parseTokenBudget } from '../../../shared/utils/token-budget';

// =============================================================================
// Validation
// =============================================================================

if (!parentPort) {
  throw new Error('worker.ts must be run inside a worker_thread');
}

const config = workerData as WorkerConfig;
if (!config?.taskId || !config?.session) {
  throw new Error('worker.ts requires valid WorkerConfig via workerData');
}

// =============================================================================
// Memory (zeenha fork)
// =============================================================================

// Present only when the main thread opened a memory channel for this worker.
// The main-thread handler owns the real project id; the one passed here is
// only a label, never trusted for storage.
const memoryProxy = config.memoryPort ? new WorkerObserverProxy(config.memoryPort) : null;

/** record_memory + search_memory, when this worker has memory. */
function memoryTools(): Record<string, AITool> {
  if (!memoryProxy) return {};
  const projectLabel = config.projectId ?? '';
  return {
    record_memory: createRecordMemoryTool(memoryProxy, projectLabel, config.taskId) as AITool,
    search_memory: createSearchMemoryTool(memoryProxy, projectLabel) as AITool,
  };
}

/** Runner option that turns on observation and between-step injection. */
function memoryContext(): { memoryContext?: MemorySessionContext } {
  return memoryProxy ? { memoryContext: { proxy: memoryProxy } } : {};
}

// =============================================================================
// Task Log Writer
// =============================================================================

// Single writer instance for this worker's spec, shared across all sessions
// so that planning/coding/QA phases accumulate into one task_logs.json file.
const logWriter = config.session.specDir
  ? new TaskLogWriter(config.session.specDir, basename(config.session.specDir))
  : null;

// =============================================================================
// Messaging Helpers
// =============================================================================

function postMessage(message: WorkerMessage): void {
  parentPort!.postMessage(message);
}

function postLog(data: string): void {
  postMessage({ type: 'log', taskId: config.taskId, data, projectId: config.projectId });
}

function postError(data: string): void {
  postMessage({ type: 'error', taskId: config.taskId, data, projectId: config.projectId });
}

function postTaskEvent(eventType: string, extra?: Record<string, unknown>): void {
  parentPort?.postMessage({
    type: 'task-event',
    taskId: config.taskId,
    projectId: config.projectId,
    data: {
      type: eventType,
      taskId: config.taskId,
      specId: config.session.specDir ? basename(config.session.specDir) : config.taskId,
      projectId: config.projectId ?? '',
      timestamp: new Date().toISOString(),
      eventId: `${config.taskId}-${eventType}-${Date.now()}`,
      sequence: Date.now(),
      ...extra,
    },
  } satisfies WorkerTaskEventMessage);
}

// =============================================================================
// Abort Handling
// =============================================================================

const abortController = new AbortController();

parentPort.on('message', (msg: MainToWorkerMessage) => {
  if (msg.type === 'abort') {
    abortController.abort();
  }
});

// =============================================================================
// Token Budget (zeenha fork)
// =============================================================================

let budgetGuard: TokenBudgetGuard | null = null;
let budgetTrip: { used: number; limit: number } | null = null;

/** Tokens already spent by this task. The worktree and main spec dir can differ; the larger one is the fuller record. */
function readSpentTokens(session: SerializableSessionConfig): number {
  const total = (dir: string | undefined): number => {
    if (!dir) return 0;
    return readRunMetrics(dir).reduce((sum, entry) => sum + (entry.tokens ? budgetTokens(entry.tokens) : 0), 0);
  };
  return Math.max(total(session.specDir), total(session.sourceSpecDir));
}

function createBudgetGuard(session: SerializableSessionConfig): TokenBudgetGuard | null {
  const limit = parseTokenBudget(session.tokenBudget);
  if (!limit) return null;
  return new TokenBudgetGuard({ limit, readSpentTokens: () => readSpentTokens(session) });
}

/** Records the budget stop once, aborts the worker's work and logs the numbers. */
function tripBudget(guard: TokenBudgetGuard): void {
  if (budgetTrip) return;
  budgetTrip = guard.snapshot();
  abortController.abort();
  postLog(budgetPauseMessage(budgetTrip));
}

// =============================================================================
// Shared Helpers
// =============================================================================

/**
 * Reconstruct the SecurityProfile from the serialized form in session config.
 * SecurityProfile uses Set objects that can't cross worker boundaries.
 */
function buildSecurityProfile(session: SerializableSessionConfig): SecurityProfile {
  const serialized = session.toolContext.securityProfile;
  return {
    baseCommands: new Set(serialized?.baseCommands ?? []),
    stackCommands: new Set(serialized?.stackCommands ?? []),
    scriptCommands: new Set(serialized?.scriptCommands ?? []),
    customCommands: new Set(serialized?.customCommands ?? []),
    customScripts: { shellScripts: serialized?.customScripts?.shellScripts ?? [] },
    // zeenha fork: carried from the main process; left undefined (= ON) when missing.
    prOnlyLanding: serialized?.prOnlyLanding,
    envPassthrough: parseEnvPassthrough(serialized?.envPassthrough),
    bashSandbox: parseSandboxMode(serialized?.bashSandbox),
    // zeenha fork: unknown or missing = 'jina'.
    webFetchProvider: parseWebFetchProvider(serialized?.webFetchProvider),
    getAllAllowedCommands() {
      return new Set([
        ...this.baseCommands,
        ...this.stackCommands,
        ...this.scriptCommands,
        ...this.customCommands,
      ]);
    },
  };
}

/**
 * Build a ToolContext for the given session config.
 */
function buildToolContext(session: SerializableSessionConfig, securityProfile: SecurityProfile): ToolContext {
  return {
    cwd: session.toolContext.cwd,
    projectDir: session.toolContext.projectDir,
    specDir: session.toolContext.specDir,
    securityProfile,
    abortSignal: abortController.signal,
    modelSupportsVision: modelSupportsVision(session.modelId),
  };
}


/**
 * Load a prompt file from the prompts directory.
 * The prompts dir is expected relative to the worker file's location.
 * In dev and production, the worker sits in the main/ output folder.
 */
function loadPrompt(promptName: string): string | null {
  const candidateBases = promptSearchDirs(promptName, __dirname, process.resourcesPath);

  for (const base of candidateBases) {
    const promptPath = join(base, `${promptName}.md`);
    try {
      if (existsSync(promptPath)) {
        return readFileSync(promptPath, 'utf-8');
      }
    } catch {
      // Try next
    }
  }
  return null;
}

// =============================================================================
// MCP Clients (module-scope for worker lifetime)
// =============================================================================

const mcpClients: McpClientResult[] = [];

/**
 * zeenha fork: MCP clients are resolved PER AGENT TYPE and shared by id.
 * Upstream connected once, for the worker's entry agent type, and handed those
 * tools to every phase: a build ran with `build_orchestrator`'s servers, so the
 * QA phases' `browser` server (and any per-agent override) never started.
 */
const mcpClientById = new Map<string, McpClientResult>();
const mcpFailedIds = new Set<string>();

function mcpResolveOptionsFor(agentType: AgentType) {
  return mcpResolveOptionsForAgent(config.session.mcpOptions, agentType);
}

/** MCP tools for one agent type; connects servers not yet connected. */
async function mcpToolsFor(agentType: AgentType): Promise<Record<string, AITool>> {
  const configs = resolveMcpServersForAgent(agentType, mcpResolveOptionsFor(agentType), {
    customServers: config.session.mcpOptions?.customServers,
    chromeDevtools: {
      executablePath: config.session.mcpOptions?.chromeDevtoolsExecutable,
      webmcp: config.session.mcpOptions?.chromeDevtoolsWebmcp,
      secureOrigins: config.session.mcpOptions?.chromeDevtoolsSecureOrigins,
    },
  });
  const missing = configs.filter((c) => !mcpClientById.has(c.id) && !mcpFailedIds.has(c.id));
  if (missing.length > 0) {
    const fresh = await connectMcpServers(missing, (id, error) => {
      mcpFailedIds.add(id);
      postLog(`MCP server "${id}" failed to start (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
    });
    for (const client of fresh) {
      mcpClientById.set(client.serverId, client);
      mcpClients.push(client);
    }
    if (fresh.length > 0) {
      postLog(`MCP initialized for ${agentType}: ${fresh.map((c) => c.serverId).join(', ')}`);
    }
  }
  const active = configs
    .map((c) => mcpClientById.get(c.id))
    .filter((c): c is McpClientResult => c !== undefined);
  return mergeMcpTools(active) as Record<string, AITool>;
}

// =============================================================================
// Prompt Assembly (provider-agnostic context injection)
// =============================================================================

let cachedProjectInstructions: string | null | undefined;
let cachedProjectInstructionsSource: string | null = null;

/**
 * Assemble a full system prompt by loading the base prompt and injecting
 * project instructions (AGENTS.md or CLAUDE.md fallback). Provider-agnostic —
 * injected for ALL AI providers, not just Anthropic.
 */
async function assemblePrompt(
  promptName: string,
  session: SerializableSessionConfig,
): Promise<string> {
  const basePrompt = loadPrompt(promptName)
    ?? buildFallbackPrompt(promptName as AgentType, session.specDir, session.projectDir);

  // Load project instructions once per worker lifetime
  if (cachedProjectInstructions === undefined) {
    const result = await loadProjectInstructions(session.projectDir);
    cachedProjectInstructions = result?.content ?? null;
    cachedProjectInstructionsSource = result?.source ?? null;
    if (result) {
      postLog(`Project instructions loaded from ${result.source} (${(result.content.length / 1024).toFixed(1)}KB)`);
    } else {
      postLog('No project instructions found (checked AGENTS.md, CLAUDE.md)');
    }
  }

  return injectContext(basePrompt, {
    specDir: session.specDir,
    projectDir: session.projectDir,
    projectInstructions: cachedProjectInstructions,
  });
}

// =============================================================================
// Single Session Runner
// =============================================================================

/**
 * Run a single agent session and return the result.
 * Used as the runSession callback for BuildOrchestrator and QALoop.
 */
async function runSingleSession(
  agentType: AgentType,
  phase: Phase,
  systemPrompt: string,
  specDir: string,
  projectDir: string,
  sessionNumber: number,
  subtaskId: string | undefined,
  baseSession: SerializableSessionConfig,
  toolContext: ToolContext,
  registry: ToolRegistry,
  initialUserMessage?: string,
  skipPhaseLogging = false,
  outputSchema?: import('zod').ZodSchema,
): Promise<SessionResult> {
  // Use queue-resolved model ID from baseSession (already mapped to the correct
  // provider-specific model, e.g., 'gpt-5.3-codex' for OpenAI Codex).
  // getPhaseModel() only knows local shorthands (opus → claude-opus-4-6) and
  // would create a mismatch when the provider queue selected a non-Anthropic account.
  // zeenha fork: a task's per-phase model now applies; see resolveSessionModelId.
  const phaseModelId = await resolveSessionModelId(
    { modelId: baseSession.modelId, provider: baseSession.provider },
    specDir,
    phase,
  );
  const phaseThinking = await getPhaseThinking(specDir, phase);

  const metrics = new SessionMetricsCollector();
  const startedAt = new Date();
  const recordMetrics = (result: SessionResult | null): void => {
    appendRunMetrics(
      [specDir, baseSession.sourceSpecDir],
      buildSessionEntry({
        agentType,
        phase,
        subtaskId,
        sessionNumber,
        model: phaseModelId,
        thinkingLevel: phaseThinking,
        startedAt,
        result,
        collector: metrics,
      }),
    );
  };

  // zeenha fork: token budget gate. Re-read the spent baseline for this session;
  // when it is already used up, skip the model call entirely (no provider, no
  // run_metrics entry) and report a budget stop.
  if (budgetGuard) {
    budgetGuard.beginSession();
    const gated = budgetGateResult(budgetGuard);
    if (gated) {
      tripBudget(budgetGuard);
      if (logWriter && !skipPhaseLogging) {
        logWriter.endPhase(phase, true, budgetPauseMessage(budgetGuard.snapshot()));
      }
      if (logWriter) logWriter.setSubtask(undefined);
      return gated;
    }
  }

  const model = createProvider({
    config: {
      provider: baseSession.provider as SupportedProvider,
      apiKey: baseSession.apiKey,
      baseURL: baseSession.baseURL,
      oauthTokenFilePath: baseSession.oauthTokenFilePath,
      claudeConfigDir: baseSession.configDir,
    },
    modelId: phaseModelId,
  });

  const tools: Record<string, AITool> = {
    ...registry.getToolsForAgent(agentType, toolContext),
    ...(await mcpToolsFor(agentType)),
    ...memoryTools(),
  };

  // Build initial messages: use provided kickoff message, or fall back to session messages
  const initialMessages = initialUserMessage
    ? [{ role: 'user' as const, content: initialUserMessage }]
    : baseSession.initialMessages;

  // Resolve context window limit from model metadata
  const contextWindowLimit = getModelContextWindow(phaseModelId);

  const sessionConfig: SessionConfig = {
    agentType,
    model,
    systemPrompt,
    initialMessages,
    toolContext,
    maxSteps: baseSession.maxSteps,
    thinkingLevel: phaseThinking as SessionConfig['thinkingLevel'],
    abortSignal: abortController.signal,
    specDir,
    projectDir,
    phase,
    modelShorthand: undefined,
    sessionNumber,
    subtaskId,
    contextWindowLimit,
    outputSchema,
    tokenBudget: budgetGuard ?? undefined,
  };

  // Start phase logging for this session (skip when orchestrator manages phases)
  if (logWriter && !skipPhaseLogging) {
    logWriter.startPhase(phase);
  }
  if (logWriter && subtaskId) {
    logWriter.setSubtask(subtaskId);
  }

  const runnerOptions = {
    tools,
    ...memoryContext(),
    onEvent: (event: StreamEvent) => {
      metrics.observe(event);
      // Write stream events to task_logs.json for UI log display
      if (logWriter) {
        logWriter.processEvent(event, phase);
      }
      // Also relay to main thread for real-time progress updates
      postMessage({
        type: 'stream-event',
        taskId: config.taskId,
        data: event,
        projectId: config.projectId,
      });
    },
    onAuthRefresh: baseSession.configDir
      ? () => refreshOAuthTokenReactive(baseSession.configDir as string)
      : undefined,
    onModelRefresh: baseSession.configDir
      ? (newToken: string) => createProvider({
          config: {
            provider: baseSession.provider as SupportedProvider,
            apiKey: newToken,
            baseURL: baseSession.baseURL,
            claudeConfigDir: baseSession.configDir,
          },
          modelId: phaseModelId,
        })
      : undefined,
  };

  let sessionResult: SessionResult;
  try {
    sessionResult = await runContinuableSession(sessionConfig, runnerOptions, {
      contextWindowLimit,
      apiKey: baseSession.apiKey,
      baseURL: baseSession.baseURL,
      oauthTokenFilePath: baseSession.oauthTokenFilePath,
      claudeConfigDir: baseSession.configDir,
    });
  } catch (error) {
    recordMetrics(null);
    // Ensure log cleanup happens on failure
    if (logWriter && !skipPhaseLogging) {
      logWriter.endPhase(phase, false, phaseEndMessage(phase, false, error instanceof Error ? error.message : String(error)));
    }
    if (logWriter) logWriter.setSubtask(undefined);
    throw error;
  }

  recordMetrics(sessionResult);

  // zeenha fork: the session stopped on the budget. Trip after recording metrics
  // so the tokens it used are in run_metrics.json when the task resumes.
  if (budgetGuard && sessionResult.error?.code === TOKEN_BUDGET_ERROR_CODE) {
    tripBudget(budgetGuard);
  }

  // End phase logging — mark as completed or failed based on outcome (skip when orchestrator manages phases)
  if (logWriter && !skipPhaseLogging) {
    const success = budgetTrip !== null || sessionResult.outcome === 'completed' || sessionResult.outcome === 'max_steps' || sessionResult.outcome === 'context_window';
    logWriter.endPhase(phase, success, phaseEndMessage(phase, success, sessionResult.error?.message));
  }
  if (logWriter) {
    logWriter.setSubtask(undefined);
  }

  return sessionResult;
}

// =============================================================================
// Session Execution
// =============================================================================

async function run(): Promise<void> {
  const { session } = config;

  postLog(`Starting agent session: type=${session.agentType}, model=${session.modelId}`);

  try {
    // zeenha fork: spec creation is not budgeted; every other worker type is.
    if (session.agentType !== 'spec_orchestrator') {
      budgetGuard = createBudgetGuard(session);
    }
    const securityProfile = buildSecurityProfile(session);
    const toolContext = buildToolContext(session, securityProfile);
    const registry = buildToolRegistry();

    // Initialize the entry agent's MCP clients from session config; phases
    // connect their own on first use (mcpToolsFor).
    try {
      await mcpToolsFor(session.agentType);
    } catch (error) {
      postLog(`MCP init failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
    }

    // Route to orchestrator for build_orchestrator agent type
    if (session.agentType === 'build_orchestrator') {
      await runBuildOrchestrator(session, toolContext, registry);
      return;
    }

    // Route to QA loop for qa_reviewer agent type
    if (session.agentType === 'qa_reviewer') {
      await runQALoop(session, toolContext, registry);
      return;
    }

    // Route to spec orchestrator for spec_orchestrator agent type
    if (session.agentType === 'spec_orchestrator') {
      if (session.useAgenticOrchestration) {
        await runAgenticSpecOrchestrator(session, toolContext, registry);
      } else {
        await runSpecOrchestrator(session, toolContext, registry);
      }
      return;
    }

    // Default: single session for all other agent types
    await runDefaultSession(session, toolContext, registry);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    postError(`Agent session failed: ${message}`);
  } finally {
    // Cleanup MCP clients
    if (mcpClients.length > 0) {
      await closeAllMcpClients(mcpClients);
    }
  }
}

/**
 * Run a single agent session (default path for spec_orchestrator, etc.)
 */
async function runDefaultSession(
  session: SerializableSessionConfig,
  toolContext: ToolContext,
  registry: ToolRegistry,
): Promise<void> {
  const model = createProvider({
    config: {
      provider: session.provider as SupportedProvider,
      apiKey: session.apiKey,
      baseURL: session.baseURL,
      oauthTokenFilePath: session.oauthTokenFilePath,
      claudeConfigDir: session.configDir,
    },
    modelId: session.modelId,
  });

  const tools: Record<string, AITool> = {
    ...registry.getToolsForAgent(session.agentType, toolContext),
    ...(await mcpToolsFor(session.agentType)),
    ...memoryTools(),
  };

  // Resolve context window limit from model metadata
  const contextWindowLimit = getModelContextWindow(session.modelId);

  const sessionConfig: SessionConfig = {
    agentType: session.agentType,
    model,
    systemPrompt: session.systemPrompt,
    initialMessages: session.initialMessages,
    toolContext,
    maxSteps: session.maxSteps,
    thinkingLevel: session.thinkingLevel,
    abortSignal: abortController.signal,
    specDir: session.specDir,
    projectDir: session.projectDir,
    phase: session.phase,
    modelShorthand: session.modelShorthand,
    sessionNumber: session.sessionNumber,
    subtaskId: session.subtaskId,
    contextWindowLimit,
  };

  // Start phase logging for default session
  const defaultPhase: Phase = session.phase ?? 'coding';
  if (logWriter) {
    logWriter.startPhase(defaultPhase);
  }

  let result: SessionResult | undefined;
  try {
    result = await runContinuableSession(sessionConfig, {
      tools,
      ...memoryContext(),
      onEvent: (event: StreamEvent) => {
        // Write stream events to task_logs.json for UI log display
        if (logWriter) {
          logWriter.processEvent(event, defaultPhase);
        }
        postMessage({
          type: 'stream-event',
          taskId: config.taskId,
          data: event,
          projectId: config.projectId,
        });
      },
      onAuthRefresh: session.configDir
        ? () => refreshOAuthTokenReactive(session.configDir as string)
        : undefined,
      onModelRefresh: session.configDir
        ? (newToken: string) => createProvider({
            config: {
              provider: session.provider as SupportedProvider,
              apiKey: newToken,
              baseURL: session.baseURL,
              claudeConfigDir: session.configDir,
            },
            modelId: session.modelId,
          })
        : undefined,
    }, {
      contextWindowLimit,
      apiKey: session.apiKey,
      baseURL: session.baseURL,
      oauthTokenFilePath: session.oauthTokenFilePath,
      claudeConfigDir: session.configDir,
    });
  } finally {
    if (logWriter) {
      const success = result?.outcome === 'completed' || result?.outcome === 'max_steps' || result?.outcome === 'context_window';
      logWriter.endPhase(defaultPhase, success ?? false, phaseEndMessage(defaultPhase, success ?? false, result?.error?.message));
    }
  }

  postMessage({
    type: 'result',
    taskId: config.taskId,
    data: result as SessionResult,
    projectId: config.projectId,
  });
}

/** Map ExecutionPhase to Phase for log writer. Returns undefined for non-loggable phases. */
function mapExecutionPhaseToPhase(executionPhase: ExecutionPhase): Phase | undefined {
  switch (executionPhase) {
    case 'planning': return 'planning';
    case 'coding': return 'coding';
    case 'qa_review': return 'qa';
    case 'qa_fixing': return 'qa';
    default: return undefined; // idle, complete, failed, pause states
  }
}

/**
 * Run the full build orchestration pipeline:
 * planning → coding (per subtask) → QA review → QA fixing
 */
async function runBuildOrchestrator(
  session: SerializableSessionConfig,
  toolContext: ToolContext,
  registry: ToolRegistry,
): Promise<void> {
  postLog('Starting BuildOrchestrator pipeline (planning → coding → QA)');

  const orchestrator = new BuildOrchestrator({
    specDir: session.specDir,
    projectDir: session.projectDir,
    sourceSpecDir: session.sourceSpecDir,
    abortSignal: abortController.signal,

    generatePrompt: async (agentType, _phase, context) => {
      const promptName = agentType === 'coder' ? 'coder' : agentType;
      let prompt = await assemblePrompt(promptName, session);

      // Inject schema validation error feedback on retry so the planner knows what to fix
      if (context.planningRetryContext) {
        prompt += `\n\n${context.planningRetryContext}`;
      }

      // zeenha fork: last, so the stable prompt above stays one cacheable prefix.
      if (agentType === 'coder' && context.subtask) {
        prompt += `\n\n${await buildSubtaskBrief({
          specDir: session.specDir,
          projectDir: session.projectDir,
          subtask: context.subtask,
          attemptCount: context.attemptCount,
        })}`;
      }

      return prompt;
    },

    runSession: async (runConfig) => {
      postLog(`Running ${runConfig.agentType} session (phase=${runConfig.phase}, session=${runConfig.sessionNumber})`);
      // Build a kickoff message for the agent so it has a task to act on
      const kickoffMessage = buildKickoffMessage(runConfig.agentType, runConfig.specDir, runConfig.projectDir);
      return runSingleSession(
        runConfig.agentType,
        runConfig.phase,
        runConfig.systemPrompt,
        runConfig.specDir,
        runConfig.projectDir,
        runConfig.sessionNumber,
        runConfig.subtaskId,
        session,
        toolContext,
        registry,
        kickoffMessage,
        true, // skipPhaseLogging — orchestrator manages phase start/end
        runConfig.outputSchema,
      );
    },
  });

  orchestrator.on('phase-change', (phase: ExecutionPhase, message: string) => {
    postLog(`Phase: ${phase} — ${message}`);
    // Start the phase in the log writer at orchestrator level (not per-session)
    const logPhase = mapExecutionPhaseToPhase(phase);
    if (logWriter && logPhase) {
      logWriter.startPhase(logPhase, message);
    }
    // Emit XState-compatible task events for phase transitions
    // so the state machine tracks the build lifecycle correctly.
    if (phase === 'coding') {
      postTaskEvent('CODING_STARTED', { subtaskId: '', subtaskDescription: 'Starting coding phase' });
    } else if (phase === 'qa_review') {
      postTaskEvent('QA_STARTED', { iteration: 0, maxIterations: 3 });
    } else if (phase === 'qa_fixing') {
      postTaskEvent('QA_FIXING_STARTED', { iteration: 0 });
    }
    // Emit execution-progress so the main thread can:
    // 1. Re-point the file watcher to the worktree spec dir
    // 2. Update the UI with phase progress
    postMessage({
      type: 'execution-progress',
      taskId: config.taskId,
      data: {
        phase,
        phaseProgress: 0,
        overallProgress: 0,
        message,
      },
      projectId: config.projectId,
    });
  });

  orchestrator.on('iteration-start', (iteration: number, phase: ExecutionPhase) => {
    postMessage({
      type: 'execution-progress',
      taskId: config.taskId,
      data: {
        phase,
        phaseProgress: 0,
        overallProgress: 0,
        message: `Iteration ${iteration} (${phase})`,
      },
      projectId: config.projectId,
    });
  });

  orchestrator.on('session-complete', (_result: SessionResult, phase: string) => {
    // Notify the main process that a session (subtask) completed.
    // This triggers persistPlanPhaseSync → invalidateTasksCache so the frontend
    // sees updated subtask statuses in the implementation plan.
    postMessage({
      type: 'execution-progress',
      taskId: config.taskId,
      data: {
        phase: phase as ExecutionPhase,
        phaseProgress: 0,
        overallProgress: 0,
        message: `Session complete (${phase})`,
      },
      projectId: config.projectId,
    });
  });

  orchestrator.on('log', (message: string) => {
    postLog(message);
  });

  orchestrator.on('error', (error: Error, phase: string) => {
    postLog(`Error in ${phase} phase: ${error.message}`);
  });

  const outcome = await orchestrator.run();
  const paused = budgetTrip;

  // End the final phase and flush any remaining accumulated log entries.
  // When the orchestrator reaches 'complete' or 'failed', finalPhase is a terminal
  // state that doesn't map to a log phase. In that case, close whichever log phase
  // is still marked 'active' so the UI shows "Complete" instead of "Running".
  if (logWriter) {
    // zeenha fork: a budget pause ends the phase as stopped, not failed.
    const phaseOk = outcome.success || paused !== null;
    const endMessage = (phase: string) => paused ? budgetPauseMessage(paused) : phaseEndMessage(phase, outcome.success, outcome.error);
    const finalLogPhase = mapExecutionPhaseToPhase(outcome.finalPhase);
    if (finalLogPhase) {
      logWriter.endPhase(finalLogPhase, phaseOk, endMessage(finalLogPhase));
    } else {
      // Terminal state (complete/failed) — close any still-active log phase
      const data = logWriter.getData();
      for (const phase of ['validation', 'coding', 'planning'] as const) {
        if (data.phases[phase]?.status === 'active') {
          const mapped = phase === 'validation' ? 'qa' : phase;
          logWriter.endPhase(mapped as 'qa' | 'coding' | 'planning', phaseOk, endMessage(phase));
          break;
        }
      }
    }
    logWriter.flush();
  }

  // Emit task events based on orchestration outcome so XState machine
  // can transition to the correct state (e.g., human_review on success,
  // error via PLANNING_FAILED / CODING_FAILED / QA_MAX_ITERATIONS on failure).
  for (const event of paused ? budgetPauseTaskEvents(paused) : buildOutcomeTaskEvents(outcome)) {
    postTaskEvent(event.type, event.extra);
  }

  // Map outcome to a SessionResult-compatible result for the bridge
  const result: SessionResult = paused ? budgetPauseResult(paused, outcome.totalIterations, outcome.durationMs) : {
    outcome: outcome.success ? 'completed' : 'error',
    stepsExecuted: outcome.totalIterations,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    messages: [],
    toolCallCount: 0,
    durationMs: outcome.durationMs,
    error: outcome.error
      ? { code: 'error', message: outcome.error, retryable: false }
      : undefined,
  };

  postMessage({
    type: 'result',
    taskId: config.taskId,
    data: result,
    projectId: config.projectId,
  });
}

/**
 * Run the QA validation loop: qa_reviewer → qa_fixer → re-review
 */
async function runQALoop(
  session: SerializableSessionConfig,
  toolContext: ToolContext,
  registry: ToolRegistry,
): Promise<void> {
  postLog('Starting QA validation loop');

  const qaLoop = new QALoop({
    specDir: session.specDir,
    projectDir: session.projectDir,
    abortSignal: abortController.signal,

    generatePrompt: async (agentType, _context) => {
      const promptName = agentType === 'qa_fixer' ? 'qa_fixer' : 'qa_reviewer';
      return assemblePrompt(promptName, session);
    },

    runSession: async (runConfig) => {
      postLog(`Running ${runConfig.agentType} session (session=${runConfig.sessionNumber})`);
      const kickoffMessage = buildKickoffMessage(runConfig.agentType, runConfig.specDir, runConfig.projectDir);
      return runSingleSession(
        runConfig.agentType,
        runConfig.phase,
        runConfig.systemPrompt,
        runConfig.specDir,
        runConfig.projectDir,
        runConfig.sessionNumber,
        undefined,
        session,
        toolContext,
        registry,
        kickoffMessage,
        true, // skipPhaseLogging — QA loop manages phase start/end
      );
    },
  });

  qaLoop.on('log', (message: string) => {
    postLog(message);
  });

  // Start QA validation phase logging at the loop level
  if (logWriter) {
    logWriter.startPhase('qa');
  }

  const outcome = await qaLoop.run();
  const paused = budgetTrip;

  // End QA validation phase and flush any remaining accumulated log entries
  if (logWriter) {
    logWriter.endPhase(
      'qa',
      outcome.approved || paused !== null,
      paused ? budgetPauseMessage(paused) : phaseEndMessage('qa', outcome.approved, outcome.error ?? outcome.reason),
    );
    logWriter.flush();
  }

  // Emit task events so XState machine transitions correctly.
  if (paused) {
    for (const event of budgetPauseTaskEvents(paused)) postTaskEvent(event.type, event.extra);
  } else if (outcome.approved) {
    postTaskEvent('QA_PASSED');
  } else if (outcome.reason === 'max_iterations') {
    postTaskEvent('QA_MAX_ITERATIONS');
  } else {
    postTaskEvent('QA_AGENT_ERROR', { error: outcome.error });
  }

  const result: SessionResult = paused ? budgetPauseResult(paused, outcome.totalIterations, outcome.durationMs) : {
    outcome: outcome.approved ? 'completed' : 'error',
    stepsExecuted: outcome.totalIterations,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    messages: [],
    toolCallCount: 0,
    durationMs: outcome.durationMs,
    error: outcome.error
      ? { code: 'error', message: outcome.error, retryable: false }
      : undefined,
  };

  postMessage({
    type: 'result',
    taskId: config.taskId,
    data: result,
    projectId: config.projectId,
  });
}

/**
 * Run the spec creation orchestration pipeline with complexity-based phase routing.
 */
async function runSpecOrchestrator(
  session: SerializableSessionConfig,
  toolContext: ToolContext,
  registry: ToolRegistry,
): Promise<void> {
  // Extract the task description from the first user message
  const taskDescription = session.initialMessages?.[0]?.content
    ? typeof session.initialMessages[0].content === 'string'
      ? session.initialMessages[0].content
      : 'Create the specification as described in your system prompt.'
    : 'Create the specification as described in your system prompt.';

  postLog(`Starting SpecOrchestrator pipeline (complexity-first phase routing)`);

  // Generate project index BEFORE any agent runs — gives all phases project context
  let projectIndexContent: string | undefined;
  try {
    const indexOutputPath = join(session.specDir, 'project_index.json');
    postLog('Generating project index...');
    runProjectIndexer(session.projectDir, indexOutputPath);
    projectIndexContent = readFileSync(indexOutputPath, 'utf-8');
    postLog(`Project index generated (${(projectIndexContent.length / 1024).toFixed(1)}KB)`);
  } catch (error) {
    postLog(`Project index generation failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
  }

  const orchestrator = new SpecOrchestrator({
    specDir: session.specDir,
    projectDir: session.projectDir,
    taskDescription,
    projectIndex: projectIndexContent,
    abortSignal: abortController.signal,

    generatePrompt: async (_agentType, phase, context) => {
      const promptName = specPhaseToPromptName(phase);
      let prompt = await assemblePrompt(promptName, session);

      // Inject schema validation error feedback on retry so the agent knows what to fix
      if (context.schemaRetryContext) {
        prompt += `\n\n${context.schemaRetryContext}`;
      }

      return prompt;
    },

    runSession: async (runConfig) => {
      postLog(`Running ${runConfig.agentType} session (spec phase=${runConfig.specPhase ?? runConfig.phase}, session=${runConfig.sessionNumber})`);
      const kickoffMessage = buildSpecKickoffMessage(
        runConfig.agentType,
        runConfig.specDir,
        runConfig.projectDir,
        taskDescription,
        runConfig.priorPhaseOutputs,
        runConfig.projectIndex,
        runConfig.specPhase,
      );
      // Spec agents can only write to the spec directory
      const specToolContext: ToolContext = {
        ...toolContext,
        allowedWritePaths: [session.specDir],
      };
      return runSingleSession(
        runConfig.agentType,
        runConfig.phase,
        runConfig.systemPrompt,
        runConfig.specDir,
        runConfig.projectDir,
        runConfig.sessionNumber,
        undefined,
        session,
        specToolContext,
        registry,
        kickoffMessage,
        true, // skipPhaseLogging — orchestrator manages phase start/end
        runConfig.outputSchema,
      );
    },
  });

  // Wire event listeners
  orchestrator.on('phase-start', (phase: SpecPhase, phaseNumber: number, totalPhases: number) => {
    postLog(`Spec phase ${phaseNumber}/${totalPhases}: ${phase}`);
    if (logWriter) {
      logWriter.startPhase('spec', `${phase} (${phaseNumber}/${totalPhases})`);
    }
    postMessage({
      type: 'execution-progress',
      taskId: config.taskId,
      data: {
        phase: 'planning', // spec creation maps to 'planning' in the UI execution phases
        phaseProgress: phaseNumber / Math.max(totalPhases, 1),
        overallProgress: phaseNumber / Math.max(totalPhases, 1),
        message: `Spec creation: ${phase} (${phaseNumber}/${totalPhases})`,
      },
      projectId: config.projectId,
    });
  });

  orchestrator.on('phase-complete', (_phase: SpecPhase, _result: unknown) => {
    // End the current spec log phase so the next one can start fresh
    if (logWriter) {
      logWriter.endPhase('spec', true);
    }
  });

  orchestrator.on('log', (message: string) => {
    postLog(message);
  });

  orchestrator.on('error', (error: Error, phase: SpecPhase) => {
    postLog(`Error in spec ${phase} phase: ${error.message}`);
  });

  const outcome = await orchestrator.run();

  // Emit task event on failure so XState gets a specific signal
  // instead of relying on the generic PROCESS_EXITED fallback.
  if (!outcome.success) {
    postTaskEvent('PLANNING_FAILED', { error: outcome.error });
  }

  // Ensure any still-active log phase is closed and flushed
  if (logWriter) {
    const data = logWriter.getData();
    // toLogPhase('spec') maps to 'planning' in the log writer
    if (data.phases.planning?.status === 'active') {
      logWriter.endPhase('spec', outcome.success, phaseEndMessage('spec', outcome.success, outcome.error));
    }
    logWriter.flush();
  }

  // Map outcome to SessionResult for the worker bridge
  const result: SessionResult = {
    outcome: outcome.success ? 'completed' : 'error',
    stepsExecuted: outcome.phasesExecuted.length,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    messages: [],
    toolCallCount: 0,
    durationMs: outcome.durationMs,
    error: outcome.error
      ? { code: 'error', message: outcome.error, retryable: false }
      : undefined,
  };

  postMessage({
    type: 'result',
    taskId: config.taskId,
    data: result,
    projectId: config.projectId,
  });
}

/**
 * Run the spec creation pipeline using agentic orchestration.
 * Instead of procedural phase routing, an AI orchestrator agent drives the
 * entire pipeline using tools (including SpawnSubagent for specialist work).
 */
async function runAgenticSpecOrchestrator(
  session: SerializableSessionConfig,
  toolContext: ToolContext,
  registry: ToolRegistry,
): Promise<void> {
  // Extract task description
  const taskDescription = session.initialMessages?.[0]?.content
    ? typeof session.initialMessages[0].content === 'string'
      ? session.initialMessages[0].content
      : 'Create the specification as described in your system prompt.'
    : 'Create the specification as described in your system prompt.';

  postLog('Starting Agentic SpecOrchestrator (AI-driven pipeline via SpawnSubagent)');

  // Generate project index
  let projectIndexContent: string | undefined;
  try {
    const indexOutputPath = join(session.specDir, 'project_index.json');
    postLog('Generating project index...');
    runProjectIndexer(session.projectDir, indexOutputPath);
    projectIndexContent = readFileSync(indexOutputPath, 'utf-8');
    postLog(`Project index generated (${(projectIndexContent.length / 1024).toFixed(1)}KB)`);
  } catch (error) {
    postLog(`Project index generation failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
  }

  // Create the SubagentExecutor
  const model = createProvider({
    config: {
      provider: session.provider as SupportedProvider,
      apiKey: session.apiKey,
      baseURL: session.baseURL,
      oauthTokenFilePath: session.oauthTokenFilePath,
      claudeConfigDir: session.configDir,
    },
    modelId: session.modelId,
  });

  const executor = new SubagentExecutorImpl({
    model,
    registry,
    baseToolContext: {
      ...toolContext,
      allowedWritePaths: [session.specDir],
    },
    loadPrompt: async (promptName: string) => assemblePrompt(promptName, session),
    abortSignal: abortController.signal,
    onSubagentEvent: (agentType: string, event: string) => {
      postLog(`Subagent ${agentType}: ${event}`);
    },
  });

  // Create an extended tool context with the executor
  const orchestratorToolContext: ToolContext & { subagentExecutor: SubagentExecutorImpl } = {
    ...toolContext,
    allowedWritePaths: [session.specDir],
    subagentExecutor: executor,
  };

  // Load the agentic orchestrator prompt
  const systemPrompt = await assemblePrompt('spec_orchestrator_agentic', session);

  // Build the kickoff message
  const kickoffParts = [
    `Create a complete specification for the following task:\n\n${taskDescription}\n`,
    `\nSpec directory: ${session.specDir}`,
    `\nProject directory: ${session.projectDir}`,
  ];

  if (projectIndexContent) {
    kickoffParts.push(`\n\n## PROJECT INDEX\n\n\`\`\`json\n${projectIndexContent}\n\`\`\``);
  }

  const kickoffMessage = kickoffParts.join('');

  // Resolve context window and tools
  const contextWindowLimit = getModelContextWindow(session.modelId);
  const phaseThinking = await getPhaseThinking(session.specDir, 'spec');

  // Get tools for the orchestrator (includes SpawnSubagent since it's in AGENT_CONFIGS)
  const tools: Record<string, AITool> = {
    ...registry.getToolsForAgent('spec_orchestrator', orchestratorToolContext),
    ...(await mcpToolsFor('spec_orchestrator')),
    ...memoryTools(),
  };

  const sessionConfig: SessionConfig = {
    agentType: 'spec_orchestrator',
    model,
    systemPrompt,
    initialMessages: [{ role: 'user' as const, content: kickoffMessage }],
    toolContext: orchestratorToolContext,
    maxSteps: session.maxSteps,
    thinkingLevel: phaseThinking as SessionConfig['thinkingLevel'],
    abortSignal: abortController.signal,
    specDir: session.specDir,
    projectDir: session.projectDir,
    phase: 'spec',
    sessionNumber: 1,
    contextWindowLimit,
  };

  // Start phase logging
  if (logWriter) {
    logWriter.startPhase('spec', 'Agentic spec orchestration');
  }

  let result: SessionResult | undefined;
  try {
    result = await runContinuableSession(sessionConfig, {
      tools,
      ...memoryContext(),
      onEvent: (event: StreamEvent) => {
        if (logWriter) {
          logWriter.processEvent(event, 'spec');
        }
        postMessage({
          type: 'stream-event',
          taskId: config.taskId,
          data: event,
          projectId: config.projectId,
        });
      },
      onAuthRefresh: session.configDir
        ? () => refreshOAuthTokenReactive(session.configDir as string)
        : undefined,
      onModelRefresh: session.configDir
        ? (newToken: string) => createProvider({
            config: {
              provider: session.provider as SupportedProvider,
              apiKey: newToken,
              baseURL: session.baseURL,
              claudeConfigDir: session.configDir,
            },
            modelId: session.modelId,
          })
        : undefined,
    }, {
      contextWindowLimit,
      apiKey: session.apiKey,
      baseURL: session.baseURL,
      oauthTokenFilePath: session.oauthTokenFilePath,
      claudeConfigDir: session.configDir,
    });
  } finally {
    if (logWriter) {
      const success = result?.outcome === 'completed' || result?.outcome === 'max_steps' || result?.outcome === 'context_window';
      logWriter.endPhase('spec', success ?? false, phaseEndMessage('spec', success ?? false, result?.error?.message));
      logWriter.flush();
    }
  }

  postMessage({
    type: 'result',
    taskId: config.taskId,
    data: result as SessionResult,
    projectId: config.projectId,
  });
}

/**
 * Map a SpecPhase to the prompt file name to load.
 * Falls back to the closest available prompt when a phase-specific one doesn't exist.
 */
function specPhaseToPromptName(phase: SpecPhase): string {
  switch (phase) {
    case 'discovery': return 'spec_gatherer';
    case 'requirements': return 'spec_gatherer';
    case 'complexity_assessment': return 'complexity_assessor';
    case 'research': return 'spec_researcher';
    case 'context': return 'spec_writer';
    case 'historical_context': return 'spec_writer';
    case 'spec_writing': return 'spec_writer';
    case 'self_critique': return 'spec_critic';
    case 'planning': return 'planner';
    case 'quick_spec': return 'spec_quick';
    case 'validation': return 'spec_writer';
    default: return 'spec_writer';
  }
}

/**
 * Build a kickoff user message for a spec phase session.
 * Includes accumulated context from prior phases to eliminate redundant file reads.
 */
function buildSpecKickoffMessage(
  agentType: AgentType,
  specDir: string,
  projectDir: string,
  taskDescription: string,
  priorPhaseOutputs?: Record<string, string>,
  projectIndex?: string,
  specPhase?: string,
): string {
  // Build the base task-specific message
  let baseMessage: string;

  // Spec phase takes priority over agentType for kickoff routing
  // (e.g., complexity_assessment uses spec_gatherer agentType but needs a different kickoff)
  if (specPhase === 'complexity_assessment') {
    baseMessage = `Assess the complexity of the following task and write your assessment to ${specDir}/complexity_assessment.json. Task: ${taskDescription}. Project root: ${projectDir}. Determine if this is a SIMPLE, STANDARD, or COMPLEX task based on the scope of changes required.\n\nIMPORTANT: This is the FIRST phase of the spec pipeline. No spec.md or other spec files exist yet — do NOT attempt to read them. Assess complexity based on the task description and the project structure at ${projectDir} only.`;
  } else switch (agentType) {
    case 'spec_discovery':
      baseMessage = `Analyze the project structure at ${projectDir} to understand the codebase architecture, tech stack, and conventions. Write your findings to ${specDir}/context.json. Task context: ${taskDescription}\n\nIMPORTANT: This is an early phase of the spec pipeline. No spec.md exists yet — do NOT attempt to read it. Analyze the project source code at ${projectDir} directly.`;
      break;
    case 'spec_gatherer':
      baseMessage = `Gather and validate requirements for the following task: ${taskDescription}. Project root: ${projectDir}. Write requirements to ${specDir}/requirements.json.\n\nIMPORTANT: This is an early phase of the spec pipeline. No spec.md exists yet — do NOT attempt to read it. Derive requirements from the task description and the project source code at ${projectDir}.`;
      break;
    case 'spec_researcher':
      baseMessage = `Research implementation approaches for: ${taskDescription}. Review relevant code in ${projectDir} and document your findings in ${specDir}/research.json.`;
      break;
    case 'spec_writer':
      baseMessage = `Write the specification for: ${taskDescription}. Write spec.md to ${specDir}. Project root: ${projectDir}.`;
      break;
    case 'planner':
      baseMessage = `Create a detailed implementation plan for: ${taskDescription}. Read the spec at ${specDir}/spec.md and create ${specDir}/implementation_plan.json with concrete coding subtasks. Project root: ${projectDir}.`;
      break;
    case 'spec_critic':
      baseMessage = `Review and critique the specification at ${specDir}/spec.md for completeness, clarity, and technical feasibility. Write your critique findings back to ${specDir}/spec.md with improvements.`;
      break;
    case 'spec_context':
      baseMessage = `Gather project context relevant to: ${taskDescription}. Analyze the codebase at ${projectDir} and write context to ${specDir}/context.json.\n\nIMPORTANT: This is an early phase of the spec pipeline. No spec.md exists yet — do NOT attempt to read it. Analyze the project source code at ${projectDir} directly.`;
      break;
    case 'spec_validation':
      baseMessage = `Validate that ${specDir}/spec.md and ${specDir}/implementation_plan.json are complete, consistent, and ready for implementation. Fix any issues found.`;
      break;
    default:
      baseMessage = `Complete the spec creation task described in your system prompt. Task: ${taskDescription}. Spec directory: ${specDir}. Project directory: ${projectDir}`;
  }

  // Inject accumulated context from prior phases
  const contextSections: string[] = [baseMessage];

  if (projectIndex) {
    contextSections.push(`\n\n## PROJECT INDEX (pre-generated)\n\nThe following project structure analysis has been pre-generated for you. Use this as your starting point instead of scanning the entire project:\n\n\`\`\`json\n${projectIndex}\n\`\`\``);
  }

  if (priorPhaseOutputs && Object.keys(priorPhaseOutputs).length > 0) {
    contextSections.push('\n\n## CONTEXT FROM PRIOR PHASES\n\nThe following outputs from earlier spec phases are provided to avoid re-reading files:');
    for (const [fileName, content] of Object.entries(priorPhaseOutputs)) {
      const ext = fileName.endsWith('.json') ? 'json' : 'markdown';
      contextSections.push(`\n### ${fileName}\n\n\`\`\`${ext}\n${content}\n\`\`\``);
    }
    contextSections.push('\nUse these outputs as your primary source of context. Only read additional project files if you need specific code patterns not covered above.');
  }

  return contextSections.join('');
}

/**
 * Build a kickoff user message for an agent session.
 * The AI SDK requires at least one user message; this provides a concrete task directive.
 */
function buildKickoffMessage(agentType: AgentType, specDir: string, projectDir: string): string {
  switch (agentType) {
    case 'planner':
      return `Read the spec at ${specDir}/spec.md and create a detailed implementation plan at ${specDir}/implementation_plan.json. Project root: ${projectDir}`;
    case 'coder':
      return `Read ${specDir}/implementation_plan.json and implement the next pending subtask. Project root: ${projectDir}. After completing the subtask, update its status to "completed" in implementation_plan.json.`;
    case 'qa_reviewer':
      return `Review the implementation in ${projectDir} against the specification in ${specDir}/spec.md. Write your findings to ${specDir}/qa_report.md with a clear "Status: PASSED" or "Status: FAILED" line.`;
    case 'qa_fixer':
      return `Read ${specDir}/qa_report.md for the issues found by QA review. Fix all issues in ${projectDir}. After fixing, update ${specDir}/qa_report.md to indicate fixes have been applied.`;
    default:
      return `Complete the task described in your system prompt. Spec directory: ${specDir}. Project directory: ${projectDir}`;
  }
}

/**
 * Build a minimal fallback prompt when the prompts directory is not found.
 */
function buildFallbackPrompt(agentType: AgentType, specDir: string, projectDir: string): string {
  switch (agentType) {
    case 'planner':
      return `You are a planning agent. Read spec.md in ${specDir} and create implementation_plan.json with phases and subtasks. Each subtask must have id, description, and status fields. Set all statuses to "pending".`;
    case 'coder':
      return `You are a coding agent. Implement the current pending subtask from implementation_plan.json in ${specDir}. Project root: ${projectDir}. After completing the subtask, update its status to "completed" in implementation_plan.json.`;
    case 'qa_reviewer':
      return `You are a QA reviewer. Review the implementation in ${projectDir} against the spec in ${specDir}/spec.md. Write your findings to ${specDir}/qa_report.md with "Status: PASSED" or "Status: FAILED".`;
    case 'qa_fixer':
      return `You are a QA fixer. Read ${specDir}/qa_report.md for the issues found by QA review. Fix the issues in ${projectDir}. After fixing, update ${specDir}/implementation_plan.json qa_signoff status to "fixes_applied".`;
    default:
      return `You are an AI agent. Complete the task described in ${specDir}/spec.md for the project at ${projectDir}.`;
  }
}

// Start execution
run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  postError(`Unhandled worker error: ${message}`);
});
