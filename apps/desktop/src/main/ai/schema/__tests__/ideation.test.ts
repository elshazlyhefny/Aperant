/**
 * Tests for the ideation schema
 */

import { describe, it, expect } from 'vitest';
import { IdeaSchema, validateIdeasData, normalizeIdeaKeys, IDEATION_SCHEMA_HINT } from '../ideation';

const base = {
  id: 'sec-001',
  type: 'security_hardening',
  title: 'Harden input',
  description: 'Validate all input',
  rationale: 'Prevents injection',
};

describe('IdeaSchema', () => {
  it('accepts a valid idea', () => {
    expect(IdeaSchema.safeParse(base).success).toBe(true);
  });

  it('passes non-objects through so Zod reports expected object', () => {
    const result = IdeaSchema.safeParse('nope');
    expect(result.success).toBe(false);
  });
});

describe('validateIdeasData', () => {
  it('validates camelCase and snake_case spellings', () => {
    const data = {
      security_hardening: [
        { ...base, affectedFiles: ['a.ts'] },
        { ...base, id: 'sec-002', affected_files: ['b.ts'], taskId: 't1' },
      ],
    };
    const result = validateIdeasData(data, 'security_hardening');
    expect(result.valid).toBe(true);
    expect(result.ideas).toHaveLength(2);
    expect(result.ideas[0]).toHaveProperty('affected_files');
    expect(result.ideas[1]).toHaveProperty('linked_task_id', 't1');
  });

  it('reports a path-specific error for a missing rationale', () => {
    const { rationale: _r, ...missing } = base;
    const data = { security_hardening: [base, base, missing] };
    const result = validateIdeasData(data, 'security_hardening');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('security_hardening[2]: At "rationale": expected string');
  });

  it('reports a missing description', () => {
    const { description: _d, ...missing } = base;
    const result = validateIdeasData({ security_hardening: [missing] }, 'security_hardening');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('security_hardening[0]: At "description"');
  });

  it('fails an empty-string title', () => {
    const result = validateIdeasData({ security_hardening: [{ ...base, title: '  ' }] }, 'security_hardening');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('At "title"');
  });

  it('ignores ideas of other types', () => {
    const data = {
      ideas: [base, { id: 'x', type: 'code_quality' }],
    };
    const result = validateIdeasData(data, 'security_hardening');
    expect(result.valid).toBe(true);
    expect(result.ideas).toHaveLength(1);
  });

  it('fails on an empty array', () => {
    const result = validateIdeasData({ security_hardening: [] }, 'security_hardening');
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(['no ideas of type security_hardening found']);
  });

  it('fails when only other types are present', () => {
    const result = validateIdeasData({ a: [{ ...base, type: 'other' }] }, 'security_hardening');
    expect(result.valid).toBe(false);
  });

  it('reports non-object items and missing types in an array holding this type', () => {
    const { type: _t, ...noType } = base;
    const result = validateIdeasData({ security_hardening: [base, 'str', noType] }, 'security_hardening');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('security_hardening[1]: expected object');
    expect(result.errors.some((e) => e.startsWith('security_hardening[2]:'))).toBe(true);
  });

  it('rejects a non-object root', () => {
    expect(validateIdeasData([], 'security_hardening').valid).toBe(false);
  });

  it('keeps category-specific fields (passthrough)', () => {
    const result = validateIdeasData(
      { security_hardening: [{ ...base, severity: 'high', metrics: { fooBar: 1 } }] },
      'security_hardening',
    );
    expect(result.ideas[0]).toMatchObject({ severity: 'high', metrics: { fooBar: 1 } });
  });
});

describe('normalizeIdeaKeys', () => {
  it('converts keys to snake_case and taskId to linked_task_id', () => {
    expect(normalizeIdeaKeys({ affectedFiles: [1], taskId: 'T' })).toEqual({
      affected_files: [1],
      linked_task_id: 'T',
    });
  });

  it('lets the snake_case spelling win on conflict', () => {
    expect(normalizeIdeaKeys({ affectedFiles: 'camel', affected_files: 'snake' })).toEqual({
      affected_files: 'snake',
    });
    expect(normalizeIdeaKeys({ taskId: 'a', linked_task_id: 'b' })).toEqual({ linked_task_id: 'b' });
  });

  it('leaves nested values untouched', () => {
    const nested = { someKey: { innerKey: 1 } };
    expect(normalizeIdeaKeys(nested)).toEqual({ some_key: { innerKey: 1 } });
  });
});

describe('IDEATION_SCHEMA_HINT', () => {
  it('mentions the required fields', () => {
    for (const f of ['id', 'type', 'title', 'description', 'rationale']) {
      expect(IDEATION_SCHEMA_HINT).toContain(`"${f}"`);
    }
  });
});
