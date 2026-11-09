/**
 * Claude Code Settings Merger
 *
 * Merges settings from multiple precedence levels into a single result.
 *
 * Precedence (lowest to highest):
 * 1. User Global
 * 2. Shared Project
 * 3. Local Project
 * 4. Managed (system-wide)
 *
 * Merge rules:
 * - Scalar values (model, alwaysThinkingEnabled, defaultMode): higher precedence wins
 * - env object: each level is sanitized once with its own label (project levels are
 *   untrusted and lose credential/git/proxy/PATH vars), then merged; higher precedence wins
 * - Permission arrays (allow, deny, ask): concatenate unique values
 * - additionalDirectories: concatenate unique values
 *
 * Security:
 * - Environment variables are sanitized to prevent supply chain attacks
 * - Dangerous variables (LD_PRELOAD, NODE_OPTIONS, etc.) are blocked
 * - Dropped keys (never values) are reported via mergeClaudeCodeSettingsWithReport
 */

import type { ClaudeCodeSettings, ClaudeCodeSettingsHierarchy } from './types';
import { sanitizeEnvVarsWithReport } from './env-sanitizer';
import type { DroppedEnvVar } from './env-sanitizer';

type SettingsLevel = 'user' | 'projectShared' | 'projectLocal' | 'managed';

/**
 * Merge two already-sanitized env objects. Values from `higher` override `lower`
 * on key conflicts. No sanitization happens here: each level is sanitized once,
 * with its own label, before merging.
 */
function mergeEnv(
  lower: Record<string, string> | undefined,
  higher: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!lower && !higher) return undefined;
  if (!lower) return { ...higher };
  if (!higher) return { ...lower };
  return { ...lower, ...higher };
}

/**
 * Merge two string arrays, keeping only unique values.
 */
function mergeArrays(
  lower: string[] | undefined,
  higher: string[] | undefined,
): string[] | undefined {
  if (!lower && !higher) return undefined;
  if (!lower) return higher ? [...higher] : undefined;
  if (!higher) return [...lower];

  const combined = [...lower, ...higher];
  return [...new Set(combined)];
}

/**
 * Merge two settings levels. Higher precedence values override lower for scalars;
 * arrays are concatenated; env is shallow-merged. Env must already be sanitized.
 */
function mergeTwoLevels(
  lower: ClaudeCodeSettings | undefined,
  higher: ClaudeCodeSettings | undefined
): ClaudeCodeSettings {
  if (!lower && !higher) return {};
  if (!lower) return { ...higher } as ClaudeCodeSettings;
  if (!higher) return { ...lower };

  const result: ClaudeCodeSettings = { ...lower };

  // Scalar overrides
  if (higher.model !== undefined) {
    result.model = higher.model;
  }
  if (higher.alwaysThinkingEnabled !== undefined) {
    result.alwaysThinkingEnabled = higher.alwaysThinkingEnabled;
  }

  // Merge env (already sanitized per level)
  result.env = mergeEnv(lower.env, higher.env);
  if (!result.env || Object.keys(result.env).length === 0) {
    delete result.env;
  }

  // Merge permissions
  if (lower.permissions || higher.permissions) {
    const lp = lower.permissions ?? {};
    const hp = higher.permissions ?? {};

    result.permissions = {
      ...lp,
      // Scalar override for defaultMode
      ...(hp.defaultMode !== undefined ? { defaultMode: hp.defaultMode } : {}),
      // Array merges
      allow: mergeArrays(lp.allow, hp.allow),
      deny: mergeArrays(lp.deny, hp.deny),
      ask: mergeArrays(lp.ask, hp.ask),
      additionalDirectories: mergeArrays(lp.additionalDirectories, hp.additionalDirectories),
    };

    // Clean up undefined array fields
    if (!result.permissions.allow) delete result.permissions.allow;
    if (!result.permissions.deny) delete result.permissions.deny;
    if (!result.permissions.ask) delete result.permissions.ask;
    if (!result.permissions.additionalDirectories) delete result.permissions.additionalDirectories;
    if (!result.permissions.defaultMode) delete result.permissions.defaultMode;
  }

  return result;
}

/**
 * Sanitize a level's env once with its own label. Returns the settings with the
 * sanitized env (removed when empty) and appends dropped keys to `dropped`.
 */
function sanitizeLevel(
  settings: ClaudeCodeSettings | undefined,
  level: SettingsLevel,
  dropped: DroppedEnvVar[]
): ClaudeCodeSettings | undefined {
  if (!settings) return undefined;
  if (!settings.env) return settings;

  const report = sanitizeEnvVarsWithReport(settings.env, level);
  dropped.push(...report.dropped);

  const result: ClaudeCodeSettings = { ...settings, env: report.env };
  if (Object.keys(report.env).length === 0) {
    delete result.env;
  }
  return result;
}

/**
 * Merge the full settings hierarchy and report which env vars were dropped.
 *
 * Applies precedence: user (lowest) -> projectShared -> projectLocal -> managed (highest).
 * Env is sanitized exactly once per level, using that level's own label.
 */
export function mergeClaudeCodeSettingsWithReport(
  hierarchy: ClaudeCodeSettingsHierarchy
): { settings: ClaudeCodeSettings; droppedEnv: DroppedEnvVar[] } {
  const droppedEnv: DroppedEnvVar[] = [];

  const levels: Array<[ClaudeCodeSettings | undefined, SettingsLevel]> = [
    [hierarchy.user, 'user'],
    [hierarchy.projectShared, 'projectShared'],
    [hierarchy.projectLocal, 'projectLocal'],
    [hierarchy.managed, 'managed'],
  ];

  let merged: ClaudeCodeSettings = {};
  for (const [settings, level] of levels) {
    merged = mergeTwoLevels(merged, sanitizeLevel(settings, level, droppedEnv));
  }

  return { settings: merged, droppedEnv };
}

/**
 * Merge the full settings hierarchy into a single ClaudeCodeSettings object.
 * See mergeClaudeCodeSettingsWithReport for details.
 */
export function mergeClaudeCodeSettings(
  hierarchy: ClaudeCodeSettingsHierarchy,
): ClaudeCodeSettings {
  return mergeClaudeCodeSettingsWithReport(hierarchy).settings;
}
