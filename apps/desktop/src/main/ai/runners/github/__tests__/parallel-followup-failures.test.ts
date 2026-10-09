/**
 * zeenha fork: a follow-up specialist that failed looked at nothing. Skipping
 * it made previous findings vanish (neither resolved nor unresolved) and the
 * verdict READY_TO_MERGE, which the caller maps to an approval.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../security/security-profile', () => ({ getSecurityProfile: () => ({}) }));
vi.mock('../../../tools/build-registry', () => ({ buildToolRegistry: () => ({ getToolsForAgent: () => ({}) }) }));

import {
  type FollowupReviewContext,
  FollowupReviewIncompleteError,
  ParallelFollowupReviewer,
} from '../parallel-followup';
import { MergeVerdict } from '../parallel-orchestrator';
import { ReviewCategory, ReviewSeverity } from '../pr-review-engine';

type Internals = { runSpecialist: (type: string, ...rest: unknown[]) => Promise<{ type: string; result: string }> };
const proto = ParallelFollowupReviewer.prototype as unknown as Internals;

const previousFinding = {
  id: 'F-1',
  severity: ReviewSeverity.LOW,
  category: ReviewCategory.QUALITY,
  title: 'Old issue',
  description: 'desc',
  file: 'a.ts',
  line: 3,
  fixable: false,
};

function context(overrides: Partial<FollowupReviewContext> = {}): FollowupReviewContext {
  return {
    prNumber: 9,
    previousReview: { prNumber: 9, findings: [previousFinding] },
    previousCommitSha: 'a',
    currentCommitSha: 'b',
    commitsSinceReview: [],
    filesChangedSinceReview: [],
    diffSinceReview: 'x'.repeat(200),
    contributorCommentsSinceReview: [],
    aiBotCommentsSinceReview: [],
    prReviewsSinceReview: [],
    ...overrides,
  };
}

function reviewer() {
  return new ParallelFollowupReviewer({ repo: 'o/r' });
}

/** Map of specialist type → its raw text output, or an Error to reject with. */
function specialists(outputs: Record<string, string | Error>) {
  vi.spyOn(proto, 'runSpecialist').mockImplementation(async (type: string) => {
    const out = outputs[type];
    if (out instanceof Error) throw out;
    return { type, result: out ?? '' };
  });
}

const clean = JSON.stringify({ findings: [] });

afterEach(() => vi.restoreAllMocks());

describe('follow-up review when specialists fail', () => {
  it('throws when every specialist failed, instead of returning a verdict', async () => {
    specialists({
      'resolution-verifier': new Error('429 rate limit'),
      'new-code-reviewer': new Error('429 rate limit'),
    });
    await expect(reviewer().review(context())).rejects.toThrow(FollowupReviewIncompleteError);
    await expect(reviewer().review(context())).rejects.toThrow(/all 2 reviewers failed \(429/);
  });

  it('treats unparseable output as a failure, not as zero findings', async () => {
    specialists({ 'resolution-verifier': 'not json at all', 'new-code-reviewer': 'also garbage' });
    await expect(reviewer().review(context())).rejects.toThrow(/all 2 reviewers failed/);
  });

  it('carries a previous finding forward as unresolved when the verifier failed', async () => {
    specialists({ 'resolution-verifier': new Error('boom'), 'new-code-reviewer': clean });

    const result = await reviewer().review(context());

    expect(result.unresolvedFindings).toEqual(['F-1']);
    expect(result.findings.map((f) => f.title)).toEqual(['[UNRESOLVED] Old issue']);
    expect(result.verdict).not.toBe(MergeVerdict.READY_TO_MERGE);
    expect(result.overallStatus).not.toBe('approve');
    expect(result.verdictReasoning).toMatch(/^Incomplete review: the resolution-verifier reviewer\(s\) failed/);
  });

  it('counts an unparseable verifier answer as a failed verifier', async () => {
    specialists({ 'resolution-verifier': 'garbage', 'new-code-reviewer': clean });

    const result = await reviewer().review(context());

    expect(result.unresolvedFindings).toEqual(['F-1']);
    expect(result.verdictReasoning).toMatch(/^Incomplete review: the resolution-verifier reviewer\(s\) failed/);
  });

  it('carries forward a previous finding the verifier left out of its answer', async () => {
    specialists({
      'resolution-verifier': JSON.stringify({ verifications: [] }),
      'new-code-reviewer': clean,
    });

    const result = await reviewer().review(context());

    expect(result.unresolvedFindings).toEqual(['F-1']);
    expect(result.verdict).toBe(MergeVerdict.NEEDS_REVISION);
  });

  it('never approves when the new-code reviewer failed, and names it', async () => {
    specialists({
      'resolution-verifier': JSON.stringify({
        verifications: [{ finding_id: 'F-1', status: 'resolved', evidence: 'fixed' }],
      }),
      'new-code-reviewer': new Error('timeout'),
    });

    const result = await reviewer().review(context());

    expect(result.resolvedFindings).toEqual(['F-1']);
    expect(result.verdict).toBe(MergeVerdict.MERGE_WITH_CHANGES);
    expect(result.overallStatus).toBe('comment');
    expect(result.verdictReasoning).toMatch(/^Incomplete review: the new-code-reviewer reviewer\(s\) failed/);
  });

  it('still approves when every specialist ran and everything is resolved and clean', async () => {
    specialists({
      'resolution-verifier': JSON.stringify({
        verifications: [{ finding_id: 'F-1', status: 'resolved', evidence: 'fixed' }],
      }),
      'new-code-reviewer': clean,
    });

    const result = await reviewer().review(context());

    expect(result.verdict).toBe(MergeVerdict.READY_TO_MERGE);
    expect(result.overallStatus).toBe('approve');
    expect(result.unresolvedFindings).toEqual([]);
    expect(result.findings).toEqual([]);
  });
});
