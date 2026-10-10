/**
 * MainMemoryHandler
 *
 * Lives on the MAIN THREAD. It is the other end of WorkerObserverProxy: one
 * instance per agent worker, attached to a dedicated MessagePort (never the
 * worker's parentPort, which carries the agent's own events).
 *
 * zeenha fork: upstream shipped the worker-side proxy, the observer, the
 * promotion pipeline and the record/search tools, but nothing on the main
 * thread answered the proxy, so task agents never wrote a single memory.
 *
 * Responsibilities:
 *   - feed observation messages to a MemoryObserver (synchronous, never awaits)
 *   - answer search / record / step-injection requests from MemoryService
 *   - on finalize(), promote the observer's candidates and store them
 *
 * Trust: the projectId and sessionId on every stored memory come from this
 * handler, never from the worker message. File paths are rewritten relative to
 * the project so a memory written in one task's worktree matches the same file
 * read in another task's worktree.
 */

import type { MessagePort } from 'worker_threads';
import type {
  Memory,
  MemoryCandidate,
  MemoryIpcResponse,
  MemoryRecordEntry,
  MemorySearchFilters,
  MemoryService,
  SessionOutcome,
  SessionType,
} from '../types';
import type { MemoryIpcMessage } from './worker-observer-proxy';
import { MemoryObserver } from '../observer/memory-observer';
import { PromotionPipeline } from '../observer/promotion';
import { StepInjectionDecider } from '../injection/step-injection-decider';

/** At most this many observer-inferred memories are stored per worker. */
export const MAX_INFERRED_PER_SESSION = 5;

const MAX_CONTENT_LENGTH = 2000;

/** Matches the task/terminal worktree prefix inside a project. */
const WORKTREE_PREFIX = /^.*?\/\.auto-claude\/worktrees\/(?:tasks|terminal)\/[^/]+\//;

export interface MainMemoryHandlerOptions {
  sessionId: string;
  sessionType: SessionType;
  /** Aperant project id (the one the Context page lists memories by). */
  projectId: string;
  /** Directories that absolute paths are made relative to (worktree, project). */
  roots: string[];
  getService: () => Promise<MemoryService>;
  log?: (message: string) => void;
}

export interface FinalizeSummary {
  recorded: number;
  inferred: number;
}

/**
 * Rewrite an absolute path under one of the roots (or under any task worktree)
 * to a project-relative path. Anything else is returned unchanged.
 */
export function toProjectRelative(filePath: string, roots: string[]): string {
  if (typeof filePath !== 'string' || filePath === '') return filePath;
  const normalized = filePath.replace(/\\/g, '/');
  const worktreeStripped = normalized.replace(WORKTREE_PREFIX, '');
  if (worktreeStripped !== normalized) return worktreeStripped;
  for (const root of roots) {
    const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (r && normalized.startsWith(`${r}/`)) {
      return normalized.slice(r.length + 1);
    }
  }
  return filePath;
}

export class MainMemoryHandler {
  private readonly observer: MemoryObserver;
  private readonly pipeline = new PromotionPipeline();
  private port: MessagePort | null = null;
  private decider: StepInjectionDecider | null = null;
  private finalizePromise: Promise<FinalizeSummary> | null = null;
  private recorded = 0;

  constructor(private readonly options: MainMemoryHandlerOptions) {
    this.observer = new MemoryObserver(options.sessionId, options.sessionType, options.projectId);
  }

  attach(port: MessagePort): void {
    this.port = port;
    port.on('message', (message: MemoryIpcMessage) => {
      void this.handle(message);
    });
  }

  /** Exposed for tests; production traffic arrives through attach(). */
  async handle(message: MemoryIpcMessage): Promise<void> {
    if (this.finalizePromise) return;
    switch (message.type) {
      case 'memory:tool-call':
        this.observer.observe({ ...message, args: this.relativizeArgs(message.args) });
        return;
      case 'memory:tool-result':
      case 'memory:reasoning':
      case 'memory:step-complete':
        this.observer.observe(message);
        return;
      case 'memory:search':
        await this.reply(message.requestId, async () => ({
          type: 'memory:search-result',
          requestId: message.requestId,
          memories: await this.search(message.filters),
        }));
        return;
      case 'memory:record':
        await this.reply(message.requestId, async () => ({
          type: 'memory:stored',
          requestId: message.requestId,
          id: await this.record(message.entry),
        }));
        return;
      case 'memory:step-injection-request':
        await this.reply(message.requestId, async () => {
          const decider = await this.getDecider();
          const injection = await decider.decide(message.stepNumber, {
            toolCalls: message.recentContext.toolCalls.map((t) => ({
              toolName: t.toolName,
              args: this.relativizeArgs(t.args),
            })),
            injectedMemoryIds: new Set(message.recentContext.injectedMemoryIds),
          });
          // Encoding agreed with WorkerObserverProxy.requestStepInjection:
          // no injection → empty search result; injection → JSON in `id`.
          if (!injection) {
            return { type: 'memory:search-result', requestId: message.requestId, memories: [] };
          }
          return { type: 'memory:stored', requestId: message.requestId, id: JSON.stringify(injection) };
        });
        return;
    }
  }

  /**
   * Promote and store what the observer saw, then close the port.
   * Idempotent: a second call returns the first call's result.
   */
  finalize(outcome: SessionOutcome): Promise<FinalizeSummary> {
    if (!this.finalizePromise) {
      this.finalizePromise = this.doFinalize(outcome).finally(() => this.close());
    }
    return this.finalizePromise;
  }

  private async doFinalize(outcome: SessionOutcome): Promise<FinalizeSummary> {
    let inferred = 0;
    try {
      const raw = await this.observer.finalize(outcome, { cap: false });
      // There is no cross-session signal history yet, so every signal counts as
      // seen in exactly ONE session. Promotion then honours each signal's own
      // minSessions: a co-access or a backtrack seen once is not a memory.
      // Without the map the pipeline passes everything, which stored one
      // "these files are read together" note per pair of files per task.
      const seenOnce = new Map(raw.map((c) => [c.signalType, 1] as const));
      const promoted = await this.pipeline.promote(raw, this.options.sessionType, outcome, undefined, seenOnce);
      const service = await this.options.getService();
      for (const candidate of promoted.slice(0, MAX_INFERRED_PER_SESSION)) {
        if (await this.storeCandidate(service, candidate)) inferred++;
      }
    } catch (error) {
      this.log(`finalize failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (this.recorded > 0 || inferred > 0) {
      this.log(`stored ${this.recorded} recorded and ${inferred} inferred memories`);
    }
    return { recorded: this.recorded, inferred };
  }

  private async storeCandidate(service: MemoryService, candidate: MemoryCandidate): Promise<boolean> {
    const content = candidate.content.slice(0, MAX_CONTENT_LENGTH);
    // Skip exact duplicates: the same co-access or error pattern recurs
    // across sessions and would otherwise pile up one copy per task.
    const existing = await service.search({ query: content, projectId: this.options.projectId, limit: 5 });
    if (existing.some((m) => m.content === content)) return false;

    await service.store({
      type: candidate.proposedType,
      content,
      confidence: clamp01(candidate.confidence),
      relatedFiles: this.relativizeFiles(candidate.relatedFiles),
      relatedModules: candidate.relatedModules,
      source: 'observer_inferred',
      scope: 'module',
      projectId: this.options.projectId,
      sessionId: this.options.sessionId,
      needsReview: true,
      tags: [`signal:${candidate.signalType}`],
    });
    return true;
  }

  private async search(filters: MemorySearchFilters): Promise<Memory[]> {
    const service = await this.options.getService();
    return service.search({
      ...filters,
      relatedFiles: filters.relatedFiles ? this.relativizeFiles(filters.relatedFiles) : undefined,
      projectId: this.options.projectId,
      limit: Math.min(Math.max(filters.limit ?? 5, 1), 20),
    });
  }

  private async record(entry: MemoryRecordEntry): Promise<string> {
    const service = await this.options.getService();
    const id = await service.store({
      type: entry.type,
      content: String(entry.content ?? '').slice(0, MAX_CONTENT_LENGTH),
      confidence: clamp01(entry.confidence ?? 0.8),
      relatedFiles: this.relativizeFiles(entry.relatedFiles ?? []),
      relatedModules: entry.relatedModules ?? [],
      source: 'agent_explicit',
      scope: entry.scope ?? 'module',
      projectId: this.options.projectId,
      sessionId: this.options.sessionId,
      needsReview: false,
    });
    this.recorded++;
    return id;
  }

  private async getDecider(): Promise<StepInjectionDecider> {
    if (!this.decider) {
      const service = await this.options.getService();
      this.decider = new StepInjectionDecider(service, this.observer.getScratchpad(), this.options.projectId);
    }
    return this.decider;
  }

  private async reply(requestId: string, build: () => Promise<MemoryIpcResponse>): Promise<void> {
    let response: MemoryIpcResponse;
    try {
      response = await build();
    } catch (error) {
      response = {
        type: 'memory:error',
        requestId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      this.port?.postMessage(response);
    } catch {
      // Port closed while we were working — the worker has gone.
    }
  }

  private relativizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    if (!args || typeof args.file_path !== 'string') return args;
    return { ...args, file_path: toProjectRelative(args.file_path, this.options.roots) };
  }

  private relativizeFiles(files: string[]): string[] {
    return files.filter((f) => typeof f === 'string').map((f) => toProjectRelative(f, this.options.roots));
  }

  private close(): void {
    try {
      this.port?.close();
    } catch {
      // already closed
    }
    this.port = null;
  }

  private log(message: string): void {
    this.options.log?.(`[memory] ${message}`);
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.8;
  return Math.min(1, Math.max(0, value));
}
