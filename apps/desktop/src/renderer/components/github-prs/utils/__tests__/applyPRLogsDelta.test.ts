import { describe, it, expect } from 'vitest';
import type { PRLogs, PRLogEntry, PRLogsDelta } from '../../../../../preload/api/modules/github-api';
import { applyPRLogsDelta } from '../applyPRLogsDelta';

const entry = (content: string): PRLogEntry => ({
  timestamp: '2026-01-01T00:00:00Z',
  type: 'text',
  content,
  phase: 'analysis'
} as PRLogEntry);

const makeLogs = (): PRLogs => ({
  pr_number: 7,
  repo: 'o/r',
  created_at: 't0',
  updated_at: 't1',
  is_followup: false,
  phases: {
    context: { phase: 'context', status: 'completed', started_at: 'a', completed_at: 'b', entries: [entry('x1')] },
    analysis: { phase: 'analysis', status: 'active', started_at: 'c', completed_at: null, entries: [entry('a1'), entry('a2')] },
    synthesis: { phase: 'synthesis', status: 'pending', started_at: null, completed_at: null, entries: [] }
  }
});

const makeDelta = (over: Partial<PRLogsDelta> = {}): PRLogsDelta => ({
  pr_number: 7,
  created_at: 't0',
  updated_at: 't2',
  phases: {
    analysis: { status: 'active', started_at: 'c', completed_at: null, baseCount: 2, entries: [entry('a3')] }
  },
  ...over
});

describe('applyPRLogsDelta', () => {
  it('appends to one phase and leaves others referentially equal', () => {
    const prev = makeLogs();
    const next = applyPRLogsDelta(prev, makeDelta());
    expect(next?.phases.analysis.entries.map(e => e.content)).toEqual(['a1', 'a2', 'a3']);
    expect(next?.phases.context).toBe(prev.phases.context);
    expect(next?.phases.synthesis).toBe(prev.phases.synthesis);
    expect(next?.updated_at).toBe('t2');
    expect(prev.phases.analysis.entries).toHaveLength(2);
  });

  it('applies a status-only delta and keeps the entries array', () => {
    const prev = makeLogs();
    const next = applyPRLogsDelta(prev, makeDelta({
      phases: { analysis: { status: 'completed', started_at: 'c', completed_at: 'd', baseCount: 2, entries: [] } }
    }));
    expect(next?.phases.analysis.status).toBe('completed');
    expect(next?.phases.analysis.completed_at).toBe('d');
    expect(next?.phases.analysis.entries).toBe(prev.phases.analysis.entries);
  });

  it('returns null on baseCount mismatch', () => {
    const delta = makeDelta({
      phases: { analysis: { status: 'active', started_at: 'c', completed_at: null, baseCount: 5, entries: [entry('x')] } }
    });
    expect(applyPRLogsDelta(makeLogs(), delta)).toBeNull();
  });

  it('returns null when prev is null', () => {
    expect(applyPRLogsDelta(null, makeDelta())).toBeNull();
  });

  it('returns null on created_at mismatch', () => {
    expect(applyPRLogsDelta(makeLogs(), makeDelta({ created_at: 'other' }))).toBeNull();
  });

  it('returns null on pr_number mismatch', () => {
    expect(applyPRLogsDelta(makeLogs(), makeDelta({ pr_number: 8 }))).toBeNull();
  });
});
