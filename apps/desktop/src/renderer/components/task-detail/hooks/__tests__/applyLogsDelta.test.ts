import { describe, it, expect } from 'vitest';
import type { TaskLogs, TaskLogEntry, TaskLogsDelta } from '../../../../../shared/types';
import { applyLogsDelta } from '../applyLogsDelta';

const entry = (content: string): TaskLogEntry => ({
  timestamp: '2026-01-01T00:00:00Z',
  type: 'text',
  content,
  phase: 'coding'
} as TaskLogEntry);

const makeLogs = (): TaskLogs => ({
  spec_id: '001',
  created_at: 't0',
  updated_at: 't1',
  phases: {
    planning: { phase: 'planning', status: 'completed', started_at: 'a', completed_at: 'b', entries: [entry('p1')] },
    coding: { phase: 'coding', status: 'active', started_at: 'c', completed_at: null, entries: [entry('c1'), entry('c2')] },
    validation: { phase: 'validation', status: 'pending', started_at: null, completed_at: null, entries: [] }
  }
});

describe('applyLogsDelta', () => {
  it('appends to one phase and leaves others referentially equal', () => {
    const prev = makeLogs();
    const delta: TaskLogsDelta = {
      spec_id: '001',
      updated_at: 't2',
      phases: {
        coding: { status: 'active', started_at: 'c', completed_at: null, baseCount: 2, entries: [entry('c3')] }
      }
    };
    const next = applyLogsDelta(prev, delta);
    expect(next).not.toBeNull();
    expect(next?.phases.coding.entries.map(e => e.content)).toEqual(['c1', 'c2', 'c3']);
    expect(next?.phases.planning).toBe(prev.phases.planning);
    expect(next?.phases.validation).toBe(prev.phases.validation);
    expect(next?.updated_at).toBe('t2');
    expect(prev.phases.coding.entries).toHaveLength(2);
  });

  it('applies a status-only delta', () => {
    const prev = makeLogs();
    const delta: TaskLogsDelta = {
      spec_id: '001',
      updated_at: 't2',
      phases: {
        coding: { status: 'completed', started_at: 'c', completed_at: 'd', baseCount: 2, entries: [] }
      }
    };
    const next = applyLogsDelta(prev, delta);
    expect(next?.phases.coding.status).toBe('completed');
    expect(next?.phases.coding.completed_at).toBe('d');
    expect(next?.phases.coding.entries).toHaveLength(2);
    expect(next?.phases.planning).toBe(prev.phases.planning);
  });

  it('returns null on baseCount mismatch', () => {
    const delta: TaskLogsDelta = {
      spec_id: '001',
      updated_at: 't2',
      phases: {
        coding: { status: 'active', started_at: 'c', completed_at: null, baseCount: 5, entries: [entry('x')] }
      }
    };
    expect(applyLogsDelta(makeLogs(), delta)).toBeNull();
  });

  it('returns null when prev is null', () => {
    expect(applyLogsDelta(null, { spec_id: '001', updated_at: 't2', phases: {} })).toBeNull();
  });
});
