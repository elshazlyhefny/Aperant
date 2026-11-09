/**
 * Builds the short terminal notice shown when project-level Claude Code
 * settings env vars were ignored. Only names are printed, never values, and
 * every name is scrubbed so a hostile settings file cannot inject escape
 * sequences or flood the terminal.
 */

import type { DroppedEnvVar } from './env-sanitizer';

const MAX_NAME_LENGTH = 64;
const MAX_NAMES = 10;

const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function scrubName(name: unknown): string {
  const text = typeof name === 'string' ? name : '';
  return text.replace(/[^A-Za-z0-9_]/g, '').slice(0, MAX_NAME_LENGTH);
}

export function formatDroppedEnvNotice(
  dropped: ReadonlyArray<Pick<DroppedEnvVar, 'key' | 'level'>> | undefined
): string | null {
  if (!dropped || dropped.length === 0) return null;

  const names: string[] = [];
  for (const entry of dropped) {
    if (entry.level !== 'projectShared' && entry.level !== 'projectLocal') continue;
    const name = scrubName(entry.key);
    if (name && !names.includes(name)) names.push(name);
  }
  if (names.length === 0) return null;

  const shown = names.slice(0, MAX_NAMES).join(', ');
  const extra = names.length > MAX_NAMES ? `, +${names.length - MAX_NAMES} more` : '';
  return `${YELLOW}[Aperant] Ignored ${names.length} environment variable(s) from this project's .claude settings for safety: ${shown}${extra}${RESET}`;
}
