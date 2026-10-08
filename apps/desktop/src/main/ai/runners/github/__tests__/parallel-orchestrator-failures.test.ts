/**
 * zeenha fork: a reviewer that failed found nothing because it looked at
 * nothing. Counting failures as "no findings" turned a provider outage or a
 * rate limit into "Ready to merge" (an approval) for an unreviewed PR.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../security/security-profile', () => ({ getSecurityProfile: () => ({}) }));
vi.mock('../../../tools/build-registry', () => ({ buildToolRegistry: () => ({ getToolsForAgent: () => ({}) }) }));

import { MergeVerdict, ParallelOrchestratorReviewer } from '../parallel-orchestrator';

type Internals = {
  runSpecialist: (...args: unknown[]) => Promise<unknown>;
  synthesizeFindings: (...args: unknown[]) => Promise<unknown>;
  runFindingValidator: (...args: unknown[]) => Promise<unknown>;
};
const proto = ParallelOrchestratorReviewer.prototype as unknown as Internals;
const context = { prNumber: 7, title: 't', changedFiles: [], commits: [] } as never;

function reviewer() {
  return new ParallelOrchestratorReviewer({ repo: 'o/r', projectDir: '/tmp' });
}

afterEach(() => vi.restoreAllMocks());

describe('PR review when reviewers fail', () => {
  it('refuses to produce a verdict when every reviewer failed', async () => {
    vi.spyOn(proto, 'runSpecialist').mockImplementation(async (spec: unknown) => ({
      name: (spec as { name: string }).name,
      findings: [],
      failed: 'Claude Code CLI: 429 rate limit reached',
    }));
    const synth = vi.spyOn(proto, 'synthesizeFindings');

    await expect(reviewer().review(context)).rejects.toThrow(/all \d+ reviewers failed.*429/);
    expect(synth).not.toHaveBeenCalled();
  });

  it('also counts a rejected reviewer as failed', async () => {
    vi.spyOn(proto, 'runSpecialist').mockRejectedValue(new Error('boom'));
    await expect(reviewer().review(context)).rejects.toThrow(/reviewers failed \(boom\)/);
  });

  it('never approves when only some reviewers ran, and says which failed', async () => {
    let call = 0;
    vi.spyOn(proto, 'runSpecialist').mockImplementation(async (spec: unknown) => {
      const name = (spec as { name: string }).name;
      return call++ === 0 ? { name, findings: [], failed: 'timeout' } : { name, findings: [] };
    });
    vi.spyOn(proto, 'synthesizeFindings').mockResolvedValue({
      verdict: MergeVerdict.READY_TO_MERGE,
      verdictReasoning: 'No issues found by any specialist reviewer.',
      keptFindings: [],
    });
    vi.spyOn(proto, 'runFindingValidator').mockResolvedValue([]);

    const result = await reviewer().review(context);

    expect(result.verdict).toBe(MergeVerdict.MERGE_WITH_CHANGES);
    expect(result.verdictReasoning).toMatch(/^Incomplete review: the \S+ reviewer\(s\) failed/);
  });

  it('still approves a PR every reviewer actually checked and found clean', async () => {
    vi.spyOn(proto, 'runSpecialist').mockImplementation(async (spec: unknown) => ({ name: (spec as { name: string }).name, findings: [] }));
    vi.spyOn(proto, 'runFindingValidator').mockResolvedValue([]);

    const result = await reviewer().review(context);

    expect(result.verdict).toBe(MergeVerdict.READY_TO_MERGE);
  });
});
