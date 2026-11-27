/**
 * @vitest-environment jsdom
 */
// zeenha fork: cover bulk-delete recovery through the actual confirmation dialog.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '../../../shared/i18n';
import type { TerminalWorktreeConfig, WorktreeListItem } from '../../../shared/types';
import { useProjectStore } from '../../stores/project-store';
import { useTaskStore } from '../../stores/task-store';
import { Toaster } from '../ui/toaster';
import { Worktrees } from '../Worktrees';

const project = { id: 'p1', name: 'P', path: '/p', autoBuildPath: '.auto-claude' };
const deletedTask = { id: 'task-deleted', specId: '001-ready', title: 'Ready task' };
const failedTask = { id: 'task-failed', specId: '002-locked', title: 'Locked task' };

function taskWorktree(specName: string, isOrphaned = false): WorktreeListItem {
  return {
    specName,
    path: `${project.path}/.auto-claude/worktrees/tasks/${specName}`,
    branch: `auto-claude/${specName}`,
    baseBranch: 'main',
    isOrphaned,
  };
}

function terminalWorktree(name: string, hasGitBranch: boolean): TerminalWorktreeConfig {
  return {
    name,
    worktreePath: `${project.path}/.auto-claude/worktrees/terminal/${name}`,
    branchName: hasGitBranch ? `terminal/${name}` : '',
    baseBranch: 'main',
    hasGitBranch,
    createdAt: '2025-01-01T00:00:00Z',
    terminalId: `session-${name}`,
  };
}

const deletedTaskWorktree = taskWorktree(deletedTask.specId);
const failedTaskWorktree = taskWorktree(failedTask.specId);
const orphan = taskWorktree('003-orphaned', true);
const deletedTerminal = terminalWorktree('scratch', false);
const failedTerminal = terminalWorktree('busy-shell', true);

function taskList(...worktrees: WorktreeListItem[]) {
  return { success: true, data: { worktrees } };
}

function terminalList(...worktrees: TerminalWorktreeConfig[]) {
  return { success: true, data: worktrees };
}

function mockApi() {
  type API = Window['electronAPI'];
  const api = {
    listWorktrees: vi.fn<API['listWorktrees']>().mockResolvedValue(taskList()),
    listTerminalWorktrees: vi.fn<API['listTerminalWorktrees']>().mockResolvedValue(terminalList()),
    cleanupMergedWorktrees: vi.fn<API['cleanupMergedWorktrees']>().mockResolvedValue({ success: true, data: [] }),
    discardWorktree: vi.fn<API['discardWorktree']>().mockResolvedValue({ success: true }),
    discardOrphanedWorktree: vi.fn<API['discardOrphanedWorktree']>().mockResolvedValue({ success: true }),
    removeTerminalWorktree: vi.fn<API['removeTerminalWorktree']>().mockResolvedValue({ success: true }),
  };
  vi.stubGlobal('electronAPI', api);
  return api;
}

function renderUi() {
  render(
    <>
      <Worktrees projectId={project.id} />
      <Toaster />
    </>
  );
}

async function openBulkDelete(count: number) {
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Select All' }));
  fireEvent.click(screen.getByRole('button', { name: `Delete (${count})` }));
}

async function findConfirmation(count: number) {
  const dialog = await screen.findByRole('alertdialog', { name: `Delete ${count} Worktrees?` });
  return within(dialog).getByRole('button', { name: 'Delete Selected' });
}

vi.setConfig({ testTimeout: 30000 });

describe('Worktrees bulk delete', () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [project] as never });
    useTaskStore.setState({ tasks: [deletedTask, failedTask] as never });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('keeps only failed task and terminal worktrees selected and retries them after confirmation', async () => {
    const api = mockApi();
    api.listWorktrees
      .mockResolvedValueOnce(taskList(deletedTaskWorktree, failedTaskWorktree, orphan))
      .mockResolvedValueOnce(taskList(failedTaskWorktree));
    api.listTerminalWorktrees
      .mockResolvedValueOnce(terminalList(deletedTerminal, failedTerminal))
      .mockResolvedValueOnce(terminalList(failedTerminal));
    api.discardWorktree
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'locked by another process' });
    api.removeTerminalWorktree
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'branch checked out elsewhere' });

    renderUi();
    await openBulkDelete(5);
    fireEvent.click(await findConfirmation(5));

    const summary = within(await screen.findByTestId('bulk-delete-summary'));
    expect(summary.getByTestId('bulk-delete-summary-counts').textContent).toBe('3 deleted, 2 not deleted');
    expect(summary.getAllByTestId('bulk-delete-failed-item').map((item) => item.textContent)).toEqual([
      'Locked task (002-locked): locked by another process',
      'busy-shell: branch checked out elsewhere',
    ]);
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: failedTaskWorktree.branch })).toBeTruthy();
    expect(screen.getByRole('heading', { name: failedTerminal.name })).toBeTruthy();
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getAllByRole('checkbox', { checked: true })).toHaveLength(2);

    expect(api.discardWorktree.mock.calls).toEqual([[deletedTask.id], [failedTask.id]]);
    expect(api.discardOrphanedWorktree.mock.calls).toEqual([[project.id, orphan.specName]]);
    expect(api.removeTerminalWorktree.mock.calls).toEqual([
      [project.path, deletedTerminal.name, false],
      [project.path, failedTerminal.name, true],
    ]);
    api.discardWorktree.mockClear();
    api.discardOrphanedWorktree.mockClear();
    api.removeTerminalWorktree.mockClear();

    fireEvent.click(summary.getByRole('button', { name: 'Retry failed' }));
    const confirmRetry = await findConfirmation(2);
    expect(api.discardWorktree).not.toHaveBeenCalled();
    expect(api.discardOrphanedWorktree).not.toHaveBeenCalled();
    expect(api.removeTerminalWorktree).not.toHaveBeenCalled();

    fireEvent.click(confirmRetry);
    expect(await screen.findByText('2 worktrees deleted successfully')).toBeTruthy();
    expect(api.discardWorktree.mock.calls).toEqual([[failedTask.id]]);
    expect(api.discardOrphanedWorktree).not.toHaveBeenCalled();
    expect(api.removeTerminalWorktree.mock.calls).toEqual([[project.path, failedTerminal.name, true]]);
  });

  it('reports a refresh failure separately and does not retry from the stale list', async () => {
    const api = mockApi();
    api.listWorktrees
      .mockResolvedValueOnce(taskList(failedTaskWorktree))
      .mockResolvedValueOnce({ success: false, error: 'boom' });
    api.discardWorktree.mockResolvedValueOnce({ success: false, error: 'locked by another process' });

    renderUi();
    await openBulkDelete(1);
    fireEvent.click(await findConfirmation(1));

    const summary = within(await screen.findByTestId('bulk-delete-summary'));
    expect(summary.getByTestId('bulk-delete-summary-counts').textContent).toBe('0 deleted, 1 not deleted');
    expect(summary.getByTestId('bulk-delete-refresh-failed').textContent).toContain('The worktree list could not be refreshed');
    expect(summary.getByText('Refresh error: boom')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry failed' })).toBeNull();
    expect(screen.queryAllByRole('checkbox', { checked: true })).toHaveLength(0);
    expect(screen.getByRole('heading', { name: failedTaskWorktree.branch })).toBeTruthy();
  });

  it('shows the success toast and no summary when all deletes succeed', async () => {
    const api = mockApi();
    api.listWorktrees.mockResolvedValueOnce(taskList(deletedTaskWorktree));

    renderUi();
    await openBulkDelete(1);
    fireEvent.click(await findConfirmation(1));

    expect(await screen.findByText('1 worktree deleted successfully')).toBeTruthy();
    expect(screen.queryByTestId('bulk-delete-summary')).toBeNull();
  });
});
