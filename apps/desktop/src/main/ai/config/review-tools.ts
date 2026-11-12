/**
 * Review tool allowlist.
 *
 * Deliberately has no imports so agent-configs.ts and the runners can both use
 * it without a circular dependency.
 */

// zeenha fork: The only tools a PR/MR review may use: it must never modify the
// checkout, run its code, or reach the network.
export const REVIEW_READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep']);

/** True when the tool is allowed in a PR/MR review session. */
export function isReviewReadOnlyTool(name: string): boolean {
  return REVIEW_READ_ONLY_TOOLS.has(name);
}
