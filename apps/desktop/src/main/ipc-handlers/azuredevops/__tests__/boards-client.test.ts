/**
 * Unit tests for the Azure Boards client
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { getPath: () => '/tmp' } }));

import {
  buildWiql,
  runWiql,
  getWorkItemsByIds,
  htmlToMarkdown,
  buildWorkItemUrl,
  listSavedQueries,
  getBoardsMetadata
} from '../boards-client';

const config = { organization: 'org', project: 'My Project', pat: 'super-secret-pat' };
const fetchMock = vi.fn();
const jsonResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

describe('buildWiql', () => {
  it('builds the base query', () => {
    expect(buildWiql({})).toBe(
      'SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project ORDER BY [System.ChangedDate] DESC'
    );
  });
  it('uses UNDER and IN clauses', () => {
    const q = buildWiql({ areaPath: 'P\\Team', states: ['New', 'Active'], workItemTypes: ['Bug'] });
    expect(q).toContain("[System.AreaPath] UNDER 'P\\Team'");
    expect(q).toContain("[System.State] IN ('New', 'Active')");
    expect(q).toContain("[System.WorkItemType] IN ('Bug')");
  });
  it('doubles single quotes in literals', () => {
    const q = buildWiql({ areaPath: "O'Brien", states: ["It's"] });
    expect(q).toContain("UNDER 'O''Brien'");
    expect(q).toContain("IN ('It''s')");
  });
});

describe('runWiql', () => {
  it('rejects a non-GUID saved query id without fetching', async () => {
    await expect(runWiql(config, { savedQueryId: '../evil' })).rejects.toThrow('Invalid saved query id');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('runs a saved query via GET', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ workItems: [{ id: 3 }, { id: 1 }] }));
    const id = ['aaaaaaaa', 'bbbb', 'cccc', 'dddd', 'eeeeeeeeeeee'].join('-');
    const result = await runWiql(config, { savedQueryId: id });
    expect(result).toEqual({ ids: [3, 1], truncated: false });
    expect(fetchMock.mock.calls[0][0]).toContain(`/wit/wiql/${id}`);
  });
  it('POSTs a filter query with $top=200 and flags truncation', async () => {
    const workItems = Array.from({ length: 200 }, (_, i) => ({ id: i + 1 }));
    fetchMock.mockResolvedValue(jsonResponse({ workItems }));
    const result = await runWiql(config, { filter: { states: ["O'Brien"] } });
    expect(result.ids).toHaveLength(200);
    expect(result.truncated).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/wit/wiql?$top=200');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).query).toContain("'O''Brien'");
  });
});

describe('getWorkItemsByIds', () => {
  it('chunks requests above 200 ids and keeps order', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => i + 1);
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { ids: number[]; fields: string[] };
      expect(body.ids.length).toBeLessThanOrEqual(200);
      expect(body.fields).toContain('System.Title');
      return jsonResponse({
        value: body.ids.map((id) => ({ id, fields: { 'System.Id': id, 'System.Title': `T${id}` } }))
      });
    });
    const items = await getWorkItemsByIds(config, ids);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(items.map((i) => i.id)).toEqual(ids);
  });
  it('normalizes fields', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        value: [
          {
            id: 7,
            fields: {
              'System.Title': 'Hello',
              'System.WorkItemType': 'Bug',
              'System.State': 'New',
              'System.AreaPath': 'P\\A',
              'System.AssignedTo': { displayName: 'Ann', uniqueName: 'ann@x.com' },
              'System.Tags': 'a; b',
              'System.Description': '<p>Desc</p>',
              'Microsoft.VSTS.Common.Priority': 2
            }
          }
        ]
      })
    );
    const [item] = await getWorkItemsByIds(config, [7]);
    expect(item).toMatchObject({
      id: 7,
      title: 'Hello',
      assignedTo: 'Ann',
      tags: ['a', 'b'],
      description: 'Desc',
      priority: 2,
      url: 'https://dev.azure.com/org/My%20Project/_workitems/edit/7'
    });
  });
  it('rejects invalid ids', async () => {
    await expect(getWorkItemsByIds(config, [1, 0])).rejects.toThrow('Invalid work item id');
    await expect(getWorkItemsByIds(config, [1.5])).rejects.toThrow('Invalid work item id');
    await expect(getWorkItemsByIds(config, [-3])).rejects.toThrow('Invalid work item id');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('htmlToMarkdown', () => {
  it('converts breaks, paragraphs and lists', () => {
    expect(htmlToMarkdown('<p>One</p><p>Two<br>three</p><ul><li>a</li><li>b</li></ul>')).toBe(
      'One\n\nTwo\nthree\n\n- a\n- b'
    );
  });
  it('decodes entities and drops script/style', () => {
    expect(htmlToMarkdown('<style>x{}</style><script>alert(1)</script>a &lt;b&gt; &amp; &quot;c&quot;&nbsp;d')).toBe(
      'a <b> & "c" d'
    );
  });
  it('handles empty input', () => {
    expect(htmlToMarkdown(undefined)).toBe('');
    expect(htmlToMarkdown('')).toBe('');
  });
});

describe('buildWorkItemUrl', () => {
  it('builds the edit url and rejects bad ids', () => {
    expect(buildWorkItemUrl({ organization: 'org', project: 'proj' }, 12)).toBe(
      'https://dev.azure.com/org/proj/_workitems/edit/12'
    );
    expect(() => buildWorkItemUrl({ organization: 'org', project: 'proj' }, 0)).toThrow();
  });
});

describe('listSavedQueries / getBoardsMetadata', () => {
  it('flattens folders to queries', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        value: [
          {
            name: 'Shared Queries',
            isFolder: true,
            children: [
              { id: 'q1', name: 'Mine', path: 'Shared Queries/Mine', isFolder: false },
              { name: 'Sub', isFolder: true, children: [{ id: 'q2', name: 'Deep', path: 'Shared Queries/Sub/Deep' }] }
            ]
          }
        ]
      })
    );
    expect(await listSavedQueries(config)).toEqual([
      { id: 'q1', name: 'Mine', path: 'Shared Queries/Mine' },
      { id: 'q2', name: 'Deep', path: 'Shared Queries/Sub/Deep' }
    ]);
    expect(fetchMock.mock.calls[0][0]).toContain('/wit/queries?$depth=2&$expand=none');
  });
  it('returns type names and the union of states', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        value: [
          { name: 'Bug', states: [{ name: 'New' }, { name: 'Active' }] },
          { name: 'Task', states: [{ name: 'New' }, { name: 'Done' }] }
        ]
      })
    );
    expect(await getBoardsMetadata(config)).toEqual({
      workItemTypes: ['Bug', 'Task'],
      states: ['New', 'Active', 'Done']
    });
  });
});

describe('PAT safety', () => {
  it('never includes the PAT in thrown errors', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'denied'
    });
    const calls = [
      () => listSavedQueries(config),
      () => getBoardsMetadata(config),
      () => runWiql(config, { filter: {} }),
      () => getWorkItemsByIds(config, [1])
    ];
    for (const call of calls) {
      const err = await call().catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      const b64 = Buffer.from(`:${config.pat}`).toString('base64');
      expect((err as Error).message).not.toContain(config.pat);
      expect((err as Error).message).not.toContain(b64);
    }
  });
});
