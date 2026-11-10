import { describe, it, expect } from 'vitest';
import { budgetTokens, budgetPercent, parseTokenBudget, resolveTokenBudget } from '../token-budget';

describe('budgetTokens', () => {
  it('does not double count cache read/creation', () => {
    expect(budgetTokens({ input: 100, output: 50, cacheRead: 80, cacheCreation: 20 })).toBe(150);
  });
});

describe('parseTokenBudget', () => {
  it('accepts positive integers', () => {
    expect(parseTokenBudget(1000)).toBe(1000);
  });
  it.each([0, -5, NaN, Infinity, '1000', null, undefined, {}])('rejects %s', (v) => {
    expect(parseTokenBudget(v)).toBeUndefined();
  });
});

describe('resolveTokenBudget', () => {
  it('task override beats project', () => {
    expect(resolveTokenBudget({ tokenBudget: 500 }, { tokenBudget: 1000 })).toBe(500);
  });
  it('task 0 means unlimited over a project limit', () => {
    expect(resolveTokenBudget({ tokenBudget: 0 }, { tokenBudget: 1000 })).toBeUndefined();
  });
  it('falls back to project when task is unset', () => {
    expect(resolveTokenBudget({}, { tokenBudget: 1000 })).toBe(1000);
  });
  it('invalid values mean no budget', () => {
    expect(resolveTokenBudget({ tokenBudget: -1 }, { tokenBudget: 1000 })).toBeUndefined();
    expect(resolveTokenBudget({ tokenBudget: NaN }, undefined)).toBeUndefined();
    expect(resolveTokenBudget(undefined, { tokenBudget: '5' as unknown as number })).toBeUndefined();
    expect(resolveTokenBudget(undefined, { tokenBudget: -3 })).toBeUndefined();
  });
  it('undefined everywhere means no budget', () => {
    expect(resolveTokenBudget()).toBeUndefined();
    expect(resolveTokenBudget({}, {})).toBeUndefined();
  });
});

describe('budgetPercent', () => {
  it('computes percent', () => {
    expect(budgetPercent(50, 200)).toBe(25);
  });
  it('is 0 without a limit', () => {
    expect(budgetPercent(50, undefined)).toBe(0);
    expect(budgetPercent(50, 0)).toBe(0);
  });
});
