/**
 * zeenha fork: agent memory for headless runs, so a CLI or daemon task keeps
 * and reuses lessons the way a desktop task does.
 *
 * The CLI never reads the desktop app's userData, so it cannot open the app's
 * `userData/memory.db`. Each project gets its own file instead, at
 * `<main checkout>/.auto-claude/memory.db` (a run inside a task worktree uses
 * the main checkout's file). Memories are stored under the same project id
 * format as `serve`: `headless:<real path>`. No hosted embedding provider is
 * configured here: the embedding service uses a local Ollama model when one
 * is running, and its offline fallback otherwise.
 */

import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

import type { Client } from '@libsql/client/sqlite3';

import type { WorkerBridgeCoreOptions } from '../ai/agent/worker-bridge-core';
import { openLocalMemoryClient } from '../ai/memory/db';
import { createMemoryService } from '../ai/memory/create-memory-service';
import type { MainMemoryHandler } from '../ai/memory/ipc/main-memory-handler';
import { startWorkerMemory } from '../ai/memory/ipc/start-worker-memory';
import type { MemoryService } from '../ai/memory/types';
import type { HeadlessConfig } from './config';
import { AUTO_BUILD_PATH, resolveDeliveryReceiptRoot } from './shared';

/** How long the run waits for memory finalization before it returns. */
export const MEMORY_FINALIZE_TIMEOUT_MS = 15_000;

/** On unless the config file sets `memory.enabled` to false (same default as the app). */
export function isHeadlessMemoryEnabled(config: HeadlessConfig): boolean {
  return config.memory?.enabled !== false;
}

/** The checkout whose memory a run uses: the main checkout, also for a task worktree. */
export function resolveHeadlessMemoryProject(projectPath: string): { id: string; path: string; dbPath: string } {
  const root = resolveDeliveryReceiptRoot(projectPath) ?? projectPath;
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    // Keep the unresolved path.
  }
  return { id: `headless:${real}`, path: root, dbPath: path.join(root, AUTO_BUILD_PATH, 'memory.db') };
}

// One service per database file for the life of the process (the daemon runs many tasks).
const services = new Map<string, Promise<MemoryService>>();
const clients = new Map<string, Client>();

function getHeadlessMemoryService(dbPath: string): Promise<MemoryService> {
  let service = services.get(dbPath);
  if (!service) {
    service = (async () => {
      mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = await openLocalMemoryClient(dbPath);
      clients.set(dbPath, db);
      return (await createMemoryService(db, undefined)).service;
    })();
    // A failed open is retried by the next run instead of being cached.
    service.catch(() => services.delete(dbPath));
    services.set(dbPath, service);
  }
  return service;
}

/**
 * zeenha fork: close every cached memory database. Windows refuses to delete a
 * file another handle keeps open, so a caller that removes the project folder
 * in the same process (the tests do) closes the databases first.
 */
export async function closeHeadlessMemoryDatabases(): Promise<void> {
  await Promise.allSettled(services.values());
  for (const client of clients.values()) client.close();
  clients.clear();
  services.clear();
}

export interface HeadlessMemory {
  startMemory: NonNullable<WorkerBridgeCoreOptions['startMemory']>;
  /** Wait (bounded) for the worker's memory handler to store its last memories. */
  settle(): Promise<void>;
}

/**
 * Memory wiring for a headless bridge. Like the desktop's startMemory, it never
 * throws: a memory problem must not stop the agent from running.
 */
export function createHeadlessMemory(options: {
  projectPath: string;
  log: (message: string) => void;
  warn: (message: string) => void;
}): HeadlessMemory {
  let handler: MainMemoryHandler | undefined;
  return {
    startMemory: (config) => {
      try {
        const project = resolveHeadlessMemoryProject(options.projectPath);
        const started = startWorkerMemory(config, {
          project,
          getService: () => getHeadlessMemoryService(project.dbPath),
          log: options.log,
        });
        handler = started.handler;
        return started;
      } catch (error) {
        options.warn(`memory disabled for this run: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    },
    async settle() {
      if (!handler) return;
      // The bridge already started finalize when the worker ended; this returns
      // the same promise. Without the wait the CLI could exit before it stores.
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        handler.finalize('partial').catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, MEMORY_FINALIZE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
    },
  };
}
