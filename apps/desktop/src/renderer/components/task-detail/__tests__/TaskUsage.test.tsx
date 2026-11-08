/**
 * @vitest-environment jsdom
 *
 * zeenha fork: the task Usage tab renders run metrics from the main process.
 */
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('../../../stores/project-store', () => ({
  useProjectStore: (sel: (s: unknown) => unknown) =>
    sel({ getActiveProject: () => ({ id: 'p1' }) }),
}));

import { TaskUsage } from '../TaskUsage';

const getTaskRunMetrics = vi.fn();
const task = { id: 't1', specId: '002-x' } as never;

const tokens = { input: 1234, output: 56, cacheRead: 7, cacheCreation: 8 };
const sample = {
  sessions: [],
  summary: {
    sessionCount: 3,
    durationMs: 184000,
    toolTimeMs: 5000,
    tokens,
    byPhase: [{ key: 'coding', sessions: 3, durationMs: 184000, toolTimeMs: 5000, tokens }],
    byAgent: [{ key: 'coder', sessions: 3, durationMs: 184000, toolTimeMs: 5000, tokens }],
    byTool: [
      { tool: 'Bash', calls: 4, errors: 2, totalMs: 4000 },
      { tool: 'Read', calls: 9, errors: 0, totalMs: 1000 },
    ],
    slowest: [{ tool: 'Bash', ms: 3000, detail: 'npm test', agentType: 'coder', phase: 'coding' }],
  },
};

beforeEach(() => {
  getTaskRunMetrics.mockReset();
  (window as unknown as { electronAPI: unknown }).electronAPI = { getTaskRunMetrics };
});

describe('TaskUsage', () => {
  it('shows the empty state when nothing is recorded', async () => {
    getTaskRunMetrics.mockResolvedValue({ success: true, data: null });
    render(<TaskUsage task={task} />);
    expect(await screen.findByTestId('task-usage-empty')).toBeInTheDocument();
    expect(getTaskRunMetrics).toHaveBeenCalledWith('p1', '002-x');
  });

  it('shows an error state with retry', async () => {
    getTaskRunMetrics.mockResolvedValue({ success: false, error: 'boom' });
    render(<TaskUsage task={task} />);
    expect(await screen.findByTestId('task-usage-error')).toBeInTheDocument();
    expect(screen.getByText('tasks:usage.retry')).toBeInTheDocument();
  });

  it('renders totals and highlights tool errors', async () => {
    getTaskRunMetrics.mockResolvedValue({ success: true, data: sample });
    render(<TaskUsage task={task} />);
    await waitFor(() => expect(screen.getByTestId('task-usage')).toBeInTheDocument());
    expect(screen.getByText('1,234')).toBeInTheDocument();
    expect(screen.getByText('3m 4s', { selector: 'div' })).toBeInTheDocument();
    expect(screen.getByTestId('usage-tool-errors-Bash')).toHaveClass('text-destructive');
    expect(screen.getByTestId('usage-tool-errors-Read')).not.toHaveClass('text-destructive');
    expect(screen.getByTitle('npm test')).toBeInTheDocument();
  });
});
