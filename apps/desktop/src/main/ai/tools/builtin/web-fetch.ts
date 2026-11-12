/**
 * WebFetch Tool
 * =============
 *
 * Fetches content from a URL via a pluggable BrowseProvider.
 * Default provider: Jina Reader (r.jina.ai) — returns clean markdown.
 * Per-project setting 'direct' fetches locally with native fetch instead.
 * Every URL is checked by the URL policy (SSRF / secret-in-URL) before any provider runs.
 */

import { z } from 'zod/v3';

import { Tool } from '../define';
import { validateFetchUrl } from '../../security/url-policy';
import { createBrowseProvider } from '../providers';
import { parseWebFetchProvider } from '../providers/types';
import { DEFAULT_EXECUTION_OPTIONS, ToolPermission } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  url: z.string().url().describe('The URL to fetch content from'),
  prompt: z
    .string()
    .describe('The prompt to run on the fetched content — describes what information to extract'),
});

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const webFetchTool = Tool.define({
  metadata: {
    name: 'WebFetch',
    description:
      'Fetches content from a specified URL and returns it as markdown. Takes a URL and a prompt as input, fetches the URL content, converts it to markdown, and returns the result for analysis.',
    permission: ToolPermission.ReadOnly,
    executionOptions: {
      ...DEFAULT_EXECUTION_OPTIONS,
      timeoutMs: FETCH_TIMEOUT_MS,
    },
  },
  inputSchema,
  execute: async (input, context) => {
    const { url, prompt } = input;

    const policy = await validateFetchUrl(url);
    if (!policy.ok) {
      return `Error: WebFetch blocked — ${policy.reason}`;
    }

    try {
      const provider = createBrowseProvider(
        parseWebFetchProvider(context.securityProfile.webFetchProvider),
      );
      const result = await provider.browse(url, { timeout: FETCH_TIMEOUT_MS });

      return `URL: ${url}\nPrompt: ${prompt}\n\n--- Fetched Content ---\n${result.content}`;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return `Error: Request timed out after ${FETCH_TIMEOUT_MS}ms fetching ${url}`;
      }
      const message = error instanceof Error ? error.message : String(error);
      return `Error: Failed to fetch ${url} — ${message}`;
    }
  },
});
