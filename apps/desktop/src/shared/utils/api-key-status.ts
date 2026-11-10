/**
 * API key status helpers (pure). Absent keyStatus means 'unverified'.
 */

import type { ApiKeyStatus } from '../types/profile';

export function getKeyStatus(entity: { keyStatus?: ApiKeyStatus }): ApiKeyStatus {
  return entity.keyStatus ?? 'unverified';
}

export function withKeyStatus<T>(entity: T, status: ApiKeyStatus, now: number = Date.now()): T {
  return { ...entity, keyStatus: status, keyStatusAt: now };
}

/** Remove status fields (used when the key changes). */
export function withKeyStatusReset<T>(entity: T): T {
  const copy = { ...entity } as T & { keyStatus?: ApiKeyStatus; keyStatusAt?: number };
  delete copy.keyStatus;
  delete copy.keyStatusAt;
  return copy;
}

/** Failover tier: 0 = valid, 1 = unverified. Rejected keys are excluded before tiering. */
export function failoverTier(status: ApiKeyStatus): 0 | 1 {
  return status === 'valid' ? 0 : 1;
}
