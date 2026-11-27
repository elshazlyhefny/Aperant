/** zeenha fork: exercise both real persistence paths against the same timing definitions. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTO_BUILD_PATHS, getSpecsDir } from '../../../../shared/constants';
import type { DeliveryTimingSource } from '../../../../shared/types/run-metrics';
import { type HeadlessProject, setTaskStatus } from '../../../headless/task-store';
import { deriveDeliveryTiming, readDeliveryTimingState } from '../delivery-timing';
import { DELIVERY_TIMING_SCENARIOS, type DeliveryTimingStep, FIXTURE_QUEUE_ENTRY } from './delivery-timing-fixtures';

vi.mock('../../../project-store', () => ({ projectStore: { invalidateTasksCache: vi.fn() } }));

const SPEC_ID = '001-delivery-timing-fixture';
let root: string;

function writeBacklogPlan(specDir: string): string {
  mkdirSync(specDir, { recursive: true });
  const planPath = join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
  writeFileSync(planPath, JSON.stringify({ status: 'backlog', phases: [] }));
  return planPath;
}

async function replayDesktop(planPath: string, steps: readonly DeliveryTimingStep[]): Promise<void> {
  let writer = await import('../../../ipc-handlers/task/plan-file-utils');
  for (const { afterMs, status, reviewReason, interrupted } of steps) {
    vi.setSystemTime(FIXTURE_QUEUE_ENTRY + afterMs);
    if (interrupted) {
      // The desktop writer has no interruption flag: reload it to simulate a
      // new process instance while retaining the existing plan and timing log.
      vi.resetModules();
      writer = await import('../../../ipc-handlers/task/plan-file-utils');
    }
    const persisted = status === 'queue'
      ? await writer.persistPlanStatus(planPath, status)
      : writer.persistPlanStatusAndReasonSync(planPath, status, reviewReason);
    expect(persisted).toBe(true);
  }
}

async function replayDaemon(project: HeadlessProject, steps: readonly DeliveryTimingStep[]): Promise<void> {
  for (const { afterMs, status, reviewReason, pause, interrupted } of steps) {
    vi.setSystemTime(FIXTURE_QUEUE_ENTRY + afterMs);
    // Use the recovery flag without changing the recorder's instance so that
    // the test also detects a dropped interruption marker at this write path.
    await setTaskStatus(project, SPEC_ID, status, reviewReason, { pause, interrupted });
  }
}

async function readResult(specDir: string, source: DeliveryTimingSource, steps: readonly DeliveryTimingStep[]) {
  const timing = await readDeliveryTimingState(specDir);
  if (timing.state !== 'ok') throw new Error(`Expected ${source} timing events, got ${timing.state}`);
  expect(timing.events).toEqual(steps.map((step, i) => ({
    at: new Date(FIXTURE_QUEUE_ENTRY + step.afterMs).toISOString(),
    status: step.status,
    from: steps[i - 1]?.status ?? 'backlog',
    reviewReason: step.reviewReason,
    pause: step.pause,
    interrupted: source === 'daemon' ? step.interrupted : undefined,
    instance: expect.any(String),
    source
  })));
  return deriveDeliveryTiming(timing.events);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'delivery-timing-parity-'));
  // Keep real timers for filesystem locking; only the event timestamps are synthetic.
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe('delivery timing through desktop and daemon persistence', () => {
  it.each(DELIVERY_TIMING_SCENARIOS)('$name', async ({ steps, daemonSteps = steps, expected }) => {
    const desktopDir = join(root, 'desktop', SPEC_ID);
    const project: HeadlessProject = { id: 'fixture', path: join(root, 'daemon'), autoBuildPath: '.auto-claude' };
    const daemonDir = join(project.path, getSpecsDir(project.autoBuildPath), SPEC_ID);
    const desktopPlan = writeBacklogPlan(desktopDir);
    writeBacklogPlan(daemonDir);

    await replayDesktop(desktopPlan, steps);
    await replayDaemon(project, daemonSteps);

    const desktop = await readResult(desktopDir, 'desktop', steps);
    const daemon = await readResult(daemonDir, 'daemon', daemonSteps);
    expect(desktop).toEqual(expected);
    expect(daemon).toEqual(expected);
    expect(daemon).toEqual(desktop);
  });
});
