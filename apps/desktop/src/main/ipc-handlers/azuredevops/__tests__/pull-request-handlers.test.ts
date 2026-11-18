/**
 * Unit tests for Azure DevOps pull request handlers
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const handlers = new Map<string, (...args: any[]) => Promise<any>>();
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...args: any[]) => Promise<any>) => handlers.set(ch, fn) },
  app: { getPath: () => '/tmp' }
}));

const getProject = vi.fn();
vi.mock('../../../project-store', () => ({ projectStore: { getProject: (...a: unknown[]) => getProject(...a) } }));

const getConfig = vi.fn();
vi.mock('../utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils')>()),
  getAzureDevOpsConfig: (...a: unknown[]) => getConfig(...a)
}));

import { IPC_CHANNELS } from '../../../../shared/constants';
import {
  transformPullRequest,
  isValidPullRequestState,
  isValidPrId,
  VALID_PR_STATES,
  registerGetPullRequests,
  registerGetPullRequest,
  registerPostPullRequestComment
} from '../pull-request-handlers';
import { MAX_COMMENT_LENGTH } from '../utils';

const config = { organization: 'org', project: 'My Project', repository: 'repo', pat: 'pat' };
const fetchMock = vi.fn();
const jsonResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });

const apiPr = {
  pullRequestId: 7,
  title: 'Add thing',
  description: 'desc',
  status: 'completed',
  sourceRefName: 'refs/heads/feat',
  targetRefName: 'refs/heads/main',
  createdBy: { displayName: 'Alice', imageUrl: 'https://a/x.png' },
  reviewers: [{ displayName: 'Bob' }],
  creationDate: '2024-01-01T00:00:00Z',
  closedDate: '2024-01-02T00:00:00Z'
};

beforeEach(() => {
  handlers.clear();
  fetchMock.mockReset();
  getProject.mockReset();
  getConfig.mockReset();
  getProject.mockReturnValue({ id: 'p', path: '/tmp/p' });
  getConfig.mockResolvedValue(config);
  vi.stubGlobal('fetch', fetchMock);
});

describe('transformPullRequest', () => {
  it('transforms a full payload', () => {
    expect(transformPullRequest(apiPr, config)).toEqual({
      id: 7,
      title: 'Add thing',
      description: 'desc',
      state: 'MERGED',
      sourceBranch: 'feat',
      targetBranch: 'main',
      author: { displayName: 'Alice', avatarUrl: 'https://a/x.png' },
      reviewers: [{ displayName: 'Bob', avatarUrl: undefined }],
      commentCount: 0,
      webUrl: 'https://dev.azure.com/org/My%20Project/_git/repo/pullrequest/7',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z'
    });
  });

  it.each([
    ['active', 'OPEN'],
    ['completed', 'MERGED'],
    ['abandoned', 'DECLINED'],
    ['weird', 'OPEN']
  ])('maps status %s to %s', (status, state) => {
    expect(transformPullRequest({ pullRequestId: 1, status }, config).state).toBe(state);
  });

  it('handles sparse payloads', () => {
    const pr = transformPullRequest({ pullRequestId: 1, createdBy: null, description: null }, config);
    expect(pr.title).toBe('');
    expect(pr.author).toEqual({ displayName: '', avatarUrl: undefined });
    expect(pr.reviewers).toEqual([]);
    expect(pr.description).toBeUndefined();
    expect(pr.updatedAt).toBe(pr.createdAt);
  });
});

describe('validators', () => {
  it.each([...VALID_PR_STATES])('accepts state %s', (s) => expect(isValidPullRequestState(s)).toBe(true));
  it.each(['open', 'SUPERSEDED', '', 'OPEN&x=1'])('rejects state %j', (s) => {
    expect(isValidPullRequestState(s)).toBe(false);
  });
  it('validates PR ids', () => {
    expect(isValidPrId(3)).toBe(true);
    for (const bad of [0, -1, 1.5, '3', null, undefined]) expect(isValidPrId(bad)).toBe(false);
  });
});

describe('handlers', () => {
  it('lists pull requests, mapping ALL to status=all', async () => {
    registerGetPullRequests();
    fetchMock.mockResolvedValue(jsonResponse({ value: [apiPr], count: 1 }));
    const res = await handlers.get(IPC_CHANNELS.AZUREDEVOPS_GET_PULL_REQUESTS)!({}, 'p', 'ALL');
    expect(res.success).toBe(true);
    expect(res.data).toHaveLength(1);
    expect(fetchMock.mock.calls[0][0]).toContain('searchCriteria.status=all&$top=50');
  });

  it('maps MERGED to completed and rejects an invalid state', async () => {
    registerGetPullRequests();
    fetchMock.mockResolvedValue(jsonResponse({ value: [] }));
    const handler = handlers.get(IPC_CHANNELS.AZUREDEVOPS_GET_PULL_REQUESTS)!;
    await handler({}, 'p', 'MERGED');
    expect(fetchMock.mock.calls[0][0]).toContain('searchCriteria.status=completed');
    expect((await handler({}, 'p', 'nope')).success).toBe(false);
  });

  it('returns an error for unknown projects and missing config', async () => {
    registerGetPullRequest();
    const handler = handlers.get(IPC_CHANNELS.AZUREDEVOPS_GET_PULL_REQUEST)!;
    getProject.mockReturnValue(undefined);
    expect(await handler({}, 'x', 1)).toEqual({ success: false, error: 'Project not found' });
    getProject.mockReturnValue({ id: 'p' });
    getConfig.mockResolvedValue(null);
    expect(await handler({}, 'p', 1)).toEqual({ success: false, error: 'Azure DevOps not configured' });
  });

  it('gets a single pull request and validates the id', async () => {
    registerGetPullRequest();
    fetchMock.mockResolvedValue(jsonResponse(apiPr));
    const handler = handlers.get(IPC_CHANNELS.AZUREDEVOPS_GET_PULL_REQUEST)!;
    const res = await handler({}, 'p', 7);
    expect(res.data.id).toBe(7);
    expect(fetchMock.mock.calls[0][0]).toContain('/pullrequests/7?');
    expect((await handler({}, 'p', -2)).success).toBe(false);
  });

  it('posts a comment thread and returns its id', async () => {
    registerPostPullRequestComment();
    fetchMock.mockResolvedValue(jsonResponse({ id: 42 }));
    const handler = handlers.get(IPC_CHANNELS.AZUREDEVOPS_POST_PULL_REQUEST_COMMENT)!;
    expect(await handler({}, 'p', 7, 'hi')).toEqual({ success: true, data: { id: 42 } });
    expect((await handler({}, 'p', 7, '  ')).success).toBe(false);
    expect((await handler({}, 'p', 7, 'x'.repeat(MAX_COMMENT_LENGTH + 1))).success).toBe(false);
  });
});
