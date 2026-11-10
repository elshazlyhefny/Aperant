/**
 * @vitest-environment jsdom
 *
 * zeenha fork: dependency picker adds/removes dependencies and shows the
 * cycle message before saving.
 */
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) => (opts?.title ? `${key}:${opts.title}` : opts?.path ? `${key}:${opts.path}` : key),
    i18n: { language: 'en' },
  }),
}));

import { TaskDependencyPicker } from '../TaskDependencyPicker';
import type { Task } from '../../../../shared/types';

function mk(id: string, title: string, deps?: string[]): Task {
  return {
    id,
    specId: `spec-${id}`,
    projectId: 'p',
    title,
    description: '',
    status: 'backlog',
    subtasks: [],
    logs: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: deps ? { taskDependencies: deps } : undefined,
  } as Task;
}

function Harness({ tasks, excludeTaskId }: { tasks: Task[]; excludeTaskId?: string }) {
  const [value, setValue] = useState<string[]>([]);
  return <TaskDependencyPicker value={value} onChange={setValue} tasks={tasks} excludeTaskId={excludeTaskId} />;
}

describe('TaskDependencyPicker', () => {
  it('adds and removes a dependency', () => {
    render(<Harness tasks={[mk('a', 'Alpha'), mk('b', 'Beta')]} excludeTaskId="a" />);
    expect(screen.queryByLabelText('tasks:dependencies.add:Alpha')).toBeNull();
    fireEvent.click(screen.getByLabelText('tasks:dependencies.add:Beta'));
    expect(screen.getByLabelText('tasks:dependencies.remove:Beta')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('tasks:dependencies.remove:Beta'));
    expect(screen.getByText('tasks:dependencies.none')).toBeInTheDocument();
  });

  it('shows the cycle message and does not add', () => {
    render(<Harness tasks={[mk('a', 'Alpha'), mk('b', 'Beta', ['a'])]} excludeTaskId="a" />);
    fireEvent.click(screen.getByLabelText('tasks:dependencies.add:Beta'));
    expect(screen.getByRole('alert')).toHaveTextContent('tasks:dependencies.cycleError');
    expect(screen.getByText('tasks:dependencies.none')).toBeInTheDocument();
  });
});
