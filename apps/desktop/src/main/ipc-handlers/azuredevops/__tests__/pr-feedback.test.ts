import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils', async () => {
  const actual = await vi.importActual<typeof import('../utils')>('../utils');
  return { ...actual, azureDevOpsFetch: vi.fn(), azureDevOpsFetchText: vi.fn() };
});

import { azureDevOpsFetch, azureDevOpsFetchText, AzureDevOpsAPIError } from '../utils';
import {
  fetchAzureDevOpsPRFeedback,
  parseAzureDevOpsPRIdFromUrl,
  parseAzureDevOpsPullRequestUrl,
} from '../pr-feedback';
import { PRFeedbackError, MAX_SUMMARY_LENGTH } from '../../github/pr/task-feedback';

const mockFetch = vi.mocked(azureDevOpsFetch);
const mockText = vi.mocked(azureDevOpsFetchText);
const config = { organization: 'Org', project: 'My Proj', repository: 'Repo', pat: 'pat' };

const pr = {
  status: 'active',
  sourceRefName: 'refs/heads/feat/x',
  lastMergeSourceCommit: { commitId: 'abc123' },
  repository: { project: { id: 'proj-guid' } },
};

function setup(opts: { pr?: unknown; evaluations?: unknown[]; records?: unknown[]; threads?: unknown[] }) {
  mockFetch.mockImplementation(async (_c: unknown, endpoint: string) => {
    if (endpoint.includes('/policy/evaluations')) return { value: opts.evaluations ?? [] };
    if (endpoint.endsWith('/timeline')) return { records: opts.records ?? [] };
    if (endpoint.includes('/build/builds/')) return { definition: { name: 'CI' } };
    if (endpoint.endsWith('/threads')) return { value: opts.threads ?? [] };
    return opts.pr ?? pr;
  });
}

const failedEval = (over: Record<string, unknown> = {}) => ({
  status: 'rejected',
  configuration: { type: { displayName: 'Build' } },
  context: { buildId: 55 },
  ...over,
});

const thread = (over: Record<string, unknown> = {}) => ({
  id: 3,
  status: 'active',
  comments: [{ content: 'fix this', commentType: 'text', author: { displayName: 'Rev' } }],
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  mockText.mockResolvedValue('log');
});

describe('URL parsing', () => {
  it('parses dev.azure.com and visualstudio.com URLs', () => {
    expect(
      parseAzureDevOpsPullRequestUrl('https://dev.azure.com/Org/My%20Proj/_git/Repo/pullrequest/7')
    ).toEqual({ organization: 'Org', project: 'My Proj', repository: 'Repo', id: 7 });
    expect(parseAzureDevOpsPullRequestUrl('https://org.visualstudio.com/Proj/_git/Repo/pullrequest/9?a=1')).toEqual({
      organization: 'org',
      project: 'Proj',
      repository: 'Repo',
      id: 9,
    });
  });
  it('rejects lookalike hosts, credentials, http and bad paths', () => {
    for (const u of [
      'https://dev.azure.com.evil.com/Org/P/_git/R/pullrequest/7',
      'https://evildev.azure.com/Org/P/_git/R/pullrequest/7',
      'https://evil.com/dev.azure.com/Org/P/_git/R/pullrequest/7',
      'https://x.visualstudio.com.evil.com/P/_git/R/pullrequest/7',
      'https://u:p@dev.azure.com/Org/P/_git/R/pullrequest/7',
      'http://dev.azure.com/Org/P/_git/R/pullrequest/7',
      'https://dev.azure.com/Org/P/_git/R/pullrequest/0',
      'https://dev.azure.com/Org/P/_git/R/pull/7',
      '',
      'nope',
    ]) {
      expect(parseAzureDevOpsPullRequestUrl(u)).toBeNull();
    }
  });
  it('matches configured org/project/repo case-insensitively and refuses others', () => {
    const url = 'https://dev.azure.com/org/my%20proj/_git/repo/pullrequest/7';
    expect(parseAzureDevOpsPRIdFromUrl(url, config)).toBe(7);
    expect(parseAzureDevOpsPRIdFromUrl('https://dev.azure.com/Org/My%20Proj/_git/Other/pullrequest/7', config)).toBeNull();
    expect(parseAzureDevOpsPRIdFromUrl('https://dev.azure.com/Org/Other/_git/Repo/pullrequest/7', config)).toBeNull();
    expect(parseAzureDevOpsPRIdFromUrl('https://dev.azure.com/Else/My%20Proj/_git/Repo/pullrequest/7', config)).toBeNull();
  });
});

describe('fetchAzureDevOpsPRFeedback', () => {
  it('maps PR metadata and states', async () => {
    setup({});
    const r = await fetchAzureDevOpsPRFeedback(config, 7);
    expect(r).toMatchObject({ prNumber: 7, prState: 'open', headRef: 'feat/x', headSha: 'abc123', reviews: [] });
    expect(r.prUrl).toBe('https://dev.azure.com/Org/My%20Proj/_git/Repo/pullrequest/7');
    setup({ pr: { ...pr, status: 'completed' } });
    expect((await fetchAzureDevOpsPRFeedback(config, 7)).prState).toBe('merged');
    setup({ pr: { ...pr, status: 'abandoned' } });
    expect((await fetchAzureDevOpsPRFeedback(config, 7)).prState).toBe('closed');
  });

  it('turns a failed build into a check with redacted log tail', async () => {
    const secret = `ghp_${'a'.repeat(30)}`;
    setup({
      evaluations: [failedEval(), failedEval({ status: 'approved', context: { buildId: 56 } })],
      records: [
        { id: 'r1', name: 'Run tests', type: 'Task', result: 'failed', log: { id: 12 } },
        { id: 'r2', name: 'Lint', type: 'Task', result: 'succeeded', log: { id: 13 } },
      ],
    });
    mockText.mockResolvedValue(`${'x'.repeat(MAX_SUMMARY_LENGTH + 100)}\nlast line ${secret}`);
    const r = await fetchAzureDevOpsPRFeedback(config, 7);
    expect(r.checks).toHaveLength(1);
    const c = r.checks[0];
    expect(c.kind).toBe('check');
    expect(c.title).toBe('CI / Run tests');
    expect(c.truncated).toBe(true);
    expect(c.summary).toContain('last line');
    expect(c.summary).not.toContain(secret);
    expect(c.url).toContain('buildId=55');
    expect(
      mockFetch.mock.calls.some(
        (call) =>
          String(call[1]).includes('policy/evaluations') &&
          String(call[1]).includes(encodeURIComponent('vstfs:///CodeReview/CodeReviewId/proj-guid/7')) &&
          String(call[1]).includes('api-version=7.1-preview.1')
      )
    ).toBe(true);
  });

  it('keeps only active/pending, non-deleted, non-system threads with file and line', async () => {
    setup({
      threads: [
        thread({
          id: 1,
          threadContext: { filePath: '/src/a.ts', rightFileStart: { line: 42 } },
        }),
        thread({ id: 2, status: 'fixed' }),
        thread({ id: 4, status: 'closed' }),
        thread({ id: 5, isDeleted: true }),
        thread({ id: 6, comments: [{ content: 'sys', commentType: 'system' }] }),
        thread({ id: 7, status: 'pending' }),
      ],
    });
    const r = await fetchAzureDevOpsPRFeedback(config, 7);
    expect(r.threads.map((t) => t.id)).toEqual(['thread:1', 'thread:7']);
    expect(r.threads[0]).toMatchObject({
      kind: 'review_thread',
      path: '/src/a.ts',
      line: 42,
      author: 'Rev',
    });
    expect(r.threads[0].summary).toContain('fix this');
  });

  it('maps HTTP errors to typed errors', async () => {
    for (const [status, code] of [
      [404, 'not_found'],
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [500, 'azuredevops_error'],
    ] as const) {
      mockFetch.mockRejectedValue(new AzureDevOpsAPIError('x', status));
      await expect(fetchAzureDevOpsPRFeedback(config, 7)).rejects.toMatchObject({ code });
    }
    await expect(fetchAzureDevOpsPRFeedback(config, 0)).rejects.toBeInstanceOf(PRFeedbackError);
  });
});
