import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils', async () => {
  const actual = await vi.importActual<typeof import('../utils')>('../utils');
  return { ...actual, gitlabFetch: vi.fn(), gitlabFetchText: vi.fn() };
});

import { gitlabFetch, gitlabFetchText, GitLabAPIError } from '../utils';
import { fetchMRFeedback, parseMergeRequestUrl, parseMRIidFromUrl } from '../mr-feedback';
import {
  PRFeedbackError,
  MAX_FEEDBACK_ITEMS,
  MAX_SUMMARY_LENGTH,
} from '../../github/pr/task-feedback';

const mockFetch = vi.mocked(gitlabFetch);
const mockText = vi.mocked(gitlabFetchText);
const config = { token: 'tok', instanceUrl: 'https://gitlab.com', project: 'g/p' };

const mr = {
  state: 'opened',
  web_url: 'https://gitlab.com/g/p/-/merge_requests/7',
  source_branch: 'feat',
  sha: 'abc',
  head_pipeline: { id: 99, project_id: 5 },
};

function setup(opts: { mr?: unknown; jobs?: unknown[]; discussions?: unknown[] }) {
  mockFetch.mockImplementation(async (_t: string, _i: string, endpoint: string) => {
    if (endpoint.includes('/pipelines/')) return opts.jobs ?? [];
    if (endpoint.includes('/discussions')) {
      return endpoint.includes('page=1') ? (opts.discussions ?? []) : [];
    }
    return opts.mr ?? mr;
  });
}

const note = (over: Record<string, unknown> = {}) => ({
  id: 1,
  body: 'fix this',
  system: false,
  resolvable: true,
  resolved: false,
  author: { username: 'rev' },
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  mockText.mockResolvedValue('log');
});

describe('URL parsing', () => {
  it('accepts plain and subgroup URLs', () => {
    expect(parseMergeRequestUrl('https://gitlab.com/g/p/-/merge_requests/7')).toEqual({
      iid: 7,
      projectPath: 'g/p',
    });
    expect(parseMergeRequestUrl('https://gitlab.com/a/b/c/-/merge_requests/12/diffs')).toEqual({
      iid: 12,
      projectPath: 'a/b/c',
    });
  });
  it('rejects bad input', () => {
    for (const u of [
      'https://u:p@gitlab.com/g/p/-/merge_requests/7',
      'ftp://gitlab.com/g/p/-/merge_requests/7',
      'https://gitlab.com/g/p/pull/7',
      'https://gitlab.com/g/p/-/merge_requests/0',
      'https://gitlab.com/g/p/-/merge_requests/9999999999',
      '',
      'nope',
    ]) {
      expect(parseMergeRequestUrl(u)).toBeNull();
    }
    expect(parseMergeRequestUrl(`https://gitlab.com/${'a'.repeat(2100)}/-/merge_requests/1`)).toBeNull();
    expect(parseMergeRequestUrl(5 as unknown as string)).toBeNull();
  });
  it('ignores query and fragment', () => {
    expect(parseMergeRequestUrl('https://gitlab.com/g/p/-/merge_requests/7?a=1#n')?.iid).toBe(7);
  });
  it('requires matching host', () => {
    expect(parseMRIidFromUrl('https://gitlab.com/g/p/-/merge_requests/7', 'https://gitlab.com')).toBe(7);
    expect(parseMRIidFromUrl('https://evil.com/g/p/-/merge_requests/7', 'https://gitlab.com')).toBeNull();
  });
});

describe('fetchMRFeedback', () => {
  it.each([
    ['merged', 'merged'],
    ['opened', 'open'],
    ['closed', 'closed'],
    ['locked', 'closed'],
  ])('maps state %s', async (state, expected) => {
    setup({ mr: { ...mr, state } });
    const r = await fetchMRFeedback(config, 7);
    expect(r.prState).toBe(expected);
    expect(r.headRef).toBe('feat');
    expect(r.headSha).toBe('abc');
    expect(r.reviews).toEqual([]);
  });

  it('maps failed jobs with clipped, redacted trace tail; drops allow_failure', async () => {
    setup({
      jobs: [
        { id: 1, name: 'unit', stage: 'test', web_url: 'http://j/1' },
        { id: 2, name: 'lint', stage: 'test', allow_failure: true },
      ],
    });
    mockText.mockResolvedValue(`HEAD${'x'.repeat(MAX_SUMMARY_LENGTH)}\n\u001b[31mglpat-abcdefghijklmnopqrstuv\u001b[0m END`);
    const r = await fetchMRFeedback(config, 7);
    expect(r.checks).toHaveLength(1);
    const c = r.checks[0];
    expect(c.id).toBe('check:job-1');
    expect(c.title).toBe('test: unit');
    expect(c.truncated).toBe(true);
    expect(c.summary).not.toContain('HEAD');
    expect(c.summary).not.toContain('glpat-');
    expect(c.summary.endsWith('END')).toBe(true);
    expect(mockText).toHaveBeenCalledWith('tok', 'https://gitlab.com', '/projects/5/jobs/1/trace');
  });

  it('falls back when trace fails', async () => {
    setup({ jobs: [{ id: 1, name: 'u', stage: 's', failure_reason: 'script_failure' }] });
    mockText.mockRejectedValue(new Error('x'));
    const r = await fetchMRFeedback(config, 7);
    expect(r.checks[0].summary).toContain('script_failure');
  });

  it('skips checks without head_pipeline', async () => {
    setup({ mr: { ...mr, head_pipeline: null } });
    const r = await fetchMRFeedback(config, 7);
    expect(r.checks).toEqual([]);
    expect(mockFetch.mock.calls.some((c) => String(c[2]).includes('/pipelines/'))).toBe(false);
  });

  it('keeps only unresolved resolvable discussions and ignores system notes', async () => {
    setup({
      discussions: [
        { id: 'aa1', notes: [note({ id: 10, position: { new_path: 'a.ts', new_line: 3 } }), note({ id: 11, body: 'reply' })] },
        { id: 'bb2', notes: [note({ resolved: true })] },
        { id: 'cc3', notes: [note({ resolvable: false })] },
        { id: 'dd4', notes: [note({ system: true, body: 'merged' })] },
        { id: 'ee5', notes: [note({ system: true }), note({ id: 20 })] },
      ],
    });
    const r = await fetchMRFeedback(config, 7);
    expect(r.threads.map((t) => t.id)).toEqual(['thread:aa1', 'thread:ee5']);
    const t = r.threads[0];
    expect(t.title).toBe('a.ts:3');
    expect(t.path).toBe('a.ts');
    expect(t.line).toBe(3);
    expect(t.author).toBe('rev');
    expect(t.url).toBe(`${mr.web_url}#note_10`);
    expect(t.summary).toContain('rev: fix this');
    expect(t.summary).toContain('rev: reply');
    expect(r.threads[1].title).toBe('Review thread');
  });

  it('caps items at MAX_FEEDBACK_ITEMS', async () => {
    setup({
      jobs: Array.from({ length: 80 }, (_, i) => ({ id: i + 1, name: 'n', stage: 's' })),
      discussions: Array.from({ length: 80 }, (_, i) => ({ id: `ab${i}`, notes: [note()] })),
    });
    const r = await fetchMRFeedback(config, 7);
    expect(r.checks).toHaveLength(MAX_FEEDBACK_ITEMS);
    expect(r.threads).toHaveLength(MAX_FEEDBACK_ITEMS);
  });

  it.each([
    [404, 'not_found'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [500, 'gitlab_error'],
  ])('maps HTTP %i to %s', async (status, code) => {
    mockFetch.mockRejectedValue(new GitLabAPIError('boom', status));
    await expect(fetchMRFeedback(config, 7)).rejects.toMatchObject({
      name: 'PRFeedbackError',
      code,
    });
  });

  it('rejects invalid project and iid', async () => {
    await expect(fetchMRFeedback({ ...config, project: ' ' }, 7)).rejects.toBeInstanceOf(PRFeedbackError);
    await expect(fetchMRFeedback(config, 0)).rejects.toMatchObject({ code: 'not_found' });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
