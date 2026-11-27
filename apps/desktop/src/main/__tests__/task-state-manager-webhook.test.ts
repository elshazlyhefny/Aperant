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

const issueDispatch = vi.fn();
vi.mock('../ipc-handlers/issue-writeback/issue-writeback', () => ({
  dispatchIssueOutcome: (...args: unknown[]) => issueDispatch(...args),
}));

const recorder = { skip: vi.fn(), track: vi.fn(), snapshot: vi.fn() };
const createRecorder = vi.fn(() => recorder);
vi.mock('../delivery-receipts', () => ({
  createDeliveryReceiptRecorder: (...args: []) => createRecorder(...args)
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
  issueDispatch.mockReset();
  createRecorder.mockClear();
});

describe('TaskStateManager webhook dispatch', () => {
  it('dispatches failed once on error', () => {
    const manager = make();
    send(manager, { type: 'PLANNING_STARTED' });
    send(manager, { type: 'PLANNING_FAILED', error: 'boom', recoverable: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ status: 'error', reviewReason: undefined, projectName: 'Proj', taskTitle: 'My task', project }, recorder);
  });

  it('dispatches review_ready on completed human_review', () => {
    const manager = make();
    send(manager, { type: 'PLANNING_STARTED' });
    send(manager, { type: 'QA_PASSED', iteration: 1, testsRun: {} });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ status: 'human_review', reviewReason: 'completed' });
  });

  it('shares a project-root recorder only after persisting and emitting the outcome', () => {
    const manager = make();
    createRecorder.mockImplementationOnce(() => {
      expect(persisted.at(-1)?.[1]).toBe('human_review');
      expect(sends.at(-1)?.[2]).toBe('human_review');
      return recorder;
    });
    send(manager, { type: 'PLANNING_STARTED' });
    send(manager, { type: 'QA_PASSED', iteration: 1, testsRun: {} });

    expect(createRecorder).toHaveBeenCalledExactlyOnceWith(project.path, task.specId);
    expect(dispatch.mock.calls[0][1]).toBe(recorder);
    expect(issueDispatch.mock.calls[0][1]).toBe(recorder);
  });

  it('handles both delivery promise rejections without waiting or changing status', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      dispatch.mockRejectedValueOnce(new Error('private webhook failure'));
      issueDispatch.mockRejectedValueOnce(new Error('private issue failure'));
      const manager = make();
      send(manager, { type: 'PLANNING_STARTED' });
      send(manager, { type: 'QA_PASSED', iteration: 1, testsRun: {} });

      expect(persisted.at(-1)?.[1]).toBe('human_review');
      expect(sends.at(-1)?.[2]).toBe('human_review');
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(issueDispatch).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
      const writes = persisted.length;
      const events = sends.length;
      await Promise.resolve();
      expect(warn.mock.calls).toEqual([
        ['[TaskStateManager] Webhook dispatch failed'],
        ['[TaskStateManager] Issue write-back failed']
      ]);
      expect(persisted).toHaveLength(writes);
      expect(sends).toHaveLength(events);
    } finally {
      warn.mockRestore();
    }
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

  it('a throwing webhook dispatcher does not block persistence, the renderer event or issueDispatch', () => {
    dispatch.mockImplementation(() => {
      throw new Error('webhook down');
    });
    const manager = make();
    send(manager, { type: 'PLANNING_STARTED' });
    send(manager, { type: 'QA_PASSED', iteration: 1, testsRun: {} });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(persisted[persisted.length - 1]?.[1]).toBe('human_review');
    expect(sends[sends.length - 1]?.[2]).toBe('human_review');
    expect(issueDispatch).toHaveBeenCalledTimes(1);
  });
});

function toCreatingPr(manager: TaskStateManager) {
  send(manager, { type: 'PLANNING_STARTED' });
  send(manager, { type: 'QA_PASSED', iteration: 1, testsRun: {} });
  manager.handleUiEvent('t1', { type: 'CREATE_PR' }, task, project);
}

describe('TaskStateManager PR opened webhook', () => {
  it('dispatches pr_created once with the prUrl when the status is set manually', () => {
    const manager = make();
    const withPr = { ...task, metadata: { prUrl: 'https://github.com/o/r/pull/1' } } as Task;
    toCreatingPr(manager);
    dispatch.mockClear();
    manager.handleManualStatusChange('t1', 'pr_created', withPr, project);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      status: 'pr_created',
      prUrl: 'https://github.com/o/r/pull/1'
    });
  });

  it('dispatches without a link when the in-memory task has no prUrl yet', () => {
    const manager = make();
    toCreatingPr(manager);
    dispatch.mockClear();
    manager.handleManualStatusChange('t1', 'pr_created', task, project);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].prUrl).toBeUndefined();
  });

  it('does not send a second PR opened message when a PR follow-up run starts', () => {
    const manager = make();
    manager.startPRFollowUp('t1', task, project);
    const prOpened = dispatch.mock.calls.filter((c) => c[0].status === 'pr_created');
    expect(prOpened).toHaveLength(0);
    expect(manager.getCurrentState('t1')).toBe('coding');
  });

  it('dispatches pr_created with the metadata prUrl when driven through CREATE_PR and PR_CREATED', () => {
    const manager = make();
    const prUrl = 'https://github.com/o/r/pull/2';
    const withPr = { ...task, metadata: { prUrl } } as Task;
    send(manager, { type: 'PLANNING_STARTED' });
    send(manager, { type: 'QA_PASSED', iteration: 1, testsRun: {} });
    manager.handleUiEvent('t1', { type: 'CREATE_PR' }, withPr, project);
    dispatch.mockClear();
    issueDispatch.mockClear();
    manager.handleUiEvent('t1', { type: 'PR_CREATED', prUrl }, withPr, project);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ status: 'pr_created', prUrl });
    // The state manager forwards pr_opened to the issue dispatcher, which ignores it.
    expect(issueDispatch.mock.calls.every((c) => c[0].event === 'pr_opened')).toBe(true);
  });

  it('dispatches pr_created with prUrl undefined when the task has no metadata.prUrl', () => {
    const manager = make();
    toCreatingPr(manager);
    dispatch.mockClear();
    manager.handleUiEvent('t1', { type: 'PR_CREATED', prUrl: 'https://github.com/o/r/pull/3' }, task, project);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].prUrl).toBeUndefined();
  });
});

describe('TaskStateManager issue write-back dispatch', () => {
  it('dispatches failed on error', () => {
    const manager = make();
    send(manager, { type: 'PLANNING_STARTED' });
    send(manager, { type: 'PLANNING_FAILED', error: 'boom', recoverable: true });
    expect(issueDispatch).toHaveBeenCalledTimes(1);
    expect(issueDispatch).toHaveBeenCalledWith({ task, project, event: 'failed' }, recorder);
  });

  it('dispatches review_ready on completed human_review', () => {
    const manager = make();
    send(manager, { type: 'PLANNING_STARTED' });
    send(manager, { type: 'QA_PASSED', iteration: 1, testsRun: {} });
    expect(issueDispatch).toHaveBeenCalledTimes(1);
    expect(issueDispatch).toHaveBeenCalledWith({ task, project, event: 'review_ready' }, recorder);
  });

  it('dispatches blocked on qa_rejected', () => {
    const manager = make();
    send(manager, { type: 'PLANNING_STARTED' });
    send(manager, { type: 'QA_STARTED', iteration: 1, maxIterations: 3 });
    send(manager, { type: 'QA_FAILED', iteration: 1, issueCount: 1, issues: ['x'] });
    send(manager, { type: 'QA_FAILED', iteration: 2, issueCount: 1, issues: ['x'] });
    expect(issueDispatch).toHaveBeenCalledTimes(1);
    expect(issueDispatch).toHaveBeenCalledWith({ task, project, event: 'blocked' }, recorder);
  });

  it('does not dispatch for in_progress, plan_review or stopped', () => {
    const manager = make();
    send(manager, { type: 'PLANNING_STARTED' });
    send(manager, { type: 'PLANNING_COMPLETE', hasSubtasks: true, subtaskCount: 1, requireReviewBeforeCoding: true });
    send(manager, { type: 'PLAN_APPROVED' });
    send(manager, { type: 'CODING_STARTED', subtaskId: 's', subtaskDescription: 'd' });
    manager.handleUiEvent('t1', { type: 'USER_STOPPED', hasPlan: true }, task, project);
    expect(issueDispatch).not.toHaveBeenCalled();
  });

  it('a throwing issue dispatcher does not block persistence, the renderer event or the webhook', () => {
    issueDispatch.mockImplementation(() => {
      throw new Error('issue down');
    });
    const manager = make();
    send(manager, { type: 'PLANNING_STARTED' });
    send(manager, { type: 'QA_PASSED', iteration: 1, testsRun: {} });
    expect(issueDispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(persisted[persisted.length - 1]?.[1]).toBe('human_review');
    expect(sends[sends.length - 1]?.[2]).toBe('human_review');
  });
});

// zeenha fork: actor.start() notifies the subscriber with the state an actor is
// rebuilt in. That restored state is not a transition and must not be reported.
describe('TaskStateManager rebuilt actor', () => {
  it('sends no account_required webhook or write-back for a restored account pause on USER_RESUMED', () => {
    const manager = make();
    const paused = { ...task, status: 'human_review', reviewReason: 'account_required' } as Task;

    manager.handleUiEvent('t1', { type: 'USER_RESUMED' }, paused, project);

    expect(manager.getCurrentState('t1')).toBe('coding');
    expect(dispatch).not.toHaveBeenCalled();
    expect(issueDispatch).not.toHaveBeenCalled();
    expect(createRecorder).not.toHaveBeenCalled();
    // The restored state is still persisted and sent to the renderer as before
    expect(sends.some((args) => args[2] === 'human_review')).toBe(true);
  });

  it('sends no review_ready for a restored completed task that is then marked done', () => {
    const manager = make();
    const completed = { ...task, status: 'human_review', reviewReason: 'completed' } as Task;

    manager.handleManualStatusChange('t1', 'done', completed, project);

    expect(dispatch.mock.calls.some((c) => c[0].reviewReason === 'completed')).toBe(false);
  });

  it('still reports a real account pause on a rebuilt actor', () => {
    const manager = make();
    const paused = { ...task, status: 'human_review', reviewReason: 'account_required' } as Task;
    manager.handleUiEvent('t1', { type: 'USER_RESUMED' }, paused, project);
    dispatch.mockClear();

    manager.handleUiEvent('t1', { type: 'PHASE_ACCOUNT_UNAVAILABLE', error: 'no account' }, paused, project);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ status: 'human_review', reviewReason: 'account_required' });
  });
});
