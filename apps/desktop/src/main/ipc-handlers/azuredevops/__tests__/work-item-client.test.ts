/**
 * Unit tests for the Azure Boards work item client
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { getPath: () => '/tmp' } }));

import { addWorkItemComment, setWorkItemState, escapeForWorkItemComment } from '../work-item-client';
import { AzureDevOpsAPIError, MAX_COMMENT_LENGTH, buildAuthHeader } from '../utils';

const config = { organization: 'org', project: 'My Project', pat: 'secret-pat' };
const fetchMock = vi.fn();
const okResponse = { ok: true, status: 200, json: async () => ({}), text: async () => '' };

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

describe('addWorkItemComment', () => {
  it('POSTs the comment to the preview comments endpoint', async () => {
    fetchMock.mockResolvedValue(okResponse);
    await addWorkItemComment(config, 42, '<b>done</b>');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://dev.azure.com/org/My%20Project/_apis/wit/workItems/42/comments?api-version=7.1-preview.4'
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ text: '<b>done</b>' });
    expect(init.headers.Authorization).toBe(buildAuthHeader('secret-pat'));
  });

  it('truncates to MAX_COMMENT_LENGTH', async () => {
    fetchMock.mockResolvedValue(okResponse);
    await addWorkItemComment(config, 1, 'a'.repeat(MAX_COMMENT_LENGTH + 100));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).text).toHaveLength(MAX_COMMENT_LENGTH);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('rejects invalid id %s', async (id) => {
    await expect(addWorkItemComment(config, id, 'x')).rejects.toThrow('Invalid Azure DevOps work item id');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects with AzureDevOpsAPIError on HTTP 400 without leaking the auth header', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => 'nope'
    });
    const err = await addWorkItemComment(config, 5, 'x').catch((e) => e);
    expect(err).toBeInstanceOf(AzureDevOpsAPIError);
    expect(err.statusCode).toBe(400);
    expect(err.message).not.toContain(buildAuthHeader('secret-pat'));
    expect(err.message).not.toContain('secret-pat');
  });
});

describe('setWorkItemState', () => {
  it('PATCHes System.State with a json-patch body', async () => {
    fetchMock.mockResolvedValue(okResponse);
    await setWorkItemState(config, 7, 'Resolved');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://dev.azure.com/org/My%20Project/_apis/wit/workitems/7?api-version=7.1');
    expect(init.method).toBe('PATCH');
    expect(init.headers['Content-Type']).toBe('application/json-patch+json');
    expect(JSON.parse(init.body)).toEqual([{ op: 'add', path: '/fields/System.State', value: 'Resolved' }]);
  });

  it('rejects invalid ids', async () => {
    await expect(setWorkItemState(config, 0, 'Done')).rejects.toThrow('Invalid Azure DevOps work item id');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects with AzureDevOpsAPIError on HTTP 400', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, statusText: 'Bad Request', text: async () => 'bad state' });
    await expect(setWorkItemState(config, 7, 'Nope')).rejects.toBeInstanceOf(AzureDevOpsAPIError);
  });
});

describe('escapeForWorkItemComment', () => {
  it('escapes HTML and converts newlines', () => {
    expect(escapeForWorkItemComment('a & <b> "c"\nd\r\ne')).toBe('a &amp; &lt;b&gt; &quot;c&quot;<br>d<br>e');
  });
});
