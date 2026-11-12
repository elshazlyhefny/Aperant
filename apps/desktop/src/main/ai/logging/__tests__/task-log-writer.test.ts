import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const writeSpy = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      writeSpy(...args);
      return actual.writeFileSync(...args);
    },
  };
});

import { TaskLogWriter } from '../task-log-writer';
import type { StreamEvent } from '../../session/types';

function toolCall(i: number): StreamEvent {
  return { type: 'tool-call', toolName: 'Read', toolCallId: `c${i}`, args: { file_path: `/f${i}` } } as StreamEvent;
}
function toolResult(i: number): StreamEvent {
  return { type: 'tool-result', toolName: 'Read', toolCallId: `c${i}`, args: {}, result: 'ok', isError: false, durationMs: 1 } as StreamEvent;
}

describe('TaskLogWriter coalesced saves', () => {
  let dir: string;
  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'tlw-coalesce-'));
    writeSpy.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces tool events into one write', () => {
    const w = new TaskLogWriter(dir, 's');
    for (let i = 0; i < 5; i++) {
      w.processEvent(toolCall(i), 'coding');
      w.processEvent(toolResult(i), 'coding');
    }
    expect(writeSpy).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(600);
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it('writes immediately for startPhase, endPhase, flush and error', () => {
    const w = new TaskLogWriter(dir, 's');
    w.startPhase('coding');
    expect(writeSpy).toHaveBeenCalledTimes(1);
    w.processEvent({ type: 'error', error: { message: 'x' } } as unknown as StreamEvent, 'coding');
    expect(writeSpy).toHaveBeenCalledTimes(2);
    w.endPhase('coding', true);
    expect(writeSpy).toHaveBeenCalledTimes(3);
    w.flush();
    expect(writeSpy).toHaveBeenCalledTimes(4);
  });

  it('writes compact JSON that parses back with all entries', () => {
    const w = new TaskLogWriter(dir, 's');
    for (let i = 0; i < 10; i++) w.processEvent(toolCall(i), 'coding');
    vi.advanceTimersByTime(600);
    const raw = readFileSync(join(dir, 'task_logs.json'), 'utf8');
    expect(raw).not.toContain('\n  ');
    expect(JSON.parse(raw).phases.coding.entries).toHaveLength(10);
  });

  it('flush cancels a pending timer and writes once', () => {
    const w = new TaskLogWriter(dir, 's');
    w.processEvent(toolCall(1), 'coding');
    w.flush();
    expect(writeSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });
});
