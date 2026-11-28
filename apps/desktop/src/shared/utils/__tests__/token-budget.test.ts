import { describe, it, expect } from 'vitest';
import { budgetTokens, budgetPercent, parseTokenBudget, resolveTokenBudget } from '../token-budget';

describe('budgetTokens', () => {
  it('counts cache reads at a tenth and cache creation inside input', () => {
    // (100 - 80) + 50 + 80 * 0.1 = 78
    expect(budgetTokens({ input: 100, output: 50, cacheRead: 80, cacheCreation: 20 })).toBe(78);
  });
  it('is input + output without cache reads', () => {
    expect(budgetTokens({ input: 100, output: 50 })).toBe(150);
  });
  it('weights a cache-heavy session far below its raw total', () => {
    expect(budgetTokens({ input: 1_000_000, output: 20_000, cacheRead: 900_000 })).toBe(210_000);
  });
  it('never goes negative and ignores invalid fields', () => {
    expect(budgetTokens({ input: 10, output: 0, cacheRead: 50 })).toBe(5);
    expect(budgetTokens({ input: -5, output: -1 })).toBe(0);
    expect(budgetTokens({ input: undefined as unknown as number, output: 7, cacheRead: Number.NaN })).toBe(7);
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
