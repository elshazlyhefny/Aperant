/**
 * z.ai usage adapter (quota/limit endpoint).
 */

import type { UsageProviderAdapter } from '../types';
import { createUsageLogger } from '../usage-log';
import { normalizeQuotaLimitResponse } from './quota-limit';

export const zaiAdapter: UsageProviderAdapter = {
  provider: 'zai',
  usagePath: '/api/monitor/usage/quota/limit',
  allowedDomains: ['api.z.ai'],
  buildHeaders() {
    return {};
  },
  extractData(raw) {
    // z.ai wraps the actual usage data in a 'data' field
    const logger = createUsageLogger();
    if (raw.data) {
      logger.traceLog('[UsageMonitor:PROVIDER] Extracted data field from response:', {
        provider: 'zai',
        extractedData: JSON.stringify(raw.data, null, 2)
      });
      return raw.data;
    }
    logger.traceLog('[UsageMonitor:PROVIDER] No data field found in response, using raw response:', {
      provider: 'zai',
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
      'zai',
      process.env.VERBOSE === 'true'
    );
  }
};
