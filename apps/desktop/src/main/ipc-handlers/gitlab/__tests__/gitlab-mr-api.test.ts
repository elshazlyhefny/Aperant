/**
 * Unit tests for GitLab MR API helpers (createGitLabMergeRequest, findOpenMergeRequestForBranch)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createGitLabMergeRequest,
  findOpenMergeRequestForBranch,
  GitLabAPIError
} from '../utils';

const config = {
  token: 'glpat-test-token',
  instanceUrl: 'https://gitlab.example.com',
  project: 'group/my-project'
};

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as unknown as Response;
}

describe('gitlab MR API helpers', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('createGitLabMergeRequest', () => {
    it('POSTs required fields only when optional fields are undefined', async () => {
      fetchMock.mockResolvedValue(okResponse({ id: 1, iid: 7 }));

      const result = await createGitLabMergeRequest(config, {
        sourceBranch: 'feature',
        targetBranch: 'main',
        title: 'My MR'
      });

      expect(result).toEqual({ id: 1, iid: 7 });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://gitlab.example.com/api/v4/projects/group%2Fmy-project/merge_requests');
      expect(init.method).toBe('POST');
      expect(init.headers['PRIVATE-TOKEN']).toBe('glpat-test-token');
      expect(JSON.parse(init.body)).toEqual({
        source_branch: 'feature',
        target_branch: 'main',
        title: 'My MR'
      });
    });

    it('includes optional fields and comma-joins labels', async () => {
      fetchMock.mockResolvedValue(okResponse({ id: 1, iid: 7 }));

      await createGitLabMergeRequest(config, {
        sourceBranch: 'feature',
        targetBranch: 'main',
        title: 'My MR',
        description: 'desc',
        labels: ['a', 'b'],
        assigneeIds: [3],
        removeSourceBranch: true,
        squash: false
      });

      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        source_branch: 'feature',
        target_branch: 'main',
        title: 'My MR',
        description: 'desc',
        labels: 'a,b',
        assignee_ids: [3],
        remove_source_branch: true,
        squash: false
      });
    });

    it('uses numeric project ids as-is', async () => {
      fetchMock.mockResolvedValue(okResponse({ id: 1, iid: 1 }));
      await createGitLabMergeRequest({ ...config, project: '42' }, {
        sourceBranch: 'f',
        targetBranch: 'main',
        title: 't'
      });
      expect(fetchMock.mock.calls[0][0]).toContain('/projects/42/merge_requests');
    });

    it('throws GitLabAPIError with status 409 when an MR already exists', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        text: async () => 'Another open merge request already exists'
      } as unknown as Response);

      const err = await createGitLabMergeRequest(config, {
        sourceBranch: 'feature',
        targetBranch: 'main',
        title: 'My MR'
      }).catch((e) => e);

      expect(err).toBeInstanceOf(GitLabAPIError);
      expect(err.statusCode).toBe(409);
    });
  });

  describe('findOpenMergeRequestForBranch', () => {
    it('builds the query with source and target branch and returns the first MR', async () => {
      fetchMock.mockResolvedValue(okResponse([{ id: 9, iid: 2 }]));

      const mr = await findOpenMergeRequestForBranch(config, 'feat/x y', 'main');

      expect(mr).toEqual({ id: 9, iid: 2 });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        'https://gitlab.example.com/api/v4/projects/group%2Fmy-project/merge_requests?state=opened&source_branch=feat%2Fx%20y&target_branch=main&per_page=1'
      );
      expect(init.headers['PRIVATE-TOKEN']).toBe('glpat-test-token');
    });

    it('omits target_branch when not provided', async () => {
      fetchMock.mockResolvedValue(okResponse([]));
      await findOpenMergeRequestForBranch(config, 'feature');
      expect(fetchMock.mock.calls[0][0]).toContain('state=opened&source_branch=feature&per_page=1');
      expect(fetchMock.mock.calls[0][0]).not.toContain('target_branch');
    });

    it('returns null on an empty list', async () => {
      fetchMock.mockResolvedValue(okResponse([]));
      expect(await findOpenMergeRequestForBranch(config, 'feature', 'main')).toBeNull();
    });
  });
});
