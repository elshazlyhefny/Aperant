/**
 * Opt-in benchmark for ProjectStore.getTasks() scan time.
 * Skipped unless SCAN_BENCH is set: `SCAN_BENCH=1 npx vitest run project-store-scan-bench`
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

let TEST_DIR: string;
let USER_DATA_PATH: string;
let TEST_PROJECT_PATH: string;

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return USER_DATA_PATH;
      return TEST_DIR;
    })
  }
}));

const SPEC_COUNT = 200;
const WORKTREE_COUNT = 2;
const WARM_RUNS = 5;

function specId(i: number): string {
  return `${String(i + 1).padStart(3, '0')}-bench-spec-${i}`;
}

function writeSpec(specsDir: string, id: string, i: number): void {
  const dir = path.join(specsDir, id);
  mkdirSync(dir, { recursive: true });
  const plan = {
    // Every 3rd plan uses a spec-id-looking feature so the title falls back to spec.md
    feature: i % 3 === 0 ? id : `Benchmark feature ${i}`,
    description: `Description for spec ${i}`,
    workflow_type: 'feature',
    status: 'in_progress',
    phases: [
      {
        id: 'phase-1',
        name: 'Phase 1',
        subtasks: [
          { id: `${id}-1`, description: 'First', status: 'completed' },
          { id: `${id}-2`, description: 'Second', status: 'pending' }
        ]
      }
    ]
  };
  writeFileSync(path.join(dir, 'implementation_plan.json'), JSON.stringify(plan, null, 2));
  writeFileSync(
    path.join(dir, 'requirements.json'),
    JSON.stringify({ task_description: `Task description ${i}`, workflow_type: 'feature' })
  );
  writeFileSync(
    path.join(dir, 'task_metadata.json'),
    JSON.stringify({ sourceType: 'manual', category: 'feature', complexity: 'small' })
  );
  writeFileSync(
    path.join(dir, 'spec.md'),
    `# Specification ${i}\n\n## Overview\n\nThis is the overview for spec ${i}. It describes the work.\n\n## Requirements\n\n- one\n- two\n`
  );
}

describe.skipIf(!process.env.SCAN_BENCH)('ProjectStore.getTasks scan benchmark', () => {
  beforeEach(() => {
    TEST_DIR = mkdtempSync(path.join(tmpdir(), 'project-store-bench-'));
    USER_DATA_PATH = path.join(TEST_DIR, 'userData');
    TEST_PROJECT_PATH = path.join(TEST_DIR, 'bench-project');
    mkdirSync(path.join(USER_DATA_PATH, 'store'), { recursive: true });
    mkdirSync(path.join(TEST_PROJECT_PATH, '.auto-claude', 'specs'), { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  it('measures cold and invalidated getTasks()', async () => {
    const { ProjectStore } = await import('../project-store');
    const { getTaskWorktreeDir } = await import('../worktree-paths');
    const store = new ProjectStore();
    const project = store.addProject(TEST_PROJECT_PATH);

    const mainSpecs = path.join(TEST_PROJECT_PATH, '.auto-claude', 'specs');
    for (let i = 0; i < SPEC_COUNT; i++) {
      writeSpec(mainSpecs, specId(i), i);
    }

    const worktreesDir = getTaskWorktreeDir(project.path);
    for (let w = 0; w < WORKTREE_COUNT; w++) {
      const wtSpecs = path.join(worktreesDir, `wt-${w}`, '.auto-claude', 'specs');
      for (let i = w; i < SPEC_COUNT; i += 4) {
        writeSpec(wtSpecs, specId(i), i);
      }
    }

    const coldStart = performance.now();
    const cold = store.getTasks(project.id);
    const coldMs = performance.now() - coldStart;
    expect(cold.length).toBe(SPEC_COUNT);

    let total = 0;
    for (let r = 0; r < WARM_RUNS; r++) {
      store.invalidateTasksCache(project.id);
      const start = performance.now();
      store.getTasks(project.id);
      total += performance.now() - start;
    }
    const avgMs = total / WARM_RUNS;

    console.info(
      `[scan-bench] specs=${SPEC_COUNT} worktrees=${WORKTREE_COUNT} cold=${coldMs.toFixed(1)}ms invalidated-avg(${WARM_RUNS})=${avgMs.toFixed(1)}ms`
    );
  });
});
