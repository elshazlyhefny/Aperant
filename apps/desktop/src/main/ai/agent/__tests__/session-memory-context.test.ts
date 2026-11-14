import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkerObserverProxy } from '../../memory/ipc/worker-observer-proxy';
import {
  MEMORY_CONTEXT_DEADLINE_MS,
  MEMORY_CONTEXT_MAX_CHARS,
  appendMemoryContext,
  buildSessionMemoryContext,
  capMemoryContext,
  deriveRelevantModules,
} from '../session-memory-context';

function mem(type: string, content: string, relatedFiles: string[] = []) {
  return { id: `${type}-${content.length}`, type, content, relatedFiles, confidence: 0.9 };
}

function fakeProxy(byType: Record<string, ReturnType<typeof mem>[]>) {
  const proxy = {
    searchMemory: vi.fn(async (filters: { types?: string[]; query?: string }) => {
      if (filters.query) return [];
      return (filters.types ?? []).flatMap((t) => byType[t] ?? []);
    }),
  };
  return proxy as typeof proxy & Pick<WorkerObserverProxy, 'searchMemory'>;
}

const base = { projectId: 'p1', specDir: '/nonexistent/spec-dir', taskDescription: 'Do a thing' };

afterEach(() => {
  vi.useRealTimers();
});

describe('buildSessionMemoryContext', () => {
  it('injects planner context with stored gotcha-like memories', async () => {
    const proxy = fakeProxy({ dead_end: [mem('dead_end', 'Never use approach ZED')] });
    const out = await buildSessionMemoryContext({ ...base, agentType: 'planner', proxy });
    expect(out).toContain('=== MEMORY CONTEXT FOR PLANNER ===');
    expect(out).toContain('Never use approach ZED');
  });

  it('injects QA context', async () => {
    const proxy = fakeProxy({ error_pattern: [mem('error_pattern', 'Flaky login')] });
    const postLog = vi.fn();
    const out = await buildSessionMemoryContext({ ...base, agentType: 'qa_reviewer', proxy, postLog });
    expect(out).toContain('=== MEMORY CONTEXT FOR QA ===');
    expect(postLog).toHaveBeenCalledTimes(1);
    expect(postLog.mock.calls[0][0]).toContain('qa_reviewer');
  });

  it('returns undefined with no calls when memory is off', async () => {
    for (const agentType of ['planner', 'qa_reviewer']) {
      expect(await buildSessionMemoryContext({ ...base, agentType, proxy: null })).toBeUndefined();
    }
  });

  it('returns undefined when the port never answers, after the deadline', async () => {
    vi.useFakeTimers();
    for (const agentType of ['planner', 'qa_reviewer']) {
      const proxy = { searchMemory: vi.fn(() => new Promise<never>(() => {})) };
      const postLog = vi.fn();
      const p = buildSessionMemoryContext({ ...base, agentType, proxy, postLog });
      await vi.advanceTimersByTimeAsync(MEMORY_CONTEXT_DEADLINE_MS + 10);
      await expect(p).resolves.toBeUndefined();
      expect(postLog).not.toHaveBeenCalled();
    }
  });

  it('returns undefined when the proxy rejects', async () => {
    const proxy = { searchMemory: vi.fn().mockRejectedValue(new Error('boom')) };
    expect(await buildSessionMemoryContext({ ...base, agentType: 'planner', proxy })).toBeUndefined();
    expect(await buildSessionMemoryContext({ ...base, agentType: 'qa_reviewer', proxy })).toBeUndefined();
  });

  it('caps huge output and keeps the END marker', async () => {
    const big = 'x'.repeat(400);
    const proxy = fakeProxy({
      dead_end: Array.from({ length: 8 }, (_, i) => mem('dead_end', `${i} ${big}`)),
      causal_dependency: Array.from({ length: 10 }, (_, i) => mem('causal_dependency', `${i} ${big}`)),
      work_unit_outcome: Array.from({ length: 5 }, (_, i) => mem('work_unit_outcome', `${i} ${big}`)),
    });
    const out = await buildSessionMemoryContext({ ...base, agentType: 'planner', proxy });
    expect(out).toBeDefined();
    expect(out?.length).toBeLessThanOrEqual(MEMORY_CONTEXT_MAX_CHARS);
    expect(out?.endsWith('=== END MEMORY CONTEXT ===')).toBe(true);
    expect(out).toContain('[truncated]');
  });

  it('skips other agent types without calling the proxy', async () => {
    const proxy = fakeProxy({ dead_end: [mem('dead_end', 'x')] });
    for (const agentType of ['coder', 'qa_fixer']) {
      expect(await buildSessionMemoryContext({ ...base, agentType, proxy })).toBeUndefined();
    }
    expect(proxy.searchMemory).not.toHaveBeenCalled();
  });

  it('lists prefetch files when prefetch_pattern memories exist', async () => {
    const proxy = fakeProxy({
      dead_end: [mem('dead_end', 'some dead end')],
      prefetch_pattern: [
        mem(
          'prefetch_pattern',
          JSON.stringify({ alwaysReadFiles: ['src/a.ts'], frequentlyReadFiles: ['src/b.ts'] }),
        ),
      ],
    });
    const out = await buildSessionMemoryContext({ ...base, agentType: 'planner', proxy });
    expect(out).toContain('FILES EARLIER SESSIONS USUALLY READ');
    expect(out).toContain('src/a.ts');
    expect(out).toContain('src/b.ts');
    expect(out?.endsWith('=== END MEMORY CONTEXT ===')).toBe(true);
  });
});

describe('capMemoryContext', () => {
  it('returns short text unchanged and cuts at line boundaries', () => {
    expect(capMemoryContext('abc', 100)).toBe('abc');
    const text = `=== MEMORY CONTEXT FOR QA ===\n${'line one\n'.repeat(50)}=== END MEMORY CONTEXT ===`;
    const out = capMemoryContext(text, 120);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('=== END MEMORY CONTEXT ===')).toBe(true);
    for (const line of out.split('\n')) {
      expect(['=== MEMORY CONTEXT FOR QA ===', 'line one', '[truncated]', '=== END MEMORY CONTEXT ===']).toContain(line);
    }
  });
});

describe('appendMemoryContext', () => {
  it('leaves the kickoff untouched without context', () => {
    expect(appendMemoryContext('kick', undefined)).toBe('kick');
    expect(appendMemoryContext('kick', '')).toBe('kick');
    expect(appendMemoryContext('kick', 'ctx')).toBe('kick\n\nctx');
  });
});

describe('deriveRelevantModules', () => {
  it('reads files_to_modify from context.json and plan, deduped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memctx-'));
    try {
      writeFileSync(
        join(dir, 'context.json'),
        JSON.stringify({ files_to_modify: ['apps/desktop/src/a.ts', 'apps/desktop/src/b.ts', 'scripts/x.sh'] }),
      );
      writeFileSync(
        join(dir, 'implementation_plan.json'),
        JSON.stringify({ phases: [{ subtasks: [{ files_to_modify: ['docs/readme.md', 'apps/desktop/z.ts'] }] }] }),
      );
      expect(deriveRelevantModules(dir)).toEqual(['apps/desktop', 'scripts/x.sh', 'docs/readme.md']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] for a missing directory', () => {
    expect(deriveRelevantModules('/definitely/not/here')).toEqual([]);
  });
});
