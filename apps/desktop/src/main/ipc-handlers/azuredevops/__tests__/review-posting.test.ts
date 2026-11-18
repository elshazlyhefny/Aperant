import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { getPath: () => '/tmp' } }));

import type { Project } from '../../../../shared/types';
import type { PRReviewFinding, PRReviewResult } from '../../../../shared/types/pr-review';
import { saveAzureDevOpsReviewResult, getAzureDevOpsReviewResult } from '../review-results';
import { buildSummaryComment, buildInlineComment, postAzureDevOpsReview } from '../review-posting';
import { MAX_COMMENT_LENGTH } from '../utils';

const config = { organization: 'org', project: 'My Proj', repository: 'repo', pat: 'secret-pat' };
const on = { confirmed: true, postInline: true };

function finding(id: string, over: Partial<PRReviewFinding> = {}): PRReviewFinding {
  return {
    id, severity: 'high', category: 'security', title: `T${id}`, description: `D${id}`,
    file: 'a.ts', line: 3, fixable: false, suggestedFix: `fix${id}`, ...over
  } as PRReviewFinding;
}

let dir: string;
let project: Project;
let fetchMock: ReturnType<typeof vi.fn>;

function seed(findings: PRReviewFinding[], extra: Partial<PRReviewResult> = {}) {
  saveAzureDevOpsReviewResult(project, 5, {
    prNumber: 5, repo: 'ws/repo', success: true, findings, summary: 'Sum',
    overallStatus: 'comment', reviewedAt: '2024-01-01T00:00:00Z', ...extra
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-post-'));
  project = { id: 'p', path: dir } as Project;
  let n = 0;
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ id: ++n, comments: [{ id: 1 }] }) }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('postAzureDevOpsReview', () => {
  it('posts nothing when not confirmed', async () => {
    seed([finding('f1')]);
    const r = await postAzureDevOpsReview(project, config, 5, ['f1'], { confirmed: false, postInline: true });
    expect(r.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts nothing for an empty selection', async () => {
    seed([finding('f1')]);
    const r = await postAzureDevOpsReview(project, config, 5, [], on);
    expect(r.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts summary only', async () => {
    seed([finding('f1')]);
    const r = await postAzureDevOpsReview(project, config, 5, ['f1'], { confirmed: true, postInline: false });
    expect(r).toMatchObject({ success: true, data: { inlinePosted: 1 - 1, postedFindingIds: ['f1'] } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const stored = getAzureDevOpsReviewResult(project, 5)!;
    expect(stored.postedFindingIds).toEqual(['f1']);
    expect(stored.postedAt).toBeTruthy();
  });

  it('posts summary plus inline with the right payload shape', async () => {
    seed([finding('f1'), finding('f2', { line: 0 })]);
    const r = await postAzureDevOpsReview(project, config, 5, ['f1', 'f2'], on);
    expect(r.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const inlineBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/pullrequests\/5\/threads/);
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/\/pullrequests\/5\/threads/);
    expect(inlineBody.status).toBe(1);
    expect(inlineBody.threadContext).toEqual({
      filePath: '/a.ts',
      rightFileStart: { line: 3, offset: 1 },
      rightFileEnd: { line: 3, offset: 1 }
    });
    expect(typeof inlineBody.comments[0].content).toBe('string');
    const summaryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(summaryBody.threadContext).toBeUndefined();
    expect(summaryBody.status).toBeUndefined();
    expect(summaryBody.comments[0].content).toContain('Df2');
    expect(summaryBody.comments[0].content).not.toContain('Df1');
    expect(r.data?.inlinePosted).toBe(1);
    expect(r.data?.summaryCommentId).toBe(2);
  });

  it('keeps a failed inline finding in the summary and reports it', async () => {
    seed([finding('f1')]);
    let call = 0;
    fetchMock.mockImplementation(async () => {
      call += 1;
      if (call === 1) return { ok: false, status: 400, statusText: 'Bad', text: async () => 'nope' };
      return { ok: true, json: async () => ({ id: 9, comments: [] }) };
    });
    const r = await postAzureDevOpsReview(project, config, 5, ['f1'], on);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data?.inlineFailed).toHaveLength(1);
      expect(r.data?.inlineFailed[0].findingId).toBe('f1');
    }
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).comments[0].content).toContain('Df1');
  });

  it('reports already-posted inline comments when the summary fails', async () => {
    seed([finding('f1')]);
    let call = 0;
    fetchMock.mockImplementation(async () => {
      call += 1;
      if (call === 2) return { ok: false, status: 500, statusText: 'Err', text: async () => '' };
      return { ok: true, json: async () => ({ id: 1, comments: [] }) };
    });
    const r = await postAzureDevOpsReview(project, config, 5, ['f1'], on);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain('f1');
    expect(getAzureDevOpsReviewResult(project, 5)!.postedFindingIds).toEqual(['f1']);
  });

  it('skips already-posted findings', async () => {
    seed([finding('f1')], { postedFindingIds: ['f1'], hasPostedFindings: true });
    const r = await postAzureDevOpsReview(project, config, 5, ['f1'], on);
    expect(r.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('comment builders', () => {
  it('truncates over-length summaries under the cap', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      finding(`f${i}`, { severity: i < 5 ? 'critical' : 'low', description: 'x'.repeat(1000) })
    );
    const body = buildSummaryComment({ summary: 'S', overallStatus: 'comment' }, many, {});
    expect(body.length).toBeLessThanOrEqual(MAX_COMMENT_LENGTH);
    expect(body).toMatch(/\.\.\. \d+ more findings omitted/);
    expect(body).toContain('## Aperant PR Review');
    expect(body).toContain('Suggested fix');
  });

  it('lists inline-posted findings compactly', () => {
    const body = buildSummaryComment({ summary: 'S', overallStatus: 'comment' }, [finding('f1')], {
      inlinePostedIds: ['f1']
    });
    expect(body).toContain('inline');
    expect(body).not.toContain('Df1');
    expect(buildInlineComment(finding('f1'))).toContain('Df1');
  });
});
