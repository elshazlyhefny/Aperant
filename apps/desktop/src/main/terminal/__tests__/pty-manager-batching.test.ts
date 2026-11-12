import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@lydell/node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../ipc-handlers/utils', () => ({ safeSendToRenderer: vi.fn() }));
vi.mock('../../claude-profile-manager', () => ({ getClaudeProfileManager: vi.fn() }));
vi.mock('../../settings-utils', () => ({ readSettingsFile: vi.fn(() => ({})) }));
vi.mock('../../../shared/utils/debug-logger', () => ({ debugLog: vi.fn(), debugError: vi.fn() }));

import { setupPtyHandlers, setShuttingDown, OUTPUT_FLUSH_INTERVAL_MS } from '../pty-manager';
import { TerminalOutputBuffer } from '../output-buffer';
import { safeSendToRenderer } from '../../ipc-handlers/utils';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { TerminalProcess } from '../types';

function setup() {
  let dataCb: (d: string) => void = () => {};
  let exitCb: (e: { exitCode: number }) => void = () => {};
  const ptyMock = {
    onData: (cb: (d: string) => void) => { dataCb = cb; },
    onExit: (cb: (e: { exitCode: number }) => void) => { exitCb = cb; },
  };
  const terminal = {
    id: 't1',
    pty: ptyMock,
    outputBuffer: '',
    outputStore: new TerminalOutputBuffer(),
    pendingOutput: [],
    pendingOutputLength: 0,
  } as unknown as TerminalProcess;
  const terminals = new Map([['t1', terminal]]);
  const onData = vi.fn();
  setupPtyHandlers(terminal, terminals, () => null, onData, vi.fn());
  return { terminal, onData, emit: (d: string) => dataCb(d), exit: (c = 0) => exitCb({ exitCode: c }) };
}

describe('PTY output batching', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    setShuttingDown(false);
  });
  afterEach(() => {
    setShuttingDown(false);
    vi.useRealTimers();
  });

  it('joins many small chunks within one interval into one send, in order', () => {
    const { emit, terminal } = setup();
    emit('a'); emit('b'); emit('c');
    expect(safeSendToRenderer).not.toHaveBeenCalled();
    vi.advanceTimersByTime(OUTPUT_FLUSH_INTERVAL_MS);
    expect(safeSendToRenderer).toHaveBeenCalledTimes(1);
    expect(safeSendToRenderer).toHaveBeenCalledWith(expect.anything(), IPC_CHANNELS.TERMINAL_OUTPUT, 't1', 'abc');
    expect(terminal.outputStore?.toString()).toBe('abc');
  });

  it('flushes immediately when a burst exceeds 64 KB', () => {
    const { emit } = setup();
    emit('x'.repeat(70 * 1024));
    expect(safeSendToRenderer).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(safeSendToRenderer).toHaveBeenCalledTimes(1);
  });

  it('flushes pending output before TERMINAL_EXIT', () => {
    const { emit, exit } = setup();
    emit('tail');
    exit(3);
    const calls = vi.mocked(safeSendToRenderer).mock.calls;
    expect(calls[0][1]).toBe(IPC_CHANNELS.TERMINAL_OUTPUT);
    expect(calls[0][3]).toBe('tail');
    expect(calls[1][1]).toBe(IPC_CHANNELS.TERMINAL_EXIT);
    expect(calls[1][3]).toBe(3);
  });

  it('calls onDataCallback once per raw chunk', () => {
    const { emit, onData } = setup();
    emit('a'); emit('b'); emit('c');
    expect(onData).toHaveBeenCalledTimes(3);
    expect(onData.mock.calls.map((c) => c[1])).toEqual(['a', 'b', 'c']);
  });

  it('sends nothing after setShuttingDown(true)', () => {
    const { emit, exit } = setup();
    emit('a');
    setShuttingDown(true);
    vi.advanceTimersByTime(100);
    emit('b');
    exit();
    expect(safeSendToRenderer).not.toHaveBeenCalled();
  });
});
