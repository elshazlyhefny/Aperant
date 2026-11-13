/**
 * Provider-neutral helpers for reporting task outcomes back to issue trackers.
 * zeenha fork: shared by the Jira, Linear and GitHub write-back modules.
 */

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import type { WebhookEvent } from '../../task-webhook';
import { sanitizeUrl } from '../shared/sanitize';

const MAX_TITLE_LENGTH = 200;

// zeenha fork: pr_opened is webhook-only; issue trackers get the PR link in the review_ready comment.
export type OutcomeEvent = Exclude<WebhookEvent, 'pr_opened'>;

export const EVENT_LABELS: Record<OutcomeEvent, string> = {
  review_ready: 'Aperant: task is ready for review.',
  failed: 'Aperant: task failed.',
  blocked: 'Aperant: task is blocked and needs attention.'
};

export function cleanTitle(value: unknown): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping control chars
  const cleaned = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  return cleaned.length > MAX_TITLE_LENGTH ? `${cleaned.slice(0, MAX_TITLE_LENGTH - 1)}…` : cleaned;
}

export function buildOutcomeComment(event: OutcomeEvent, taskTitle?: string, prUrl?: string): string {
  const lines = [EVENT_LABELS[event]];
  const title = cleanTitle(taskTitle);
  if (title) lines.push(`Task: ${title}`);
  const url = sanitizeUrl(prUrl);
  if (url?.startsWith('https://')) lines.push(`Pull request: ${url}`);
  return lines.join('\n');
}

export function readMetadata(dirs: string[]): Record<string, unknown> | null {
  for (const dir of dirs) {
    const file = path.join(dir, 'task_metadata.json');
    try {
      if (!existsSync(file)) continue;
      const parsed = JSON.parse(readFileSync(file, 'utf-8'));
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      // try next location
    }
  }
  return null;
}
