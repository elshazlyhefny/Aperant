/**
 * ZHIPU AI usage adapter (quota/limit endpoint).
 */

import type { UsageProviderAdapter } from '../types';
import { createUsageLogger } from '../usage-log';
import { normalizeQuotaLimitResponse } from './quota-limit';

export const zhipuAdapter: UsageProviderAdapter = {
  provider: 'zhipu',
  usagePath: '/api/monitor/usage/quota/limit',
  allowedDomains: ['open.bigmodel.cn'],
  buildHeaders() {
    return {};
  },
  extractData(raw) {
    // ZHIPU AI wraps the actual usage data in a 'data' field
    const logger = createUsageLogger();
    if (raw.data) {
      logger.traceLog('[UsageMonitor:PROVIDER] Extracted data field from response:', {
        provider: 'zhipu',
        extractedData: JSON.stringify(raw.data, null, 2)
      });
      return raw.data;
    }
    logger.traceLog('[UsageMonitor:PROVIDER] No data field found in response, using raw response:', {
      provider: 'zhipu',
      responseKeys: Object.keys(raw)
    });
    return raw;
  },
  normalize(data, ids) {
    return normalizeQuotaLimitResponse(
      data,
      ids.profileId,
      ids.profileName,
      ids.profileEmail,
      'zhipu',
      process.env.VERBOSE === 'true'
    );
  }
};
