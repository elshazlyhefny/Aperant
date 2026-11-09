/**
 * zeenha fork: the per-task token budget override is normalised before it is
 * written to task_metadata.json. A positive number is kept, 0 means "no limit
 * for this task", and anything invalid or blank is dropped (inherit).
 */
import { describe, expect, it, vi } from 'vitest';
import type { TaskMetadata } from '../../../../shared/types';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  nativeImage: {},
  app: { getPath: () => '/tmp', isPackaged: false, on: vi.fn() },
}));
vi.mock('../../../project-store', () => ({ projectStore: {} }));
vi.mock('../../../title-generator', () => ({ titleGenerator: {} }));
vi.mock('../../../agent', () => ({ AgentManager: class {} }));
vi.mock('../shared', () => ({ findTaskAndProject: vi.fn() }));
vi.mock('../../../task-state-manager', () => ({ taskStateManager: {} }));
vi.mock('../../../sentry', () => ({ safeBreadcrumb: vi.fn() }));
vi.mock('../../../cli-tool-manager', () => ({ getToolPath: vi.fn() }));

import { applyTokenBudget } from '../crud-handlers';

function run(tokenBudget: unknown, extra: Partial<TaskMetadata> = {}): TaskMetadata {
  const metadata = { ...extra, tokenBudget } as TaskMetadata;
  applyTokenBudget(metadata);
  return metadata;
}

describe('applyTokenBudget (task create/update metadata)', () => {
  it('keeps a positive budget set on create', () => {
    expect(run(500000).tokenBudget).toBe(500000);
  });

  it('floors a fractional budget', () => {
    expect(run(1000.9).tokenBudget).toBe(1000);
  });

  it('updates an existing budget to a new value', () => {
    const merged = { tokenBudget: 1000, ...{ tokenBudget: 2000 } } as TaskMetadata;
    applyTokenBudget(merged);
    expect(merged.tokenBudget).toBe(2000);
  });

  it('keeps 0 as an explicit no-limit override', () => {
    const metadata = run(0);
    expect(metadata.tokenBudget).toBe(0);
    expect('tokenBudget' in metadata).toBe(true);
  });

  it('clears the override (inherit) when undefined', () => {
    const metadata = run(undefined);
    expect('tokenBudget' in metadata).toBe(false);
  });

  it.each([-5, NaN, Infinity, '100', null])('drops invalid value %s', (bad) => {
    expect('tokenBudget' in run(bad)).toBe(false);
  });

  it('leaves other metadata untouched', () => {
    expect(run(0, { fastMode: true }).fastMode).toBe(true);
  });
});
