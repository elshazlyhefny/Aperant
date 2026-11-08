import { describe, expect, it } from 'vitest';
import { capPRTitle, PR_TITLE_CAP } from '../pr-title';

// The task title that broke Create PR on 2026-11-08 (task 248): 220+ chars.
const TASK_248 =
  "Give support-chat guest tokens a lifetime: a visitor's or storefront guest's Bearer token stops working once the conversation has been closed past a grace period or has gone idle, instead of reading the transcript until support:prune deletes it 180 days after close";

describe('capPRTitle', () => {
  it('turns the task-248 title into its lead clause', () => {
    expect(TASK_248.length).toBeGreaterThan(256);
    expect(capPRTitle(TASK_248)).toBe('Give support-chat guest tokens a lifetime');
  });

  it('keeps a short title unchanged, minus a trailing period', () => {
    expect(capPRTitle('Fix the booking reminder time zone')).toBe('Fix the booking reminder time zone');
    expect(capPRTitle('Fix the booking reminder time zone.')).toBe('Fix the booking reminder time zone');
  });

  it('keeps a colon in a title that already fits', () => {
    expect(capPRTitle('fix(pos): close the shift twice')).toBe('fix(pos): close the shift twice');
  });

  it('uses the first sentence', () => {
    expect(capPRTitle('Cap the PR title. The spec heading is far too long for GitHub.')).toBe('Cap the PR title');
  });

  it('does not end a sentence inside a word like v2.8 or a path', () => {
    expect(capPRTitle('Upgrade to v2.8 and drop backend/app.php checks')).toBe(
      'Upgrade to v2.8 and drop backend/app.php checks',
    );
  });

  it('uses only the first non-empty line and drops a markdown heading', () => {
    expect(capPRTitle('\n\n# Rotate the guest token\nMore detail here')).toBe('Rotate the guest token');
  });

  it('cuts a long sentence with no clause break at a whole word, with an ellipsis', () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const out = capPRTitle(long);
    expect(out.length).toBeLessThanOrEqual(PR_TITLE_CAP);
    expect(out.endsWith('…')).toBe(true);
    expect(long.startsWith(out.slice(0, -1))).toBe(true);
    expect(out.slice(0, -1)).toMatch(/word\d+$/);
  });

  it('ignores a clause break that would leave a fragment', () => {
    const long = `Fix: ${'the very long description of a change '.repeat(5)}`;
    const out = capPRTitle(long);
    expect(out.startsWith('Fix: the very long')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(PR_TITLE_CAP);
  });

  it('ignores a clause break past the cap', () => {
    const long = `${'a'.repeat(5)} ${'b '.repeat(60)}: tail`;
    const out = capPRTitle(long);
    expect(out.length).toBeLessThanOrEqual(PR_TITLE_CAP);
    expect(out.endsWith('…')).toBe(true);
  });

  it('cuts at a spaced dash clause break', () => {
    const long = `Harden the merge queue lane — ${'explain everything about it in detail '.repeat(4)}`;
    expect(capPRTitle(long)).toBe('Harden the merge queue lane');
  });

  it('hard-cuts a single word longer than the cap', () => {
    const out = capPRTitle('x'.repeat(300));
    expect(out).toBe(`${'x'.repeat(PR_TITLE_CAP - 1)}…`);
  });

  it('honours a custom cap', () => {
    expect(capPRTitle('one two three four five', 12)).toBe('one two…');
  });

  it('returns empty for blank input', () => {
    expect(capPRTitle('')).toBe('');
    expect(capPRTitle('   \n  ')).toBe('');
    expect(capPRTitle(undefined)).toBe('');
    expect(capPRTitle(null)).toBe('');
  });

  it('never exceeds the cap for arbitrary long input', () => {
    for (const len of [101, 150, 256, 1000]) {
      const s = 'lorem ipsum dolor sit amet, '.repeat(Math.ceil(len / 28)).slice(0, len);
      expect(capPRTitle(s).length).toBeLessThanOrEqual(PR_TITLE_CAP);
    }
  });
});
