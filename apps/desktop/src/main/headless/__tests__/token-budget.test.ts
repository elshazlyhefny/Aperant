import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveHeadlessTokenBudget } from '../token-budget';

describe('resolveHeadlessTokenBudget', () => {
  const config = { project: { defaultTokenBudget: 1000 } };
  let specDir: string;

  function writeMetadata(metadata: object): void {
    writeFileSync(path.join(specDir, 'task_metadata.json'), JSON.stringify(metadata));
  }

  beforeEach(() => {
    specDir = mkdtempSync(path.join(os.tmpdir(), 'headless-token-budget-'));
  });

  afterEach(() => {
    rmSync(specDir, { recursive: true, force: true });
  });

  it('is unlimited when there is no metadata or configured default', () => {
    expect(resolveHeadlessTokenBudget(specDir, {})).toStrictEqual({ limit: undefined, source: 'none' });
  });

  it('uses the configured default when the metadata file is missing', () => {
    expect(resolveHeadlessTokenBudget(specDir, config)).toStrictEqual({ limit: 1000, source: 'config' });
  });

  it('uses the configured default when metadata has no token budget', () => {
    writeMetadata({ sourceType: 'manual' });
    expect(resolveHeadlessTokenBudget(specDir, config)).toStrictEqual({ limit: 1000, source: 'config' });
  });

  it('uses the task limit instead of the configured default', () => {
    writeMetadata({ tokenBudget: 500 });
    expect(resolveHeadlessTokenBudget(specDir, config)).toStrictEqual({ limit: 500, source: 'task' });
  });

  it('treats a task limit of zero as an explicit unlimited override', () => {
    writeMetadata({ tokenBudget: 0 });
    expect(resolveHeadlessTokenBudget(specDir, config)).toStrictEqual({ limit: undefined, source: 'task' });
  });

  it('preserves and attributes an explicit scheduled run limit', () => {
    writeMetadata({ sourceType: 'schedule', tokenBudget: 2_000_000 });
    expect(resolveHeadlessTokenBudget(specDir, config)).toStrictEqual({ limit: 2_000_000, source: 'schedule' });
  });

  it('uses the configured default when the metadata cannot be parsed', () => {
    writeFileSync(path.join(specDir, 'task_metadata.json'), '{invalid');
    expect(resolveHeadlessTokenBudget(specDir, config)).toStrictEqual({ limit: 1000, source: 'config' });
  });

  it('ignores an invalid programmatic default', () => {
    expect(resolveHeadlessTokenBudget(specDir, { project: { defaultTokenBudget: -5 } })).toStrictEqual({
      limit: undefined,
      source: 'none'
    });
  });
});
