/**
 * zeenha fork: terminal task transitions are reported to the outcome webhook
 * from the TaskStateManager subscriber, and a webhook failure never affects
 * persistence or the renderer event.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Task } from '../../shared/types';

const sends: unknown[][] = [];
vi.mock('../ipc-handlers/utils', () => ({
  safeSendToRenderer: (_getWindow: unknown, ...args: unknown[]) => sends.push(args),
}));
const persisted: unknown[][] = [];
vi.mock('../ipc-handlers/task/plan-file-utils', () => ({
  getPlanPath: () => '/p/implementation_plan.json',
  persistPlanStatusAndReasonSync: (...args: unknown[]) => persisted.push(args),
}));
vi.mock('../worktree-paths', () => ({ findTaskWorktree: () => null }));
vi.mock('fs', () => ({ existsSync: () => false }));
vi.mock('../task-failure-facts', () => ({
  taskSpecDirs: () => ['/p'],
  readSubtaskStatuses: () => [],
  taskHasCodeChanges: () => false,
  readFailureReason: () => undefined,
}));

const dispatch = vi.fn();
vi.mock('../task-webhook', async () => {
  const actual = await vi.importActual<typeof import('../task-webhook')>('../task-webhook');
  return { ...actual, dispatchTaskOutcomeWebhook: (...args: unknown[]) => dispatch(...args) };
});

const jiraDispatch = vi.fn();
vi.mock('../ipc-handlers/jira/jira-writeback', () => ({
  dispatchJiraOutcome: (...args: unknown[]) => jiraDispatch(...args),
}));

import { TaskStateManager } from '../task-state-manager';

const task = { id: 't1', specId: '001-x', projectId: 'p1', title: 'My task', description: '', status: 'backlog', subtasks: [], logs: [], createdAt: new Date(), updatedAt: new Date() } as Task;
const project = { id: 'p1', name: 'Proj', path: '/proj', autoBuildPath: '.auto-claude' } as Project;

function make() {
  const manager = new TaskStateManager();
  manager.configure(() => ({}) as never);
  return manager;
}
let seq = 0;
function send(manager: TaskStateManager, event: Record<string, unknown>) {
  manager.handleTaskEvent('t1', { ...event, sequence: ++seq } as never, task, project);
}

beforeEach(() => {
  sends.length = 0;
  persisted.length = 0;
  seq = 0;
  dispatch.mockReset();
  jiraDispatch.mockReset();
});

describe('TaskStateManager webhook dispatch', () => {
  it('dispatches failed once on error', () => {
    const manager = make();
    send(manager, { type: 'PLANNING_STARTED' });
    send(manager, { type: 'PLANNING_FAILED', error: 'boom', recoverable: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ status: 'error', reviewReason: undefined, projectName: 'Proj', taskTitle: 'My task' });
  });

  it('dispatches review_ready on completed human_review', () => {
    const manager = make();
    send(manager, { type: 'PLANNING_STARTED' });
    send(manager, { type: 'QA_PASSED', iteration: 1, testsRun: {} });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ status: 'human_review', reviewReason: 'completed' });
  });

  it('dispatches blocked on qa_rejected', () => {
    const manager = make();
    send(manager, { type: 'PLANNING_STARTED' });
    send(manager, { type: 'QA_STARTED', iteration: 1, maxIterations: 3 });
    send(manager, { type: 'QA_FAILED', iteration: 1, issueCount: 1, issues: ['x'] });
    send(manager, { type: 'QA_FAILED', iteration: 2, issueCount: 1, issues: ['x'] });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ status: 'human_review', reviewReason: 'qa_rejected' });
  });

  it('does not dispatch for in_progress, plan_review or stopped', () => {
    const manager = make();
    send(manager, { type: 'PLANNING_STARTED' });
    send(manager, { type: 'PLANNING_COMPLETE', hasSubtasks: true, subtaskCount: 1, requireReviewBeforeCoding: true });
    expect(manager.getCurrentState('t1')).toBe('plan_review');
    send(manager, { type: 'PLAN_APPROVED' });
    send(manager, { type: 'CODING_STARTED', subtaskId: 's', subtaskDescription: 'd' });
    manager.handleUiEvent('t1', { type: 'USER_STOPPED', hasPlan: true }, task, project);
    expect(sends.length).toBeGreaterThan(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('a throwing dispatcher does not block persistence or the renderer event', () => {
    dispatch.mockImplementation(() => {
      throw new Error('webhook down');
    });
    const manager = make();
    send(manager, { type: 'PLANNING_STARTED' });
    send(manager, { type: 'QA_PASSED', iteration: 1, testsRun: {} });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(persisted[persisted.length - 1]?.[1]).toBe('human_review');
    expect(sends[sends.length - 1]?.[2]).toBe('human_review');
    expect(jiraDispatch).toHaveBeenCalledTimes(1);
  });

  it('a throwing Jira dispatcher does not block persistence, the renderer event or the webhook', () => {
    jiraDispatch.mockImplementation(() => {
      throw new Error('jira down');
    });
    const manager = make();
    send(manager, { type: 'PLANNING_STARTED' });
    send(manager, { type: 'QA_PASSED', iteration: 1, testsRun: {} });
    expect(jiraDispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(persisted[persisted.length - 1]?.[1]).toBe('human_review');
    expect(sends[sends.length - 1]?.[2]).toBe('human_review');
  });
});

describe('TaskStateManager Jira write-back dispatch', () => {
  it('dispatches failed on error', () => {
    const manager = make();
    send(manager, { type: 'PLANNING_STARTED' });
    send(manager, { type: 'PLANNING_FAILED', error: 'boom', recoverable: true });
    expect(jiraDispatch).toHaveBeenCalledTimes(1);
    expect(jiraDispatch).toHaveBeenCalledWith({ task, project, event: 'failed' });
  });

  it('dispatches review_ready on completed human_review', () => {
    const manager = make();
    send(manager, { type: 'PLANNING_STARTED' });
    send(manager, { type: 'QA_PASSED', iteration: 1, testsRun: {} });
    expect(jiraDispatch).toHaveBeenCalledTimes(1);
    expect(jiraDispatch).toHaveBeenCalledWith({ task, project, event: 'review_ready' });
  });

  it('dispatches blocked on qa_rejected', () => {
    const manager = make();
    send(manager, { type: 'PLANNING_STARTED' });
    send(manager, { type: 'QA_STARTED', iteration: 1, maxIterations: 3 });
    send(manager, { type: 'QA_FAILED', iteration: 1, issueCount: 1, issues: ['x'] });
    send(manager, { type: 'QA_FAILED', iteration: 2, issueCount: 1, issues: ['x'] });
    expect(jiraDispatch).toHaveBeenCalledTimes(1);
    expect(jiraDispatch).toHaveBeenCalledWith({ task, project, event: 'blocked' });
  });

  it('does not dispatch for in_progress, plan_review or stopped', () => {
    const manager = make();
    send(manager, { type: 'PLANNING_STARTED' });
    send(manager, { type: 'PLANNING_COMPLETE', hasSubtasks: true, subtaskCount: 1, requireReviewBeforeCoding: true });
    send(manager, { type: 'PLAN_APPROVED' });
    send(manager, { type: 'CODING_STARTED', subtaskId: 's', subtaskDescription: 'd' });
    manager.handleUiEvent('t1', { type: 'USER_STOPPED', hasPlan: true }, task, project);
    expect(jiraDispatch).not.toHaveBeenCalled();
  });

  it('a throwing webhook dispatcher does not skip the Jira dispatcher', () => {
    dispatch.mockImplementation(() => {
      throw new Error('webhook down');
    });
    const manager = make();
    send(manager, { type: 'PLANNING_STARTED' });
    send(manager, { type: 'QA_PASSED', iteration: 1, testsRun: {} });
    expect(jiraDispatch).toHaveBeenCalledTimes(1);
  });
});
