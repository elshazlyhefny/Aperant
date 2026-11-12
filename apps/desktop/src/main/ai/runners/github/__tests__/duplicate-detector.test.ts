import { describe, expect, it } from 'vitest';
import { DuplicateDetector, SIMILAR_THRESHOLD, type GitHubIssue } from '../duplicate-detector';

const detector = new DuplicateDetector();
const opts = { ignoreEmptyEntities: true };

const original = {
  title: 'Add dark mode toggle to the settings page',
  body: 'Users want to switch between light and dark themes from the settings page. Add a toggle that stores the preference and applies the theme across the whole application without a restart.',
};
const reworded = {
  title: 'Dark mode toggle in the settings page',
  body: 'Let users switch between light and dark themes from the settings page. A toggle should store the preference and apply the theme across the whole application without requiring a restart.',
};
const unrelated = {
  title: 'Speed up database migration startup',
  body: 'Migrations currently run sequentially on launch and block the window from appearing. Run them in a background worker and cache the schema version to reduce launch time.',
};

describe('compareIssues', () => {
  it('keeps scoring and issue numbers unchanged', () => {
    const a: GitHubIssue = { number: 1, title: 'Crash on save', body: 'App crashes when saving' };
    const b: GitHubIssue = { number: 2, title: 'Crash on save', body: 'App crashes when saving' };
    const r = detector.compareIssues(a, b);
    expect(r.issueA).toBe(1);
    expect(r.issueB).toBe(2);
    // title 1.0 * 0.4 + body 1.0 * 0.4 + entities 0
    expect(r.overallScore).toBeCloseTo(0.8, 10);
    expect(r.isSimilar).toBe(true);
    expect(r.isDuplicate).toBe(false);
  });
});

describe('compareTexts', () => {
  it('scores a reworded pair at or above the similar threshold with the opt-in option', () => {
    expect(detector.compareTexts(original, reworded, opts).overallScore).toBeGreaterThanOrEqual(
      SIMILAR_THRESHOLD,
    );
  });

  it('scores an unrelated pair below the threshold', () => {
    expect(detector.compareTexts(original, unrelated, opts).overallScore).toBeLessThan(
      SIMILAR_THRESHOLD,
    );
  });
});

describe('findMostSimilar', () => {
  it('picks the best candidate', () => {
    const found = detector.findMostSimilar(original, [unrelated, reworded], SIMILAR_THRESHOLD, opts);
    expect(found?.candidate).toBe(reworded);
    expect(found?.score).toBeGreaterThanOrEqual(SIMILAR_THRESHOLD);
  });

  it('returns null when only unrelated candidates exist', () => {
    expect(detector.findMostSimilar(original, [unrelated], SIMILAR_THRESHOLD, opts)).toBeNull();
  });
});
