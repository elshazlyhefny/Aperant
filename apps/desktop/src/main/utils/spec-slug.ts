/**
 * zeenha fork: the ONE slug for spec folder names, and therefore for task
 * branch names, which are `auto-claude/<specId>` (worktree-manager.ts).
 *
 * Every spec-creating path used to inline its own copy, hard-cut at 50
 * characters: the cut landed mid-word and could leave a trailing dash
 * (`016-keep-focus-on-the-dashboard-pager-while-a-page-loa`). This cuts at the
 * last whole word that fits, so a branch reads as words.
 *
 * The output only ever contains `[a-z0-9-]`, which keeps the branch inside the
 * `TASK_BRANCH_RE` charset that Create PR and the landing validators enforce.
 * Changing the slug changes only NEW spec ids; existing folders and branches
 * keep the names they were created with.
 */

/** Longest slug kept after the `NNN-` spec number. */
export const SPEC_SLUG_MAX_LENGTH = 40;

/** Used when a title has no ASCII letters or digits at all. */
export const SPEC_SLUG_FALLBACK = 'task';

export function slugifySpecTitle(title: string, maxLength: number = SPEC_SLUG_MAX_LENGTH): string {
  const full = (title ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // "café" -> "cafe" rather than "caf"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!full) return SPEC_SLUG_FALLBACK;
  if (full.length <= maxLength) return full;

  // Look one character past the limit: a dash there means the word ending at
  // the limit is whole and can be kept.
  const window = full.slice(0, maxLength + 1);
  const lastDash = window.lastIndexOf('-');
  const cut = lastDash > 0 ? full.slice(0, lastDash) : full.slice(0, maxLength); // one huge word: hard cut

  return cut.replace(/-+$/g, '') || SPEC_SLUG_FALLBACK;
}

/** `NNN-<slug>`: the spec folder name and the suffix of the task branch. */
export function buildSpecId(specNumber: number, title: string): string {
  return `${String(specNumber).padStart(3, '0')}-${slugifySpecTitle(title)}`;
}
