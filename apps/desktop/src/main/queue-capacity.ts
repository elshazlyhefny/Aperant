/**
 * zeenha fork: account capacity check for the task queue.
 *
 * Before the queue promotes a task it asks whether any account the task can
 * use still has capacity. When every usable account of a provider the task
 * needs is rate limited, the queue waits until the earliest known reset
 * instead of starting the task into the limit (which paused it to Human
 * Review and freed the slot for the next task to hit the same limit).
 *
 * Fail-open: any error means "ok", so a broken check never stalls the queue.
 */

import type { ClaudeAutoSwitchSettings, ProfileUsageSummary, Task } from '../shared/types';
import type { ProviderAccount } from '../shared/types/provider-account';
import type { CapacityCheckResult } from './task-queue-manager';
import { scoreProviderAccount } from './claude-profile/profile-scorer';
import { getKeyStatus } from '../shared/utils/api-key-status';

export interface CapacityInputs {
  accounts: ProviderAccount[];
  autoSwitch: ClaudeAutoSwitchSettings;
  /** Recorded rate limit of a Claude profile (ClaudeProfileManager.isProfileRateLimited). */
  profileLimit: (profileId: string) => { limited: boolean; resetAt?: Date };
  /** Cached usage summaries; never fetched for this check. */
  usage: ProfileUsageSummary[];
  now: number;
}

type AccountCapacity = { usable: true } | { usable: false; limited: boolean; resetAt?: number };

function toMs(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

/** Providers a task's phases are routed to, or null when it can use any account in the global queue. */
export function taskProviders(task: Task): string[] | null {
  const metadata = task.metadata;
  const routed = Object.values(metadata?.phaseProviders ?? {}).filter((p): p is string => !!p);
  if (routed.length === 0) return null;
  // A phase without its own assignment falls back to the task's provider (phase-connection.ts).
  if (metadata?.provider) routed.push(metadata.provider);
  return [...new Set(routed)];
}

function summaryReset(summary: ProfileUsageSummary): number | undefined {
  const weekly = summary.rateLimitType === 'weekly' ||
    (summary.rateLimitType === undefined && summary.weeklyPercent >= summary.sessionPercent);
  return toMs(weekly ? summary.weeklyResetTimestamp : summary.sessionResetTimestamp);
}

function accountCapacity(account: ProviderAccount, inputs: CapacityInputs): AccountCapacity {
  const { now } = inputs;
  // A rejected key is an auth problem, not capacity; the task fails on its own.
  if (account.authType === 'api-key' && getKeyStatus(account) === 'rejected') {
    return { usable: false, limited: false };
  }
  const score = scoreProviderAccount(account, inputs.autoSwitch);
  // Pay-per-use keys have no usage window to wait for.
  if (account.billingModel === 'pay-per-use') return { usable: true };

  let limited = !score.available;
  const resets: number[] = [];
  for (const event of account.rateLimitEvents ?? []) {
    const reset = toMs(event.resetAt);
    if (reset && reset > now) resets.push(reset);
  }

  if (account.claudeProfileId) {
    const profile = inputs.profileLimit(account.claudeProfileId);
    if (profile.limited) {
      limited = true;
      const reset = toMs(profile.resetAt);
      if (reset && reset > now) resets.push(reset);
    }
  }

  const summary = inputs.usage.find((u) => u.profileId === (account.claudeProfileId ?? account.id));
  if (summary?.isRateLimited) {
    const reset = summaryReset(summary);
    // A reset already in the past means the summary is stale.
    if (reset === undefined || reset > now) {
      limited = true;
      if (reset) resets.push(reset);
    }
  }

  if (!limited) return { usable: true };
  // Usable again only once every limit on it has lifted.
  return { usable: false, limited: true, ...(resets.length ? { resetAt: Math.max(...resets) } : {}) };
}

/** Pure capacity decision for one task. */
export function evaluateCapacity(task: Task, inputs: CapacityInputs): CapacityCheckResult {
  const providers = taskProviders(task);
  const groups: Array<{ label: string; accounts: ProviderAccount[] }> = providers
    ? providers.map((provider) => ({ label: provider, accounts: inputs.accounts.filter((a) => a.provider === provider) }))
    : [{ label: '', accounts: inputs.accounts }];

  const blocked: Array<{ label: string; retryAt?: number }> = [];
  for (const group of groups) {
    // No configured account: the legacy resolver path decides, not this gate.
    if (group.accounts.length === 0) continue;
    const states = group.accounts.map((a) => accountCapacity(a, inputs));
    if (states.some((s) => s.usable)) continue;
    const limited = states.filter((s): s is Extract<AccountCapacity, { usable: false }> => !s.usable && s.limited);
    if (limited.length === 0) continue;
    const resets = limited.map((s) => s.resetAt).filter((r): r is number => r !== undefined);
    // Any one account coming back is enough for this provider.
    blocked.push({ label: group.label, ...(resets.length ? { retryAt: Math.min(...resets) } : {}) });
  }

  if (blocked.length === 0) return { ok: true };
  // The task needs every blocked provider, so it waits for the last of them.
  const retryAt = blocked.every((b) => b.retryAt !== undefined)
    ? Math.max(...blocked.map((b) => b.retryAt as number))
    : undefined;
  const names = blocked.map((b) => b.label).filter(Boolean);
  const reason = names.length
    ? `All ${names.join(' and ')} accounts are rate limited`
    : 'All accounts are rate limited';
  return { ok: false, reason, ...(retryAt ? { retryAt } : {}) };
}

/**
 * Desktop capacity check wired into the task queue. Reads settings and cached
 * usage only (no network). Any error returns ok.
 */
export async function checkTaskCapacity(
  task: Task,
  load: () => Promise<Omit<CapacityInputs, 'now'>> | Omit<CapacityInputs, 'now'>
): Promise<CapacityCheckResult> {
  try {
    const inputs = await load();
    if (inputs.accounts.length === 0) return { ok: true };
    return evaluateCapacity(task, { ...inputs, now: Date.now() });
  } catch {
    return { ok: true };
  }
}
