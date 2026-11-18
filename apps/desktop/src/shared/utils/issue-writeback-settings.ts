import { DEFAULT_APP_SETTINGS } from '../constants/config';
import type { IssueWritebackSettings } from '../types/settings';

/**
 * zeenha fork: rebuild issue write-back settings from strictly-typed fields so
 * untrusted or stale persisted data can never leak odd values into the app.
 */
export function normalizeIssueWritebackSettings(raw: unknown): IssueWritebackSettings {
  const defaults = DEFAULT_APP_SETTINGS.issueWriteback;
  const r = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const stateName = typeof r.linearTransitionStateName === 'string'
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars on purpose
    ? r.linearTransitionStateName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100).trim()
    : '';

  return {
    github: r.github === true,
    gitlab: r.gitlab === true,
    linear: r.linear === true,
    linearTransitionOnReview: r.linearTransitionOnReview === true,
    linearTransitionStateName: stateName || defaults.linearTransitionStateName
  };
}
