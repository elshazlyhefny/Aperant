import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getMaxParallelTasks, useTaskQueueStore } from '../task-queue-store';

const state = (projectId: string, max: number) => ({
  projectId,
  maxParallelTasks: max,
  inProgressCount: 0,
  queuedTaskIds: [],
  skippedTaskIds: [],
});

describe('task-queue-store', () => {
  beforeEach(() => {
    useTaskQueueStore.setState({ statesByProject: {} });
    (globalThis as Record<string, unknown>).window = {
      electronAPI: { getTaskQueueState: vi.fn() },
    };
  });

  it('keys state by project', () => {
    useTaskQueueStore.getState().setState(state('a', 5));
    useTaskQueueStore.getState().setState(state('b', 2));
    expect(getMaxParallelTasks('a')).toBe(5);
    expect(getMaxParallelTasks('b')).toBe(2);
  });

  it('falls back to default before state arrives', () => {
    expect(getMaxParallelTasks('none')).toBe(3);
  });

  it('loadState stores a successful result', async () => {
    const api = (globalThis as unknown as { window: { electronAPI: { getTaskQueueState: ReturnType<typeof vi.fn> } } }).window.electronAPI;
    api.getTaskQueueState.mockResolvedValue({ success: true, data: state('a', 7) });
    await useTaskQueueStore.getState().loadState('a');
    expect(getMaxParallelTasks('a')).toBe(7);
  });

  it('loadState ignores failures', async () => {
    const api = (globalThis as unknown as { window: { electronAPI: { getTaskQueueState: ReturnType<typeof vi.fn> } } }).window.electronAPI;
    api.getTaskQueueState.mockResolvedValue({ success: false, error: 'x' });
    await useTaskQueueStore.getState().loadState('a');
    expect(useTaskQueueStore.getState().statesByProject.a).toBeUndefined();
  });
});
