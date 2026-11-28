/**
 * Worker Bridge
 * =============
 *
 * Main-thread bridge that spawns a Worker thread and relays `postMessage()`
 * events to an EventEmitter matching the `AgentManagerEvents` interface.
 *
 * This allows the existing agent management system (agent-process.ts,
 * agent-events.ts) to consume worker thread events transparently — the UI
 * cannot distinguish between a Python subprocess and a TS worker thread.
 */

import type { MessagePort } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import { app } from 'electron';

import type { AgentExecutorConfig } from './types';
import type { MainMemoryHandler } from '../memory/ipc/main-memory-handler';
import { startWorkerMemory } from '../memory/ipc/start-worker-memory';
import {
  getMemoryService,
  isAgentMemoryEnabled,
} from '../../ipc-handlers/context/memory-service-factory';
import { projectStore } from '../../project-store';
import { recordApiKeyOutcome } from '../../services/api-key-status-recorder';
import { WorkerBridgeCore, WORKER_EXIT_GRACE_MS } from './worker-bridge-core';

export { WORKER_EXIT_GRACE_MS };

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// Worker Path Resolution
// =============================================================================

/**
 * Resolve the path to the worker entry point.
 * Handles both dev (source via electron-vite) and production (bundled) paths.
 */
function resolveWorkerPath(): string {
  if (app.isPackaged) {
    // Production: worker is inside app.asar at out/main/ai/agent/worker.js
    return path.join(process.resourcesPath, 'app.asar', 'out', 'main', 'ai', 'agent', 'worker.js');
  }
  // Dev: electron-vite outputs worker at out/main/ai/agent/worker.js
  // because the Rollup input key is 'ai/agent/worker'.
  // __dirname resolves to out/main/ at runtime, so we need the subdirectory.
  return path.join(__dirname, 'ai', 'agent', 'worker.js');
}

// =============================================================================
// WorkerBridge
// =============================================================================

/**
 * Electron-bound WorkerBridge: supplies the Electron worker path and the
 * in-process memory wiring to the Electron-free WorkerBridgeCore.
 */
export class WorkerBridge extends WorkerBridgeCore {
  constructor() {
    super({ resolveWorkerPath, startMemory, recordKeyOutcome: recordApiKeyOutcome });
  }
}

// =============================================================================
// Memory (zeenha fork)
// =============================================================================

/**
 * Create the main-thread memory handler and return the worker's end of its
 * port, or null when memory is off or the project cannot be identified.
 * Never throws: a memory problem must not stop the agent from running.
 */
function startMemory(config: AgentExecutorConfig): { port: MessagePort; handler: MainMemoryHandler } | null {
  try {
    if (!isAgentMemoryEnabled()) return null;
    const project = resolveProject(config.projectId, config.session.projectDir);
    if (!project) return null;
    return startWorkerMemory(config, {
      project,
      getService: getMemoryService,
      log: (message) => console.info(`[WorkerBridge:${config.taskId}] ${message}`),
    });
  } catch (error) {
    console.warn('[WorkerBridge] memory disabled for this worker:', error);
    return null;
  }
}

function resolveProject(projectId: string | undefined, projectDir: string): { id: string; path: string } | null {
  const projects = projectStore.getProjects();
  const byId = projectId ? projects.find((p) => p.id === projectId) : undefined;
  if (byId) return byId;
  // Task workers run in a worktree under the project, so match by prefix.
  const dir = projectDir.replace(/\\/g, '/');
  return (
    projects.find((p) => {
      const root = p.path.replace(/\\/g, '/').replace(/\/+$/, '');
      return dir === root || dir.startsWith(`${root}/`);
    }) ?? null
  );
}
