/**
 * zeenha fork: a failed phase records WHY in task_logs.json. Six tasks failed
 * with only "Failed planning phase" on disk; the reason went to the screen.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskLogWriter, phaseEndMessage } from '../task-log-writer';

describe('phaseEndMessage', () => {
  it('leaves success to the writer default', () => {
    expect(phaseEndMessage('planning', true, 'ignored')).toBeUndefined();
  });

  it('names the reason, in the log phase vocabulary', () => {
    expect(phaseEndMessage('planning', false, 'Claude Code CLI: 429 rate limit')).toBe(
      'Failed planning phase: Claude Code CLI: 429 rate limit',
    );
    expect(phaseEndMessage('qa', false, 'max_iterations')).toBe('Failed validation phase: max_iterations');
    expect(phaseEndMessage('spec', false, 'boom')).toBe('Failed planning phase: boom');
  });

  it('falls back to the bare wording when there is no reason', () => {
    expect(phaseEndMessage('coding', false)).toBe('Failed coding phase');
    expect(phaseEndMessage('coding', false, '   ')).toBe('Failed coding phase');
  });
});

describe('TaskLogWriter.endPhase with a reason', () => {
  it('writes the reason into task_logs.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlw-'));
    const writer = new TaskLogWriter(dir, 'spec-x');
    writer.startPhase('planning');
    writer.endPhase('planning', false, phaseEndMessage('planning', false, 'Plan validation failed after 3 attempts'));
    writer.flush();

    const data = JSON.parse(readFileSync(join(dir, 'task_logs.json'), 'utf8'));
    const last = data.phases.planning.entries.at(-1);
    expect(data.phases.planning.status).toBe('failed');
    expect(last.type).toBe('phase_end');
    expect(last.content).toBe('Failed planning phase: Plan validation failed after 3 attempts');
  });
});
