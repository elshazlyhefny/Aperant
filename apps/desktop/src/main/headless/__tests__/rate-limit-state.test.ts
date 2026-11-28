/**
 * zeenha fork: headless keeps account rate limits in memory and under the
 * project's .auto-claude/, never in the --config file.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_RATE_LIMIT_COOLDOWN_MS } from '../../services/rate-limit-events';
import {
  clearHeadlessRateLimitMemory,
  getHeadlessRateLimitPath,
  readHeadlessRateLimits,
  recordHeadlessRateLimit,
  withHeadlessRateLimits,
} from '../rate-limit-state';
import type { ProviderAccount } from '../../../shared/types/provider-account';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), 'headless-rl-'));
  clearHeadlessRateLimitMemory();
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('headless rate-limit state', () => {
  it('writes the event under .auto-claude/ and reads it back', async () => {
    const now = Date.now();
    const reset = now + 3_600_000;
    await recordHeadlessRateLimit(projectDir, 'acc1', reset, now);

    const file = getHeadlessRateLimitPath(projectDir);
    expect(file).toBe(path.join(projectDir, '.auto-claude', 'headless-rate-limits.json'));
    const onDisk = JSON.parse(readFileSync(file, 'utf-8'));
    expect(onDisk.accounts.acc1[0].resetAt).toBe(new Date(reset).toISOString());

    clearHeadlessRateLimitMemory();
    const limits = readHeadlessRateLimits(projectDir, now);
    expect(limits.acc1[0].resetAt.getTime()).toBe(reset);
    expect(limits.acc1[0].type).toBe('session');
  });

  it('uses the default cooldown when the error named no reset', async () => {
    const now = Date.now();
    const reset = await recordHeadlessRateLimit(projectDir, 'acc1', null, now);
    expect(reset.getTime()).toBe(now + DEFAULT_RATE_LIMIT_COOLDOWN_MS);
  });

  it('drops events whose reset has passed', async () => {
    const now = Date.now();
    await recordHeadlessRateLimit(projectDir, 'acc1', now + 60_000, now);
    expect(readHeadlessRateLimits(projectDir, now + 60_001)).toEqual({});

    await recordHeadlessRateLimit(projectDir, 'acc2', now + 200_000, now + 100_000);
    clearHeadlessRateLimitMemory();
    const onDisk = JSON.parse(readFileSync(getHeadlessRateLimitPath(projectDir), 'utf-8'));
    expect(Object.keys(onDisk.accounts)).toEqual(['acc2']);
  });

  it('keeps the limit in memory when the file cannot be written', async () => {
    // A directory where the file should be makes the atomic rename fail.
    mkdirSync(getHeadlessRateLimitPath(projectDir), { recursive: true });
    const now = Date.now();
    await expect(recordHeadlessRateLimit(projectDir, 'acc1', now + 60_000, now)).resolves.toBeInstanceOf(Date);
    expect(readHeadlessRateLimits(projectDir, now).acc1).toHaveLength(1);
  });

  it('ignores a malformed state file', () => {
    mkdirSync(path.join(projectDir, '.auto-claude'), { recursive: true });
    writeFileSync(getHeadlessRateLimitPath(projectDir), '{not json');
    expect(readHeadlessRateLimits(projectDir)).toEqual({});
  });

  it('attaches events to the matching accounts only, without touching the input', () => {
    const now = Date.now();
    const accounts = [{ id: 'acc1' }, { id: 'acc2' }] as ProviderAccount[];
    const event = { type: 'session' as const, hitAt: new Date(now), resetAt: new Date(now + 1000), resetTimeString: '' };
    const merged = withHeadlessRateLimits(accounts, { acc1: [event] });
    expect(merged[0].rateLimitEvents).toEqual([event]);
    expect(merged[1]).toBe(accounts[1]);
    expect(accounts[0].rateLimitEvents).toBeUndefined();
    expect(existsSync(getHeadlessRateLimitPath(projectDir))).toBe(false);
  });
});
