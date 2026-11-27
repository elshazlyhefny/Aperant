/** zeenha fork: delivery evidence is separate from the task outcome and contains no request data. */
import { WEBHOOK_FORMATS } from '../utils/webhook-format';

export const DELIVERY_OPERATIONS = ['webhook', 'issue_comment', 'issue_transition'] as const;
export const DELIVERY_EVENTS = ['review_ready', 'failed', 'blocked', 'account_required', 'pr_opened'] as const;
export const DELIVERY_PROVIDERS = [...WEBHOOK_FORMATS, 'github', 'gitlab', 'linear', 'jira', 'azureboards'] as const;

export const DELIVERY_REASONS = {
  skipped: ['event_disabled', 'missing_target', 'invalid_target', 'not_linked', 'unsupported_source',
    'invalid_reference', 'missing_configuration', 'target_mismatch', 'state_unavailable'],
  failed: ['rejected', 'rate_limited', 'lookup_failed'],
  unknown: ['unconfirmed', 'timeout', 'transport_error', 'ambiguous_response'],
} as const;

export interface DeliveryOperation {
  operation: (typeof DELIVERY_OPERATIONS)[number];
  event: (typeof DELIVERY_EVENTS)[number];
  provider?: (typeof DELIVERY_PROVIDERS)[number];
}

export type DeliveryResult = (
  | { status: 'delivered'; reason?: never }
  | { [S in keyof typeof DELIVERY_REASONS]: { status: S; reason: (typeof DELIVERY_REASONS)[S][number] } }[keyof typeof DELIVERY_REASONS]
) & { attempts?: number; httpStatus?: number };

export type DeliveryReceipt = DeliveryOperation & DeliveryResult & {
  id: string;
  createdAt: string;
  completedAt?: string;
};
