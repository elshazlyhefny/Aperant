/**
 * zeenha fork: track the cost of repeated headless queue scans on settled specs.
 * Opt in with `SCAN_BENCH=1 npx vitest run --disableConsoleIntercept task-store-scan-bench`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTO_BUILD_PATHS, getSpecsDir } from '../../../shared/constants';
import { safeParseJson } from '../../utils/json-repair';
import { getTaskWorktreeDir } from '../../worktree-paths';
import { createHeadlessTaskReader, type HeadlessProject, listHeadlessTasks } from '../task-store';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  // Both the task store and FileParseCache use the named fs import.
  // Count path-based reads as well as descriptor-based reads on cache misses.
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

vi.mock('../../utils/json-repair', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/json-repair')>();
  return { ...actual, safeParseJson: vi.fn(actual.safeParseJson) };
});

const SPEC_COUNT = 500;
const WORKTREE_COUNT = 20;
const RUNS = 20;

function specId(i: number): string {
  return `${String(i + 1).padStart(3, '0')}-bench-spec`;
}

function writeJson(filePath: string, value: object, mtime: Date): void {
  writeFileSync(filePath, JSON.stringify(value), 'utf-8');
  // Keep fixture writes outside FileParseCache's 2s racy window.
  utimesSync(filePath, mtime, mtime);
}

function writePlan(planPath: string, id: string, mtime: Date): void {
  writeJson(
    planPath,
    {
      feature: `Benchmark feature ${id}`,
      status: 'queue',
      updated_at: mtime.toISOString(),
      phases: [{ subtasks: [{ id: `${id}-1`, description: 'Implement feature', status: 'pending' }] }]
    },
    mtime
  );
}

function writeSpec(specsDir: string, id: string, mtime: Date): void {
  const dir = path.join(specsDir, id);
  mkdirSync(dir, { recursive: true });
  writePlan(path.join(dir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN), id, mtime);
  writeJson(path.join(dir, AUTO_BUILD_PATHS.REQUIREMENTS), { task_description: `Task ${id}` }, mtime);
  writeJson(path.join(dir, 'task_metadata.json'), { sourceType: 'manual', category: 'feature' }, mtime);
}

function scan(project: HeadlessProject, reader?: ReturnType<typeof createHeadlessTaskReader>) {
  return reader ? reader.list() : listHeadlessTasks(project);
}

/** Nearest-rank percentile of sorted pass timings. */
function percentile(sortedMs: number[], fraction: number): string {
  return sortedMs[Math.ceil(sortedMs.length * fraction) - 1].toFixed(2);
}

let root: string;

describe.skipIf(!process.env.SCAN_BENCH)('headless task-store scan benchmark', () => {
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'headless-task-store-bench-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it.each([
    ['uncached', 'idle'],
    ['warm-cache', 'idle'],
    ['uncached', 'one-plan-changed'],
    ['warm-cache', 'one-plan-changed']
  ])('measures %s %s passes', (mode, scenario) => {
    const project = { id: 'bench', path: root, autoBuildPath: '.auto-claude' };
    const specsBase = getSpecsDir(project.autoBuildPath);
    const mainSpecs = path.join(root, specsBase);
    const worktrees = getTaskWorktreeDir(root);
    const settledAt = Date.now() - 60_000;
    const mtime = new Date(settledAt);
    for (let i = 0; i < SPEC_COUNT; i++) {
      writeSpec(mainSpecs, specId(i), mtime);
    }
    for (let i = 0; i < WORKTREE_COUNT; i++) {
      const id = specId(i);
      writeSpec(path.join(worktrees, id, specsBase), id, mtime);
    }

    // Pick a main-only spec so there is no worktree copy masking the rewrite.
    const changedId = specId(SPEC_COUNT - 1);
    const planPath = path.join(mainSpecs, changedId, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
    const reader = mode === 'warm-cache' ? createHeadlessTaskReader(project) : undefined;
    if (reader) scan(project, reader); // Prime once, outside the measured passes.
    const { hits: initialHits, misses: initialMisses } = reader?.stats ?? { hits: 0, misses: 0 };

    const readSpy = vi.mocked(readFileSync);
    const parseSpy = vi.mocked(safeParseJson);
    const passTimes: number[] = [];
    let reads = 0;
    let parses = 0;
    for (let run = 0; run < RUNS; run++) {
      if (scenario === 'one-plan-changed') {
        writePlan(planPath, changedId, new Date(settledAt + (run + 1) * 1000));
      }
      readSpy.mockClear();
      parseSpy.mockClear();
      const start = performance.now();
      const tasks = scan(project, reader);
      passTimes.push(performance.now() - start);
      const passReads = readSpy.mock.calls.length;
      const passParses = parseSpy.mock.calls.length;
      reads += passReads;
      parses += passParses;
      expect(tasks).toHaveLength(SPEC_COUNT);
      if (reader) {
        expect(passParses).toBe(scenario === 'idle' ? 0 : 1);
        if (scenario === 'idle') expect(passReads).toBe(0);
      }
    }
    passTimes.sort((a, b) => a - b);

    const hitsPerPass = reader ? (reader.stats.hits - initialHits) / RUNS : 'n/a';
    const missesPerPass = reader ? (reader.stats.misses - initialMisses) / RUNS : 'n/a';
    console.info(
      `[task-store-scan-bench] ${mode} ${scenario} specs=${SPEC_COUNT} worktrees=${WORKTREE_COUNT} passes=${RUNS} ` +
        `reads/pass=${reads / RUNS} parses/pass=${parses / RUNS} ` +
        `hits/pass=${hitsPerPass} misses/pass=${missesPerPass} ` +
        `p50=${percentile(passTimes, 0.5)}ms p95=${percentile(passTimes, 0.95)}ms`
    );
  }, 60_000); // Give instrumented scans room on slower filesystems.
});
