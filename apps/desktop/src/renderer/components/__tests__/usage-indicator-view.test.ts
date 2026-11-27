import { describe, expect, it } from 'vitest';
import type { ClaudeUsageSnapshot } from '../../../shared/types/agent';
import { getQueuedRowVariant, selectUsageView, type UsageView } from '../usage-indicator-view';

const usage: ClaudeUsageSnapshot = {
  profileId: 'active-profile',
  profileName: 'Active profile',
  fetchedAt: new Date('2026-01-01T00:00:00Z'),
  sessionPercent: 42,
  weeklyPercent: 73,
};

const availableInput = {
  isLoading: false,
  hasUsageMonitoring: true,
  hasSubscriptionLimits: true,
  isAvailable: true,
  usage,
  activeProfileNeedsReauth: false,
};

const monitoredView = {
  kind: 'monitored',
  usage,
  needsReauth: false,
  sessionPercent: 42,
  weeklyPercent: 73,
  creditUsage: undefined,
  creditLimit: null,
  creditPercent: 0,
  maxUsage: 73,
} satisfies UsageView;

describe('selectUsageView', () => {
  it('prioritizes loading for monitored accounts even if a snapshot is available', () => {
    expect(selectUsageView({ ...availableInput, isLoading: true })).toEqual({ kind: 'loading' });
  });

  it.each([
    { hasSubscriptionLimits: true, kind: 'subscription-only' },
    { hasSubscriptionLimits: false, kind: 'unmetered' },
  ])('returns $kind for unmonitored accounts even during loading', ({ hasSubscriptionLimits, kind }) => {
    expect(selectUsageView({ ...availableInput, isLoading: true, hasUsageMonitoring: false, hasSubscriptionLimits }))
      .toEqual({ kind });
  });

  it('uses the active profile reauth status when usage is unavailable even with a snapshot', () => {
    expect(selectUsageView({ ...availableInput, isAvailable: false, activeProfileNeedsReauth: true }))
      .toEqual({ kind: 'unavailable', needsReauth: true });
  });

  it('returns unavailable when usage is marked available but the snapshot is missing', () => {
    expect(selectUsageView({ ...availableInput, usage: null })).toEqual({ kind: 'unavailable', needsReauth: false });
  });

  it('uses the higher of the two usage windows when no credit data is present', () => {
    expect(selectUsageView({ ...availableInput, activeProfileNeedsReauth: true })).toEqual(monitoredView);
    expect(selectUsageView({ ...availableInput, usage: { ...usage, sessionPercent: 91 } }))
      .toMatchObject({ kind: 'monitored', sessionPercent: 91, weeklyPercent: 73, maxUsage: 91 });
  });

  it('uses the snapshot reauth status when monitored usage is available', () => {
    const reauthUsage = { ...usage, needsReauthentication: true };
    expect(selectUsageView({ ...availableInput, usage: reauthUsage }))
      .toEqual({ ...monitoredView, usage: reauthUsage, needsReauth: true });
  });

  it.each([
    { limit: 100, used: 25, creditPercent: 25 },
    { limit: 100, used: 120, creditPercent: 100 },
    { limit: null, used: 25, creditPercent: 0 },
    { limit: 0, used: 25, creditPercent: 0 },
  ])('derives $creditPercent% credit usage for $used used with limit $limit', ({ limit, used, creditPercent }) => {
    const creditUsage = { used, limit, remaining: limit == null ? null : Math.max(0, limit - used) };
    const creditSnapshot = { ...usage, creditUsage };
    expect(selectUsageView({ ...availableInput, usage: creditSnapshot })).toEqual({
      ...monitoredView,
      usage: creditSnapshot,
      creditUsage,
      creditLimit: limit,
      creditPercent,
      maxUsage: creditPercent,
    });
  });
});

describe('getQueuedRowVariant', () => {
  it.each([
    { kind: 'loading' },
    { kind: 'unmetered' },
  ] as const)('uses plain rows without a subscription fallback for $kind', (view) => {
    expect(getQueuedRowVariant(view)).toEqual({ avatar: 'plain', showLimitStatus: false, subscriptionFallback: false });
  });

  it('shows a subscription fallback without limit status in subscription-only rows', () => {
    expect(getQueuedRowVariant({ kind: 'subscription-only' }))
      .toEqual({ avatar: 'plain', showLimitStatus: false, subscriptionFallback: true });
  });

  it.each([
    { kind: 'unavailable', needsReauth: false },
    monitoredView,
  ] as const)('shows status and a subscription fallback in $kind rows', (view) => {
    expect(getQueuedRowVariant(view)).toEqual({ avatar: 'status', showLimitStatus: true, subscriptionFallback: true });
  });
});
