/**
 * zeenha fork: builds the capped memory context that is injected into the
 * planner and QA reviewer kickoff message. Reads go through the worker's
 * observer proxy (no direct DB access). Never throws and stays silent when
 * memory is off or slow, so it can never block or break a session.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { buildPrefetchPlan } from '../memory/injection/prefetch-builder';
import { buildPlannerMemoryContext } from '../memory/injection/planner-memory-context';
import { buildQaSessionContext } from '../memory/injection/qa-context';
import { createProxyMemorySource } from '../memory/ipc/proxy-memory-service';
import type { WorkerObserverProxy } from '../memory/ipc/worker-observer-proxy';

/** About 1.5k tokens, so memory cannot crowd out the spec and plan. */
export const MEMORY_CONTEXT_MAX_CHARS = 6000;
/** Equal to the proxy's IPC timeout. */
export const MEMORY_CONTEXT_DEADLINE_MS = 3000;

const END_MARKER = '=== END MEMORY CONTEXT ===';
const TRUNCATED_NOTE = '[truncated]';
const MAX_MODULES = 6;
const MAX_TASK_DESCRIPTION_CHARS = 500;

/** Cut text to at most `max` chars at a line boundary, keeping a closing marker. */
export function capMemoryContext(text: string, max: number = MEMORY_CONTEXT_MAX_CHARS): string {
  if (text.length <= max) return text;
  const tail = `\n${TRUNCATED_NOTE}\n${END_MARKER}`;
  const budget = Math.max(0, max - tail.length);
  const slice = text.slice(0, budget);
  const lastNewline = slice.lastIndexOf('\n');
  const body = lastNewline > 0 ? slice.slice(0, lastNewline) : '';
  return `${body.replace(/\s+$/, '')}${tail}`;
}

function readJson(path: string): unknown {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
}

function collectFilesToModify(node: unknown, out: string[], depth = 0): void {
  if (depth > 8 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectFilesToModify(item, out, depth + 1);
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'files_to_modify' && Array.isArray(value)) {
      for (const v of value) if (typeof v === 'string') out.push(v);
    } else {
      collectFilesToModify(value, out, depth + 1);
    }
  }
}

/** Best effort: module names (first one or two path segments) from the spec's file lists. */
export function deriveRelevantModules(specDir: string): string[] {
  try {
    const files: string[] = [];
    for (const name of ['context.json', 'implementation_plan.json']) {
      collectFilesToModify(readJson(join(specDir, name)), files);
    }
    const modules = new Set<string>();
    for (const file of files) {
      const segments = file.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
      if (segments.length === 0) continue;
      modules.add(segments.slice(0, 2).join('/'));
      if (modules.size >= MAX_MODULES) break;
    }
    return [...modules];
  } catch {
    return [];
  }
}

function deriveTaskDescription(specDir: string): string {
  try {
    const specPath = join(specDir, 'spec.md');
    if (existsSync(specPath)) {
      const line = readFileSync(specPath, 'utf-8')
        .split('\n')
        .map((l) => l.replace(/^#+\s*/, '').trim())
        .find((l) => l.length > 0);
      if (line) return line.slice(0, MAX_TASK_DESCRIPTION_CHARS);
    }
  } catch {
    // fall through to the directory name
  }
  return basename(specDir);
}

function insertBeforeEndMarker(block: string, section: string): string {
  const idx = block.lastIndexOf(END_MARKER);
  if (idx === -1) return `${block}\n\n${section}`;
  return `${block.slice(0, idx)}${section}\n${block.slice(idx)}`;
}

export interface BuildSessionMemoryContextOptions {
  agentType: string;
  proxy: Pick<WorkerObserverProxy, 'searchMemory'> | null | undefined;
  taskDescription?: string;
  projectId: string;
  specDir: string;
  deadlineMs?: number;
  postLog?: (message: string) => void;
}

async function buildUnbounded(opts: BuildSessionMemoryContextOptions): Promise<string | undefined> {
  const { agentType, proxy, projectId, specDir } = opts;
  if (!proxy) return undefined;
  const isPlanner = agentType === 'planner';
  if (!isPlanner && agentType !== 'qa_reviewer') return undefined;

  const source = createProxyMemorySource(proxy);
  const modules = deriveRelevantModules(specDir);
  const description = opts.taskDescription?.trim()
    ? opts.taskDescription.trim().slice(0, MAX_TASK_DESCRIPTION_CHARS)
    : deriveTaskDescription(specDir);

  const [block, plan] = await Promise.all([
    isPlanner
      ? buildPlannerMemoryContext(description, modules, source, projectId)
      : buildQaSessionContext(description, modules, source, projectId),
    buildPrefetchPlan(modules, source, projectId),
  ]);

  const files = [...new Set([...plan.alwaysReadFiles, ...plan.frequentlyReadFiles])];
  let result = block;
  if (files.length > 0) {
    const section = `FILES EARLIER SESSIONS USUALLY READ:\n${files.map((f) => `- ${f}`).join('\n')}`;
    if (result) {
      result = insertBeforeEndMarker(result, section);
    } else {
      const title = isPlanner ? 'PLANNER' : 'QA';
      result = `=== MEMORY CONTEXT FOR ${title} ===\n${section}\n${END_MARKER}`;
    }
  }
  if (!result) return undefined;
  return capMemoryContext(result, MEMORY_CONTEXT_MAX_CHARS);
}

/**
 * Memory context for a planner or QA reviewer session, or undefined when memory
 * is off, slow, empty, or the agent type does not get memory. Never throws.
 */
export async function buildSessionMemoryContext(
  opts: BuildSessionMemoryContextOptions,
): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!opts.proxy) return undefined;
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), opts.deadlineMs ?? MEMORY_CONTEXT_DEADLINE_MS);
    });
    const context = await Promise.race([buildUnbounded(opts), deadline]);
    if (!context) return undefined;
    try {
      opts.postLog?.(`Memory context injected for ${opts.agentType} (${context.length} chars)`);
    } catch {
      // logging must never affect the session
    }
    return context;
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Append the memory context to the kickoff message; unchanged when there is none. */
export function appendMemoryContext(kickoff: string, context: string | undefined): string {
  return context ? `${kickoff}\n\n${context}` : kickoff;
}
