/**
 * zeenha fork: the plan keeps why a run failed while it is failed, and drops
 * it once the task moves on (so a later failure never shows an old reason).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../project-store', () => ({ projectStore: { invalidateTasksCache: vi.fn() } }));

import { persistPlanStatusAndReasonSync } from '../plan-file-utils';

let dir: string;
const planPath = () => join(dir, 'implementation_plan.json');
const read = () => JSON.parse(readFileSync(planPath(), 'utf-8'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plan-reason-'));
  writeFileSync(planPath(), JSON.stringify({ feature: 'x', phases: [] }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('persistPlanStatusAndReasonSync failureReason', () => {
  it('writes the reason when entering error', () => {
    persistPlanStatusAndReasonSync(planPath(), 'error', undefined, 'p', 'error', 'failed', 'boom');
    expect(read()).toMatchObject({ status: 'error', xstateState: 'error', failureReason: 'boom' });
  });

  it('drops the reason when the task leaves error', () => {
    persistPlanStatusAndReasonSync(planPath(), 'error', undefined, 'p', 'error', 'failed', 'boom');
    persistPlanStatusAndReasonSync(planPath(), 'in_progress', undefined, 'p', 'coding', 'coding');
    expect(read().failureReason).toBeUndefined();
    expect(read().xstateState).toBe('coding');
  });
});
