import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const getProject = vi.fn();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, fn);
    },
  },
  app: { getPath: () => '/tmp' },
}));

vi.mock('../../../project-store', () => ({
  projectStore: { getProject: (...args: unknown[]) => getProject(...args) },
}));

import { registerAzureBoardsHandlers } from '../boards-handlers';
import { IPC_CHANNELS } from '../../../../shared/constants';
import type { AzureBoardsImportResult, IPCResult } from '../../../../shared/types';

const PAT = 'SECRET-PAT-VALUE-123';
const GUID = ['abcdef01', 'abcd', 'abcd', 'abcd', 'abcdef012345'].join('-');

function rawItem(id: number, title = `Item ${id}`) {
  return {
    id,
    fields: {
      'System.Title': title,
      'System.WorkItemType': 'Task',
      'System.State': 'New',
      'System.AreaPath': 'Proj',
      'System.Tags': '',
      'System.Description': '<p>Body</p>',
    },
  };
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]
  );
}

describe('Azure Boards IPC handlers', () => {
  let projectDir: string;
  let startSpecCreation: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  const call = <T>(channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args) as Promise<T>;

  const configure = () => {
    mkdirSync(path.join(projectDir, '.auto-claude'), { recursive: true });
    writeFileSync(
      path.join(projectDir, '.auto-claude', '.env'),
      `AZURE_DEVOPS_ORGANIZATION=acme\nAZURE_DEVOPS_PROJECT=Proj\nAZURE_DEVOPS_REPOSITORY=repo\nAZURE_DEVOPS_PAT=${PAT}\n`,
      'utf-8'
    );
  };

  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  /** Routes WIQL calls to the given ids and batch calls to matching raw items */
  const routeFetch = (wiqlIds: number[]) => {
    fetchMock.mockImplementation(async (url: string, init?: { body?: string }) => {
      if (url.includes('/wit/wiql')) return json({ workItems: wiqlIds.map(id => ({ id })) });
      if (url.includes('/wit/workitemsbatch')) {
        const { ids } = JSON.parse(init?.body ?? '{}') as { ids: number[] };
        return json({ value: ids.map(id => rawItem(id)) });
      }
      return json({ value: [] });
    });
  };

  beforeEach(() => {
    handlers.clear();
    projectDir = mkdtempSync(path.join(tmpdir(), 'boards-handlers-'));
    getProject.mockReturnValue({ id: 'p1', path: projectDir, autoBuildPath: '.auto-claude' });
    startSpecCreation = vi.fn();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    registerAzureBoardsHandlers({ startSpecCreation } as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns a not configured error from every handler', async () => {
    for (const channel of [
      IPC_CHANNELS.AZUREBOARDS_GET_SAVED_QUERIES,
      IPC_CHANNELS.AZUREBOARDS_GET_METADATA,
      IPC_CHANNELS.AZUREBOARDS_QUERY_WORK_ITEMS,
      IPC_CHANNELS.AZUREBOARDS_IMPORT_WORK_ITEMS,
    ]) {
      const res = await call<{ success: boolean; error?: string }>(channel, 'p1', {}, [1]);
      expect(res.success).toBe(false);
      expect(res.error).toBe('Azure DevOps not configured');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the saved query endpoint for a saved query request', async () => {
    configure();
    routeFetch([5]);
    const res = await call<{ success: boolean; data: { items: Array<{ id: number }> } }>(
      IPC_CHANNELS.AZUREBOARDS_QUERY_WORK_ITEMS,
      'p1',
      { savedQueryId: GUID }
    );
    expect(res.success).toBe(true);
    expect(res.data.items[0].id).toBe(5);
    expect(fetchMock.mock.calls[0][0]).toContain(`/wit/wiql/${GUID}`);
  });

  it('builds a WIQL POST for a filter request and marks imported items', async () => {
    configure();
    routeFetch([7, 8]);
    await call(IPC_CHANNELS.AZUREBOARDS_IMPORT_WORK_ITEMS, 'p1', [7]);
    fetchMock.mockClear();

    const res = await call<{
      success: boolean;
      data: { items: Array<{ id: number; alreadyImported: boolean; existingSpecId?: string }> };
    }>(IPC_CHANNELS.AZUREBOARDS_QUERY_WORK_ITEMS, 'p1', { filter: { states: ['New'], areaPath: "A'B" } });
    expect(res.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/wit/wiql?');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).query).toContain("'A''B'");
    expect(res.data.items[0].alreadyImported).toBe(true);
    expect(res.data.items[0].existingSpecId).toMatch(/^001/);
    expect(res.data.items[1].alreadyImported).toBe(false);
  });

  it('rejects a malformed filter', async () => {
    configure();
    const res = await call<{ success: boolean }>(IPC_CHANNELS.AZUREBOARDS_QUERY_WORK_ITEMS, 'p1', {
      filter: { states: 'New' },
    });
    expect(res.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('imports one spec with azure_boards metadata and skips it the second time', async () => {
    configure();
    routeFetch([42]);
    const first = await call<IPCResult<AzureBoardsImportResult>>(
      IPC_CHANNELS.AZUREBOARDS_IMPORT_WORK_ITEMS,
      'p1',
      [42, 42]
    );
    expect(first).toMatchObject({ success: true, data: { success: true, imported: 1, failed: 0, skipped: [] } });
    expect(startSpecCreation).toHaveBeenCalledTimes(1);

    const specsDir = path.join(projectDir, '.auto-claude', 'specs');
    const [specName] = readdirSync(specsDir);
    expect(first.data?.items).toEqual([{ id: 42, status: 'imported', specId: specName, title: 'Item 42' }]);
    const meta = JSON.parse(readFileSync(path.join(specsDir, specName, 'task_metadata.json'), 'utf-8'));
    expect(meta).toMatchObject({
      sourceType: 'azure_boards',
      azureBoardsWorkItemId: 42,
      azureBoardsUrl: 'https://dev.azure.com/acme/Proj/_workitems/edit/42',
    });
    expect(startSpecCreation.mock.calls[0][4]).toMatchObject({ sourceType: 'azure_boards' });

    const second = await call<{ data: AzureBoardsImportResult }>(
      IPC_CHANNELS.AZUREBOARDS_IMPORT_WORK_ITEMS,
      'p1',
      [42]
    );
    expect(second.data.imported).toBe(0);
    expect(second.data.skipped).toEqual([{ id: 42, specId: specName }]);
    expect(second.data.items).toEqual([{ id: 42, status: 'skipped', specId: specName, title: 'Item 42' }]);
    expect(startSpecCreation).toHaveBeenCalledTimes(1);
  });

  it('creates one new spec for an explicit re-import even if the request repeats the ID', async () => {
    configure();
    const id = 42;
    routeFetch([id]);
    const first = await call<IPCResult<AzureBoardsImportResult>>(
      IPC_CHANNELS.AZUREBOARDS_IMPORT_WORK_ITEMS,
      'p1',
      [id]
    );
    const success = { success: true, data: { success: true, imported: 1, failed: 0, skipped: [] } };
    expect(first).toMatchObject(success);

    const specsDir = path.join(projectDir, '.auto-claude', 'specs');
    const originalSpecs = readdirSync(specsDir);
    expect(originalSpecs).toHaveLength(1);
    const [originalSpecId] = originalSpecs;
    expect(originalSpecId).toMatch(/^001-/);

    fetchMock.mockClear();
    const reimport = await call<IPCResult<AzureBoardsImportResult>>(
      IPC_CHANNELS.AZUREBOARDS_IMPORT_WORK_ITEMS,
      'p1',
      [id, id],
      true
    );
    expect(reimport).toMatchObject(success);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).ids).toEqual([id]);

    const specs = readdirSync(specsDir).sort();
    expect(specs).toEqual([originalSpecId, expect.stringMatching(/^002-/)]);
    const [, newSpecId] = specs;
    for (const specId of specs) {
      const meta = JSON.parse(readFileSync(path.join(specsDir, specId, 'task_metadata.json'), 'utf-8'));
      expect(meta).toMatchObject({
        sourceType: 'azure_boards',
        azureBoardsOrganization: 'acme',
        azureBoardsProject: 'Proj',
        azureBoardsWorkItemId: id,
      });
    }
    expect(startSpecCreation.mock.calls.map(([specId]) => specId)).toEqual([originalSpecId, newSpecId]);
  });

  it('reuses the same spec when two ordinary imports overlap', async () => {
    configure();
    const id = 42;
    let releaseBatch!: () => void;
    const batchGate = new Promise<void>(resolve => {
      releaseBatch = resolve;
    });
    fetchMock.mockImplementation(async (url: string) => {
      expect(url).toContain('/wit/workitemsbatch');
      // Both requests must reach the batch fetch before either response is released.
      if (fetchMock.mock.calls.length === 2) releaseBatch();
      await batchGate;
      return json({ value: [rawItem(id)] });
    });

    const importItem = () =>
      call<IPCResult<AzureBoardsImportResult>>(IPC_CHANNELS.AZUREBOARDS_IMPORT_WORK_ITEMS, 'p1', [id]);
    const responses = await Promise.all([importItem(), importItem()]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const results = responses.map(response => {
      expect(response.success).toBe(true);
      expect(response.data).toMatchObject({ success: true, failed: 0 });
      return response.data;
    });

    expect(results.map(result => result?.imported).sort()).toEqual([0, 1]);
    const winner = results.find(result => result?.imported === 1);
    const reused = results.find(result => result?.imported === 0);
    expect(winner?.skipped).toEqual([]);

    const specsDir = path.join(projectDir, '.auto-claude', 'specs');
    const specs = readdirSync(specsDir);
    expect(specs).toHaveLength(1);
    const [specId] = specs;
    expect(reused?.skipped).toEqual([{ id, specId }]);
    const meta = JSON.parse(readFileSync(path.join(specsDir, specId, 'task_metadata.json'), 'utf-8'));
    expect(meta).toMatchObject({
      sourceType: 'azure_boards',
      azureBoardsOrganization: 'acme',
      azureBoardsProject: 'Proj',
      azureBoardsWorkItemId: id,
    });
    expect(startSpecCreation).toHaveBeenCalledTimes(1);
    expect(startSpecCreation.mock.calls[0][0]).toBe(specId);
  });

  it('rejects 101 ids and invalid ids without calling Azure', async () => {
    configure();
    const tooMany = await call<{ success: boolean; error?: string }>(
      IPC_CHANNELS.AZUREBOARDS_IMPORT_WORK_ITEMS,
      'p1',
      Array.from({ length: 101 }, (_, i) => i + 1)
    );
    expect(tooMany.success).toBe(false);
    expect(tooMany.error).toContain('100');

    for (const bad of [[0], [-1], [1.5], ['7'], [], 'x']) {
      const res = await call<{ success: boolean }>(IPC_CHANNELS.AZUREBOARDS_IMPORT_WORK_ITEMS, 'p1', bad);
      expect(res.success).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports items missing in Azure as per-item errors', async () => {
    configure();
    fetchMock.mockImplementation(async () => json({ value: [] }));
    const res = await call<{ data: AzureBoardsImportResult }>(
      IPC_CHANNELS.AZUREBOARDS_IMPORT_WORK_ITEMS,
      'p1',
      [9]
    );
    expect(res.data.failed).toBe(1);
    expect(res.data.errors?.[0]).toContain('AB#9');
    expect(res.data.items).toEqual([{ id: 9, status: 'failed', reason: expect.stringContaining('not found') }]);
  });

  it('reports mixed import outcomes in request order', async () => {
    configure();
    routeFetch([1]);
    await call(IPC_CHANNELS.AZUREBOARDS_IMPORT_WORK_ITEMS, 'p1', [1]);
    fetchMock.mockResolvedValueOnce(json({ value: [rawItem(2), rawItem(1)] }));

    const res = await call<{ success: boolean; data: AzureBoardsImportResult }>(
      IPC_CHANNELS.AZUREBOARDS_IMPORT_WORK_ITEMS,
      'p1',
      [1, 2, 3]
    );

    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ success: false, imported: 1, failed: 1 });
    expect(res.data.skipped).toHaveLength(1);
    expect(res.data.items).toEqual([
      { id: 1, status: 'skipped', specId: res.data.skipped[0].specId, title: 'Item 1' },
      { id: 2, status: 'imported', specId: expect.any(String), title: 'Item 2' },
      { id: 3, status: 'failed', reason: 'work item not found in Azure DevOps' },
    ]);
  });

  it('reports the title and reason when starting spec creation throws', async () => {
    configure();
    routeFetch([8]);
    startSpecCreation.mockImplementationOnce(() => {
      throw new Error('Could not start spec creation');
    });

    const res = await call<{ data: AzureBoardsImportResult }>(
      IPC_CHANNELS.AZUREBOARDS_IMPORT_WORK_ITEMS,
      'p1',
      [8]
    );

    expect(res.data.items).toEqual([
      { id: 8, status: 'failed', title: 'Item 8', reason: 'Could not start spec creation' },
    ]);
    expect(res.data.errors).toEqual(['Failed to import AB#8: Could not start spec creation']);
  });

  it('skips known items omitted by Azure but reports missing items that require creation', async () => {
    configure();
    const existingId = 7;
    const missingId = 9;
    routeFetch([existingId]);
    const importItems = (ids: number[], allowDuplicates?: boolean) =>
      call<IPCResult<AzureBoardsImportResult>>(IPC_CHANNELS.AZUREBOARDS_IMPORT_WORK_ITEMS, 'p1', ids, allowDuplicates);
    const first = await importItems([existingId]);
    expect(first).toMatchObject({ success: true, data: { success: true, imported: 1, failed: 0 } });
    const specsDir = path.join(projectDir, '.auto-claude', 'specs');
    const [specId] = readdirSync(specsDir);

    fetchMock.mockResolvedValue(json({ value: [] }));
    const ordinary = await importItems([existingId, missingId]);
    expect(ordinary).toMatchObject({
      success: true,
      data: {
        success: false,
        imported: 0,
        failed: 1,
        skipped: [{ id: existingId, specId }],
        errors: [`Failed to import AB#${missingId}: work item not found in Azure DevOps`],
        items: [
          { id: existingId, status: 'skipped', specId },
          { id: missingId, status: 'failed', reason: 'work item not found in Azure DevOps' },
        ],
      },
    });

    const explicit = await importItems([existingId], true);
    expect(explicit).toMatchObject({
      success: true,
      data: {
        success: false,
        imported: 0,
        failed: 1,
        skipped: [],
        errors: [`Failed to import AB#${existingId}: work item not found in Azure DevOps`],
      },
    });
    expect(readdirSync(specsDir)).toEqual([specId]);
    expect(startSpecCreation).toHaveBeenCalledTimes(1);
  });

  it('never leaks the PAT in returned errors or written files', async () => {
    configure();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'denied',
      json: async () => ({}),
    });
    const res = await call<{ success: boolean; error?: string }>(IPC_CHANNELS.AZUREBOARDS_GET_METADATA, 'p1');
    expect(res.success).toBe(false);
    expect(res.error).toContain('401');
    expect(res.error).not.toContain(PAT);

    const imp = await call<{ success: boolean; error?: string }>(IPC_CHANNELS.AZUREBOARDS_IMPORT_WORK_ITEMS, 'p1', [1]);
    expect(JSON.stringify(imp)).not.toContain(PAT);

    routeFetch([3]);
    await call(IPC_CHANNELS.AZUREBOARDS_IMPORT_WORK_ITEMS, 'p1', [3]);
    const specsDir = path.join(projectDir, '.auto-claude', 'specs');
    for (const f of walk(specsDir)) {
      expect(readFileSync(f, 'utf-8')).not.toContain(PAT);
    }
  });
});
