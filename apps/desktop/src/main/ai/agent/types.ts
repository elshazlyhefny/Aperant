/**
 * Agent Worker Types
 * ==================
 *
 * Type definitions for the worker thread communication protocol.
 * These types define the messages exchanged between the main thread
 * (WorkerBridge) and the worker thread (worker.ts).
 */

import type { ExecutionProgressData, ProcessType } from '../../../main/agent/types';
import type { CustomMcpServerDefinition } from '../mcp/types';
import type { SessionConfig, SessionResult, StreamEvent } from '../session/types';
import type { RunnerOptions } from '../session/runner';

// =============================================================================
// Worker Configuration
// =============================================================================

/**
 * Configuration passed to the worker thread via workerData.
 * Must be serializable (no class instances, functions, or LanguageModel).
 */
export interface WorkerConfig {
  /** Task ID for tracking and event correlation */
  taskId: string;
  /** Project ID for multi-project support */
  projectId?: string;
  /** Process type for exit event classification */
  processType: ProcessType;
  /** Serializable session config (model resolved in worker from these params) */
  session: SerializableSessionConfig;
  /**
   * zeenha fork: the worker's end of a dedicated channel to the main-thread
   * memory handler. Transferred, not cloned. Absent when memory is off.
   */
  memoryPort?: import('worker_threads').MessagePort;
}

/**
 * Serializable version of SessionConfig.
 * The LanguageModel instance cannot cross worker boundaries,
 * so we pass provider/model identifiers and reconstruct in the worker.
 */
export interface SerializableSessionConfig {
  agentType: SessionConfig['agentType'];
  systemPrompt: string;
  initialMessages: SessionConfig['initialMessages'];
  maxSteps: number;
  specDir: string;
  projectDir: string;
  /** Source spec dir in main project (for worktree → main sync during execution) */
  sourceSpecDir?: string;
  phase?: SessionConfig['phase'];
  modelShorthand?: SessionConfig['modelShorthand'];
  thinkingLevel?: SessionConfig['thinkingLevel'];
  sessionNumber?: SessionConfig['sessionNumber'];
  subtaskId?: SessionConfig['subtaskId'];
  /** Provider identifier for model reconstruction */
  provider: string;
  /** Model ID for model reconstruction */
  modelId: string;
  /** API key or token for auth */
  apiKey?: string;
  /** Base URL override for the provider */
  baseURL?: string;
  /** Config directory for OAuth profile (used for reactive token refresh on 401) */
  configDir?: string;
  /** Pre-resolved path to OAuth token file for file-based OAuth providers (e.g., Codex). Worker-safe. */
  oauthTokenFilePath?: string;
  /** MCP options resolved from project settings (serialized for worker) */
  mcpOptions?: {
    context7Enabled?: boolean;
    memoryEnabled?: boolean;
    electronMcpEnabled?: boolean;
    /** zeenha fork: the Chrome DevTools browser server (replaces Puppeteer) */
    chromeDevtoolsMcpEnabled?: boolean;
    chromeDevtoolsExecutable?: string;
    chromeDevtoolsWebmcp?: boolean;
    chromeDevtoolsSecureOrigins?: string[];
    projectCapabilities?: {
      is_electron?: boolean;
      is_web_frontend?: boolean;
    };
    agentMcpAdd?: string;
    agentMcpRemove?: string;
    /** zeenha fork: AGENT_MCP_<agent>_ADD/REMOVE from the project, keyed by agent type */
    agentMcpOverrides?: Record<string, { add?: string[]; remove?: string[] }>;
    /** zeenha fork: the project's custom MCP servers (CUSTOM_MCP_SERVERS) */
    customServers?: CustomMcpServerDefinition[];
  };
  /** Enable agentic orchestration mode where the AI drives the pipeline via SpawnSubagent tool */
  useAgenticOrchestration?: boolean;
  /** Tool context serialized fields */
  toolContext: {
    cwd: string;
    projectDir: string;
    specDir: string;
    /**
     * Serialized security profile. SecurityProfile uses Set objects which
     * aren't transferable across worker boundaries, so we serialize to arrays.
     */
    securityProfile?: SerializedSecurityProfile;
  };
}

// =============================================================================
// Worker Messages (worker → main)
// =============================================================================

/** Discriminated union of all messages posted from worker to main thread */
export type WorkerMessage =
  | WorkerLogMessage
  | WorkerErrorMessage
  | WorkerProgressMessage
  | WorkerStreamEventMessage
  | WorkerResultMessage
  | WorkerTaskEventMessage;

export interface WorkerLogMessage {
  type: 'log';
  taskId: string;
  data: string;
  projectId?: string;
}

export interface WorkerErrorMessage {
  type: 'error';
  taskId: string;
  data: string;
  projectId?: string;
}

export interface WorkerProgressMessage {
  type: 'execution-progress';
  taskId: string;
  data: ExecutionProgressData;
  projectId?: string;
}

export interface WorkerStreamEventMessage {
  type: 'stream-event';
  taskId: string;
  data: StreamEvent;
  projectId?: string;
}

export interface WorkerResultMessage {
  type: 'result';
  taskId: string;
  data: SessionResult;
  projectId?: string;
}

export interface WorkerTaskEventMessage {
  type: 'task-event';
  taskId: string;
  data: Record<string, unknown>;
  projectId?: string;
}

// =============================================================================
// Main → Worker Messages
// =============================================================================

/** Messages sent from main thread to worker */
export type MainToWorkerMessage =
  | { type: 'abort' };

// =============================================================================
// Serialized Security Profile
// =============================================================================

/**
 * Serializable version of SecurityProfile (which uses non-transferable Set objects).
 * Reconstructed into a full SecurityProfile in the worker thread.
 */
export interface SerializedSecurityProfile {
  baseCommands: string[];
  stackCommands: string[];
  scriptCommands: string[];
  customCommands: string[];
  customScripts: {
    shellScripts: string[];
  };
  /**
   * zeenha fork: the project's "Land through pull requests only" setting, read
   * in the main process. Absent means ON (the validator fails closed).
   */
  prOnlyLanding?: boolean;
  /** zeenha fork: env var names kept in Bash child environments (project setting). */
  envPassthrough?: string[];
}

// =============================================================================
// Executor Configuration
// =============================================================================

/**
 * Configuration for AgentExecutor.
 */
export interface AgentExecutorConfig {
  /** Task ID for tracking */
  taskId: string;
  /** Project ID for multi-project support */
  projectId?: string;
  /** Process type classification */
  processType: ProcessType;
  /** Session configuration (serializable parts) */
  session: SerializableSessionConfig;
  /** Optional auth refresh callback (runs in main thread) */
  onAuthRefresh?: RunnerOptions['onAuthRefresh'];
}
