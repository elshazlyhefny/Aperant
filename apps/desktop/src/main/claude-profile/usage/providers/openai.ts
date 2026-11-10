/**
 * OpenAI (Codex / ChatGPT) usage adapter.
 */

import { normalizeCodexResponse } from '../../codex-usage-fetcher';
import type { UsageProviderAdapter } from '../types';

export const openaiAdapter: UsageProviderAdapter = {
  provider: 'openai',
  usagePath: '/backend-api/wham/usage',
  allowedDomains: ['chatgpt.com'],
  async buildHeaders(credential) {
    const headers: Record<string, string> = {};
    // Codex usage endpoint may need account ID for team accounts
    try {
      const { getCodexAccountId } = await import('../../codex-usage-fetcher');
      const accountId = getCodexAccountId(credential);
      if (accountId) {
        headers['ChatGPT-Account-Id'] = accountId;
      }
    } catch {
      // Non-critical — personal accounts work without the header
    }
    return headers;
  },
  extractData(raw) {
    return raw;
  },
  normalize(_data, ids, raw) {
    return normalizeCodexResponse(raw, ids.profileId, ids.profileName, ids.profileEmail);
  }
};
