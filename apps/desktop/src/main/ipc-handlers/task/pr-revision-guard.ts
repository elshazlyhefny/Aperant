/**
 * zeenha fork: bind follow-ups to the PR revision the user reviewed.
 */

export const REVISION_FORMAT = /^[0-9a-f]{7,64}$/i;

export function isVerifiableRevision(sha: unknown): sha is string {
  return typeof sha === 'string' && REVISION_FORMAT.test(sha);
}

/** Compare full revisions or an abbreviated API head against a full Git SHA. */
export function sameRevision(a: unknown, b: unknown): boolean {
  if (!isVerifiableRevision(a) || !isVerifiableRevision(b)) return false;
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left.length <= right.length ? right.startsWith(left) : left.startsWith(right);
}

export function shortRevision(sha: string): string {
  return sha.slice(0, 7);
}
