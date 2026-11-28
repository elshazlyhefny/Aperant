/**
 * zeenha fork: account rate limits for headless runs.
 *
 * Headless reads its provider accounts from the user's --config file, which it
 * never writes. A rate limit an agent session hits is kept here instead: in
 * memory (so the daemon skips the account even if the disk write fails) and in
 * `<project>/.auto-claude/headless-rate-limits.json` (so the next `run` or
 * daemon restart skips it too). auth.ts merges the events onto the configured
 * accounts, so scoreProviderAccount treats an account as unavailable until its
 * recorded reset, exactly as the desktop app does with settings.json.
 *
 * Electron-free on purpose. Never throws from the recorder: it runs inside
 * agent result handling.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { ClaudeRateLimitEvent } from '../../shared/types';
import type { ProviderAccount } from '../../shared/types/provider-account';
import { rateLimitEventResetMs, rateLimitResetDate, withRateLimitEvent } from '../services/rate-limit-events';
import { writeFileAtomicSync } from '../utils/atomic-file';
import { withFileLock } from '../utils/file-lock';
import { AUTO_BUILD_PATH } from './shared';

/** accountId -> events whose reset is still ahead. */
export type HeadlessRateLimits = Record<string, ClaudeRateLimitEvent[]>;

const FILE_NAME = 'headless-rate-limits.json';

/** In-process copy per state file, merged with the file on every read. */
const memory = new Map<string, HeadlessRateLimits>();

export function getHeadlessRateLimitPath(projectPath: string): string {
  return path.join(projectPath, AUTO_BUILD_PATH, FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toEvent(value: unknown): ClaudeRateLimitEvent | null {
  if (!isRecord(value)) return null;
  const resetAt = new Date(value.resetAt as string);
  if (Number.isNaN(resetAt.getTime())) return null;
  const hitAt = new Date(value.hitAt as string);
  return {
    type: value.type === 'weekly' ? 'weekly' : 'session',
    hitAt: Number.isNaN(hitAt.getTime()) ? resetAt : hitAt,
    resetAt,
    resetTimeString: typeof value.resetTimeString === 'string' ? value.resetTimeString : resetAt.toISOString(),
  };
}

function readFile(file: string): HeadlessRateLimits {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
  const accounts = isRecord(raw) && isRecord(raw.accounts) ? raw.accounts : {};
  const limits: HeadlessRateLimits = {};
  for (const [id, events] of Object.entries(accounts)) {
    if (!Array.isArray(events)) continue;
    const parsed = events.map(toEvent).filter((e): e is ClaudeRateLimitEvent => e !== null);
    if (parsed.length) limits[id] = parsed;
  }
  return limits;
}

/** File and memory merged, keeping only events whose reset is still ahead. */
export function readHeadlessRateLimits(projectPath: string, now: number = Date.now()): HeadlessRateLimits {
  const file = getHeadlessRateLimitPath(projectPath);
  const merged: HeadlessRateLimits = {};
  for (const source of [readFile(file), memory.get(file) ?? {}]) {
    for (const [id, events] of Object.entries(source)) {
      const seen = new Set((merged[id] ?? []).map((e) => rateLimitEventResetMs(e)));
      const fresh = events.filter((e) => rateLimitEventResetMs(e) > now && !seen.has(rateLimitEventResetMs(e)));
      if (fresh.length) merged[id] = [...(merged[id] ?? []), ...fresh];
    }
  }
  return merged;
}

/**
 * Record a rate limit for an account (resetAt in ms, or null when the error
 * named no reset: the default cooldown then applies). Returns the reset used.
 */
export async function recordHeadlessRateLimit(
  projectPath: string,
  accountId: string,
  resetAt: number | null,
  now: number = Date.now(),
): Promise<Date> {
  const reset = rateLimitResetDate(resetAt, now);
  const file = getHeadlessRateLimitPath(projectPath);
  try {
    await withFileLock(file, async () => {
      const limits = readHeadlessRateLimits(projectPath, now);
      limits[accountId] = withRateLimitEvent(limits[accountId], reset, now);
      memory.set(file, limits);
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileAtomicSync(file, JSON.stringify({ accounts: limits }, null, 2));
      } catch {
        // The in-memory copy still keeps this process off the account.
      }
    });
  } catch {
    // Never throw into agent result handling.
  }
  return reset;
}

/** The configured accounts with their recorded headless rate limits attached. */
export function withHeadlessRateLimits(
  accounts: ProviderAccount[] | undefined,
  limits: HeadlessRateLimits,
): ProviderAccount[] {
  return (accounts ?? []).map((account) => {
    const events = limits[account.id];
    if (!events?.length) return account;
    return { ...account, rateLimitEvents: [...events, ...(account.rateLimitEvents ?? [])] };
  });
}

/** Test-only: forget the in-memory copies. */
export function clearHeadlessRateLimitMemory(): void {
  memory.clear();
}
