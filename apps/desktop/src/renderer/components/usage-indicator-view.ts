/**
 * zeenha fork: select the usage presentation from the active account's monitoring
 * state, keeping view precedence and queued-row display rules out of the JSX.
 */
import type { ClaudeUsageSnapshot } from '../../shared/types/agent';

export type UsageView =
  | { kind: 'loading' }
  | { kind: 'subscription-only' }
  | { kind: 'unmetered' }
  | { kind: 'unavailable'; needsReauth: boolean }
  | {
      kind: 'monitored';
      usage: ClaudeUsageSnapshot;
      needsReauth: boolean;
      sessionPercent: number;
      weeklyPercent: number;
      creditUsage: ClaudeUsageSnapshot['creditUsage'];
      creditLimit: number | null;
      creditPercent: number;
      maxUsage: number;
    };

export type QueuedRowVariant = {
  avatar: 'plain' | 'status';
  showLimitStatus: boolean;
  subscriptionFallback: boolean;
};

export function getQueuedRowVariant(view: UsageView): QueuedRowVariant {
  switch (view.kind) {
    case 'subscription-only':
      return { avatar: 'plain', showLimitStatus: false, subscriptionFallback: true };
    case 'unavailable':
    case 'monitored':
      return { avatar: 'status', showLimitStatus: true, subscriptionFallback: true };
    case 'loading': // No rows are rendered while loading.
    case 'unmetered':
      return { avatar: 'plain', showLimitStatus: false, subscriptionFallback: false };
  }
}

export function selectUsageView(input: {
  isLoading: boolean;
  hasUsageMonitoring: boolean;
  hasSubscriptionLimits: boolean;
  isAvailable: boolean;
  usage: ClaudeUsageSnapshot | null;
  activeProfileNeedsReauth: boolean;
}): UsageView {
  const { isLoading, hasUsageMonitoring, hasSubscriptionLimits, isAvailable, usage, activeProfileNeedsReauth } = input;
  if (isLoading && hasUsageMonitoring) return { kind: 'loading' };
  if (!hasUsageMonitoring) return { kind: hasSubscriptionLimits ? 'subscription-only' : 'unmetered' };
  if (!isAvailable || !usage) return { kind: 'unavailable', needsReauth: activeProfileNeedsReauth };

  const { sessionPercent, weeklyPercent, creditUsage } = usage;
  const creditLimit = creditUsage?.limit ?? null;
  const creditPercent = creditUsage && creditLimit != null && creditLimit > 0
    ? Math.min(100, (creditUsage.used / creditLimit) * 100)
    : 0;
  const maxUsage = creditUsage ? creditPercent : Math.max(sessionPercent, weeklyPercent);

  return {
    kind: 'monitored',
    usage,
    needsReauth: !!usage.needsReauthentication,
    sessionPercent,
    weeklyPercent,
    creditUsage,
    creditLimit,
    creditPercent,
    maxUsage,
  };
}
