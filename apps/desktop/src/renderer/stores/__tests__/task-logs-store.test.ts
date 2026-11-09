import { describe, it, expect, beforeEach } from 'vitest';
import { useTaskLogsStore, selectTaskLogs, MAX_LOG_ENTRIES } from '../task-logs-store';

describe('task-logs-store', () => {
  beforeEach(() => {
    useTaskLogsStore.setState({ logsByTaskId: {} });
  });

  it('caps logs at MAX_LOG_ENTRIES keeping the newest in order', () => {
    const lines = Array.from({ length: 5100 }, (_, i) => `line ${i}`);
    useTaskLogsStore.getState().appendLogs('t1', lines);

    const stored = useTaskLogsStore.getState().logsByTaskId.t1;
    expect(stored).toHaveLength(MAX_LOG_ENTRIES);
    expect(stored[0]).toBe('line 100');
    expect(stored[stored.length - 1]).toBe('line 5099');
  });

  it('treats an empty append as a no-op', () => {
    const before = useTaskLogsStore.getState();
    useTaskLogsStore.getState().appendLogs('t1', []);
    expect(useTaskLogsStore.getState()).toBe(before);
  });

  it('clearLogs removes only the given ids, or everything with no argument', () => {
    const s = useTaskLogsStore.getState();
    s.appendLogs('a', ['1']);
    s.appendLogs('b', ['2']);
    s.appendLogs('c', ['3']);

    s.clearLogs(['a']);
    expect(Object.keys(useTaskLogsStore.getState().logsByTaskId).sort()).toEqual(['b', 'c']);

    const before = useTaskLogsStore.getState();
    s.clearLogs(['missing']);
    expect(useTaskLogsStore.getState()).toBe(before);

    s.clearLogs();
    expect(useTaskLogsStore.getState().logsByTaskId).toEqual({});
  });

  it('clearAllLogs empties the store and is a no-op when already empty', () => {
    useTaskLogsStore.getState().appendLogs('a', ['1']);
    useTaskLogsStore.getState().clearAllLogs();
    expect(useTaskLogsStore.getState().logsByTaskId).toEqual({});

    const before = useTaskLogsStore.getState();
    useTaskLogsStore.getState().clearAllLogs();
    expect(useTaskLogsStore.getState()).toBe(before);
  });

  it('pruneLogs drops buckets not in the keep set', () => {
    const s = useTaskLogsStore.getState();
    s.appendLogs('a', ['1']);
    s.appendLogs('b', ['2']);

    s.pruneLogs(new Set(['a']));

    expect(Object.keys(useTaskLogsStore.getState().logsByTaskId)).toEqual(['a']);
  });

  it('selector returns the same frozen empty array for unknown ids', () => {
    const first = selectTaskLogs('unknown')(useTaskLogsStore.getState());
    const second = selectTaskLogs('other')(useTaskLogsStore.getState());
    expect(first).toBe(second);
    expect(first).toHaveLength(0);
    expect(Object.isFrozen(first)).toBe(true);
  });
});
