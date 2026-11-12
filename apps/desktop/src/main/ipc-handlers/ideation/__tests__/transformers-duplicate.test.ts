import { describe, expect, it } from 'vitest';

import { transformIdeaFromSnakeCase } from '../transformers';
import type { RawIdea } from '../types';

const base = {
  id: 'idea-1',
  type: 'code_improvements',
  title: 'T',
  description: 'd',
  rationale: 'r'
} as RawIdea;

describe('transformIdeaFromSnakeCase possibleDuplicateOf', () => {
  it('maps a valid possible_duplicate_of', () => {
    const out = transformIdeaFromSnakeCase({
      ...base,
      possible_duplicate_of: { kind: 'task', id: '001-x', score: 0.82, title: 'X' }
    });
    expect(out.possibleDuplicateOf).toEqual({ kind: 'task', id: '001-x', score: 0.82, title: 'X' });
  });

  it('accepts the camelCase spelling and an absent title', () => {
    const out = transformIdeaFromSnakeCase({
      ...base,
      possibleDuplicateOf: { kind: 'idea', id: 'idea-0', score: 0.7 }
    });
    expect(out.possibleDuplicateOf).toEqual({ kind: 'idea', id: 'idea-0', score: 0.7 });
  });

  it('drops malformed values', () => {
    const bad: unknown[] = [
      'x',
      [],
      { kind: 'other', id: 'a', score: 1 },
      { kind: 'task', id: '', score: 1 },
      { kind: 'task', id: 'a', score: Number.NaN },
      { kind: 'task', id: 'a', score: '1' }
    ];
    for (const value of bad) {
      const out = transformIdeaFromSnakeCase({ ...base, possible_duplicate_of: value });
      expect(out).not.toHaveProperty('possibleDuplicateOf');
    }
  });

  it('ignores a non-string title', () => {
    const out = transformIdeaFromSnakeCase({
      ...base,
      possible_duplicate_of: { kind: 'task', id: 'a', score: 0.5, title: 3 }
    });
    expect(out.possibleDuplicateOf).toEqual({ kind: 'task', id: 'a', score: 0.5 });
  });

  it('has no key when the field is absent', () => {
    expect(transformIdeaFromSnakeCase(base)).not.toHaveProperty('possibleDuplicateOf');
  });
});
