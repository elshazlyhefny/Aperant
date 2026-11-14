import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Project } from '../../../../shared/types';
import type { PRReviewResult } from '../../../../shared/types/pr-review';
import { saveBitbucketReviewResult, getBitbucketReviewResult, markFindingsPosted } from '../review-results';

let dir: string;
let project: Project;

const result: PRReviewResult = {
  prNumber: 9,
  repo: 'ws/repo',
  success: true,
  findings: [
    {
      id: 'f1',
      severity: 'high',
      category: 'security',
      title: 'T',
      description: 'D',
      file: 'a.ts',
      line: 3,
      fixable: true
    } as PRReviewResult['findings'][number]
  ],
  summary: 'sum',
  overallStatus: 'request_changes',
  reviewedAt: '2024-01-01T00:00:00Z',
  reviewedCommitSha: 'abc123'
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-review-'));
  project = { id: 'p', path: dir } as Project;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('bitbucket review results', () => {
  it('round trips and writes snake_case under bitbucket/pr', () => {
    saveBitbucketReviewResult(project, 9, result);
    const file = path.join(dir, '.auto-claude', 'bitbucket', 'pr', 'review_9.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(raw.reviewed_commit_sha).toBe('abc123');
    expect(raw.posted_finding_ids).toEqual([]);

    const loaded = getBitbucketReviewResult(project, 9)!;
    expect(loaded.reviewedCommitSha).toBe('abc123');
    expect(loaded.findings[0]).toMatchObject({ id: 'f1', file: 'a.ts', line: 3, fixable: true });
    expect(loaded.overallStatus).toBe('request_changes');
  });

  it('returns null for missing or corrupt files', () => {
    expect(getBitbucketReviewResult(project, 1)).toBeNull();
    const prDir = path.join(dir, '.auto-claude', 'bitbucket', 'pr');
    fs.mkdirSync(prDir, { recursive: true });
    fs.writeFileSync(path.join(prDir, 'review_2.json'), '{not json');
    expect(getBitbucketReviewResult(project, 2)).toBeNull();
  });

  it('marks findings posted without duplicates', () => {
    expect(markFindingsPosted(project, 9, ['f1'])).toBeNull();
    saveBitbucketReviewResult(project, 9, result);
    markFindingsPosted(project, 9, ['f1']);
    markFindingsPosted(project, 9, ['f1', 'f2']);
    const loaded = getBitbucketReviewResult(project, 9)!;
    expect(loaded.postedFindingIds).toEqual(['f1', 'f2']);
    expect(loaded.hasPostedFindings).toBe(true);
    expect(loaded.postedAt).toBeTruthy();
  });
});
