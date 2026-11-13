import path from 'path';
import { existsSync, readFileSync } from 'fs';
import type { Project } from '../../shared/types';
import { parseEnvFile } from './utils';

/**
 * Helper to get Linear API key from project env
 */
export const getLinearApiKey = (project: Project): string | null => {
  if (!project.autoBuildPath) return null;
  const envPath = path.join(project.path, project.autoBuildPath, '.env');
  if (!existsSync(envPath)) return null;

  try {
    const content = readFileSync(envPath, 'utf-8');
    const vars = parseEnvFile(content);
    return vars['LINEAR_API_KEY'] || null;
  } catch {
    return null;
  }
};

/**
 * Make a request to the Linear API
 */
export const linearGraphQL = async (
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<unknown> => {
  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': apiKey
    },
    body: JSON.stringify({ query, variables })
  });

  // Check response.ok first, then try to parse JSON
  // This handles cases where the API returns non-JSON errors (e.g., 503 from proxy)
  if (!response.ok) {
    let errorMessage = response.statusText;
    try {
      const errorResult = await response.json();
      errorMessage = errorResult?.errors?.[0]?.message
        || errorResult?.error
        || errorResult?.message
        || response.statusText;
    } catch {
      // JSON parsing failed - use status text as fallback
    }
    throw new Error(`Linear API error: ${response.status} - ${errorMessage}`);
  }

  const result = await response.json();
  if (result.errors) {
    throw new Error(result.errors[0]?.message || 'Linear API error');
  }

  return result.data;
};
