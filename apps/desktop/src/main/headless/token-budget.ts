/**
 * zeenha fork: resolve and attribute headless token budgets without desktop settings.
 */

import { parseTokenBudget, resolveTokenBudget } from '../../shared/utils/token-budget';
import { readTaskMetadata } from '../ai/agent/task-session';
import type { HeadlessConfig } from './config';

export type HeadlessTokenBudgetSource = 'task' | 'schedule' | 'config' | 'none';

export interface HeadlessTokenBudget {
  limit: number | undefined;
  source: HeadlessTokenBudgetSource;
}

export function resolveHeadlessTokenBudget(specDir: string, config: HeadlessConfig): HeadlessTokenBudget {
  const metadata = readTaskMetadata(specDir);
  // Programmatic config can bypass file validation.
  const fallback = parseTokenBudget(config.project?.defaultTokenBudget);
  const limit = resolveTokenBudget(metadata ?? undefined, { tokenBudget: fallback });

  if (metadata?.tokenBudget !== undefined && metadata.tokenBudget !== null) {
    const source = (metadata as { sourceType?: string }).sourceType === 'schedule' ? 'schedule' : 'task';
    return { limit, source };
  }

  return { limit, source: fallback !== undefined ? 'config' : 'none' };
}
