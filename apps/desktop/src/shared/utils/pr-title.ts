/**
 * zeenha fork: a PR title made from a task title.
 *
 * Task titles from Ideation/Insights are the spec's whole first line, often
 * 200+ characters (a title, a colon, then the problem statement). Used as-is
 * they were refused by the 256-character PR title check, or made unreadable
 * PR lists. This is the title used whenever the model's suggested title is
 * missing (still loading, timed out, rejected):
 *
 *   1. the first non-empty line, without a leading markdown `#`;
 *   2. its first sentence;
 *   3. if still longer than `max`, cut at the first clause break (`:`, `;`,
 *      a spaced dash) when that leaves a real title, else at the last whole
 *      word that fits, marked with `…`.
 *
 * Never longer than `max`. Returns '' for blank input; callers keep their own
 * fallback (`auto-claude: <specId>`) for that.
 */

export const PR_TITLE_CAP = 100;

/** A clause cut shorter than this reads as a fragment, so the word cut is used instead. */
const MIN_CLAUSE_TITLE = 20;

const TRAILING_PUNCTUATION_RE = /[\s.,:;!?\-–—]+$/u;

export function capPRTitle(raw: string | null | undefined, max: number = PR_TITLE_CAP): string {
  if (!raw) return '';
  const firstLine = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const line = firstLine.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
  if (!line) return '';

  // First sentence: up to a . ! or ? that ends a word (followed by a space).
  const sentenceEnd = line.search(/[.!?](\s|$)/);
  const sentence = (sentenceEnd >= 0 ? line.slice(0, sentenceEnd) : line).replace(TRAILING_PUNCTUATION_RE, '');
  if (sentence.length <= max) return sentence;

  const clause = sentence.search(/\s*(?::|;|\s[–—-])\s/);
  if (clause >= MIN_CLAUSE_TITLE && clause <= max) {
    return sentence.slice(0, clause).replace(TRAILING_PUNCTUATION_RE, '');
  }

  // Word cut, leaving room for the ellipsis.
  const room = sentence.slice(0, max - 1);
  const lastSpace = room.lastIndexOf(' ');
  const cut = (lastSpace > 0 ? room.slice(0, lastSpace) : room).replace(TRAILING_PUNCTUATION_RE, '');
  return `${cut}…`;
}
