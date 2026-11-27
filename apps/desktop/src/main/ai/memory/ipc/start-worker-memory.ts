/**
 * zeenha fork: create the main-thread memory handler for one agent worker and
 * return the worker's end of its port. Electron-free, so both the desktop
 * WorkerBridge and the headless CLI can use it. The caller decides whether
 * memory is on and which project the worker belongs to.
 */

import { MessageChannel } from 'worker_threads';
import type { MessagePort } from 'worker_threads';

import type { ProcessType } from '../../../agent/types';
import type { AgentExecutorConfig } from '../../agent/types';
import type { MemoryService, SessionType } from '../types';
import { MainMemoryHandler } from './main-memory-handler';

export interface StartWorkerMemoryOptions {
  /** Project the worker belongs to; its id is stored on every memory. */
  project: { id: string; path: string };
  getService: () => Promise<MemoryService>;
  log?: (message: string) => void;
}

export function startWorkerMemory(
  config: AgentExecutorConfig,
  options: StartWorkerMemoryOptions,
): { port: MessagePort; handler: MainMemoryHandler } {
  const projectDir = config.session.projectDir;
  const { port1, port2 } = new MessageChannel();
  const handler = new MainMemoryHandler({
    sessionId: `${config.taskId}:${Date.now()}`,
    sessionType: toMemorySessionType(config.processType),
    projectId: options.project.id,
    roots: [projectDir, options.project.path].filter((r): r is string => !!r),
    getService: options.getService,
    log: options.log,
  });
  handler.attach(port1);
  return { port: port2, handler };
}

function toMemorySessionType(processType: ProcessType): SessionType {
  return processType === 'spec-creation' ? 'spec_creation' : 'build';
}
