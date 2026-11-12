import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TerminalProcess } from '../types';

const mockStore = {
  saveSessionsAsync: vi.fn(async (_sessions: Array<{ id: string }>) => {}),
  saveSessionAsync: vi.fn(async () => {}),
  saveSession: vi.fn(),
  flushIfDirtyAsync: vi.fn(async () => {}),
  hasUnsavedChanges: vi.fn(() => false),
};

vi.mock('../../terminal-session-store', () => ({
  getTerminalSessionStore: () => mockStore,
}));

vi.mock('../../ipc-handlers/utils', () => ({
  safeSendToRenderer: vi.fn(),
}));

vi.mock('../../../shared/utils/debug-logger', () => ({
  debugLog: vi.fn(),
  debugError: vi.fn(),
}));

import { persistAllSessionsAsync } from '../session-handler';

const makeTerminal = (id: string, overrides: Partial<TerminalProcess> = {}): TerminalProcess =>
  ({
    id,
    title: `Terminal ${id}`,
    cwd: '/tmp/project',
    projectPath: '/tmp/project',
    isCLIMode: false,
    outputBuffer: '',
    outputSeq: 0,
    ...overrides,
  }) as unknown as TerminalProcess;

const toMap = (...terminals: TerminalProcess[]) => new Map(terminals.map((t) => [t.id, t]));

describe('persistAllSessionsAsync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.hasUnsavedChanges.mockReturnValue(false);
  });

  it('sends changed terminals in a single batched call', async () => {
    const terminals = toMap(makeTerminal('a'), makeTerminal('b'));
    await persistAllSessionsAsync(terminals);

    expect(mockStore.saveSessionsAsync).toHaveBeenCalledTimes(1);
    const sessions = mockStore.saveSessionsAsync.mock.calls[0][0];
    expect(sessions).toHaveLength(2);
  });

  it('does not save again when nothing changed', async () => {
    const terminals = toMap(makeTerminal('a'), makeTerminal('b'));
    await persistAllSessionsAsync(terminals);
    mockStore.saveSessionsAsync.mockClear();

    await persistAllSessionsAsync(terminals);
    expect(mockStore.saveSessionsAsync).not.toHaveBeenCalled();
    expect(mockStore.flushIfDirtyAsync).toHaveBeenCalledTimes(1);
  });

  it('sends only the terminal whose outputSeq changed', async () => {
    const a = makeTerminal('a');
    const b = makeTerminal('b');
    const terminals = toMap(a, b);
    await persistAllSessionsAsync(terminals);
    mockStore.saveSessionsAsync.mockClear();

    a.outputSeq = 1;
    await persistAllSessionsAsync(terminals);

    expect(mockStore.saveSessionsAsync).toHaveBeenCalledTimes(1);
    const sessions = mockStore.saveSessionsAsync.mock.calls[0][0];
    expect(sessions.map((s) => s.id)).toEqual(['a']);
  });

  it('treats title and claudeSessionId changes as dirty', async () => {
    const a = makeTerminal('a');
    const b = makeTerminal('b');
    const terminals = toMap(a, b);
    await persistAllSessionsAsync(terminals);
    mockStore.saveSessionsAsync.mockClear();

    a.title = 'Renamed';
    await persistAllSessionsAsync(terminals);
    expect((mockStore.saveSessionsAsync.mock.calls[0][0]).map((s) => s.id)).toEqual(['a']);
    mockStore.saveSessionsAsync.mockClear();

    b.claudeSessionId = 'session-123';
    await persistAllSessionsAsync(terminals);
    expect((mockStore.saveSessionsAsync.mock.calls[0][0]).map((s) => s.id)).toEqual(['b']);
  });

  it('skips terminals without a projectPath', async () => {
    const terminals = toMap(makeTerminal('a', { projectPath: undefined }), makeTerminal('b'));
    await persistAllSessionsAsync(terminals);

    const sessions = mockStore.saveSessionsAsync.mock.calls[0][0];
    expect(sessions.map((s) => s.id)).toEqual(['b']);
  });

  it('retries on the next cycle when the write left unsaved changes', async () => {
    const terminals = toMap(makeTerminal('a'));
    mockStore.hasUnsavedChanges.mockReturnValue(true);
    await persistAllSessionsAsync(terminals);
    mockStore.saveSessionsAsync.mockClear();

    mockStore.hasUnsavedChanges.mockReturnValue(false);
    await persistAllSessionsAsync(terminals);
    expect(mockStore.saveSessionsAsync).toHaveBeenCalledTimes(1);
  });

  it('force:true sends all terminals even when clean', async () => {
    const terminals = toMap(makeTerminal('a'), makeTerminal('b'));
    await persistAllSessionsAsync(terminals);
    mockStore.saveSessionsAsync.mockClear();

    await persistAllSessionsAsync(terminals, { force: true });
    expect(mockStore.saveSessionsAsync).toHaveBeenCalledTimes(1);
    expect(mockStore.saveSessionsAsync.mock.calls[0][0]).toHaveLength(2);
  });
});
