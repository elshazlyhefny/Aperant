/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import type { AzureBoardsImportResult, AzureBoardsWorkItem, IPCResult } from '../../../../shared/types';

// Stable references: the hook lists `t` in effect dependencies
const mockT = (key: string, opts?: { count?: number }) =>
  opts?.count !== undefined ? `${key}|${opts.count}` : key;
const mockI18n = { language: 'en' };
const mockTranslation = { t: mockT, i18n: mockI18n };

vi.mock('react-i18next', () => ({
  useTranslation: () => mockTranslation
}));

import { AzureBoardsImportModal } from '../AzureBoardsImportModal';

function makeItem(id: number, alreadyImported = false): AzureBoardsWorkItem {
  return {
    id,
    title: `Title ${id}`,
    workItemType: 'Bug',
    state: 'Active',
    areaPath: 'Proj\\Team',
    assignedTo: 'Alice',
    tags: ['backend'],
    url: '',
    alreadyImported
  };
}

const api = {
  getAzureBoardsSavedQueries: vi.fn(),
  getAzureBoardsMetadata: vi.fn(),
  queryAzureBoardsWorkItems: vi.fn(),
  importAzureBoardsWorkItems: vi.fn()
};

const mixedImportResult: AzureBoardsImportResult = {
  success: false,
  imported: 1,
  failed: 1,
  skipped: [{ id: 2, specId: '002-b' }],
  errors: ['Failed to import AB#3: boom'],
  items: [
    { id: 1, status: 'imported', specId: '001-a', title: 'Title 1' },
    { id: 2, status: 'skipped', specId: '002-b', title: 'Title 2' },
    { id: 3, status: 'failed', title: 'Title 3', reason: 'boom' }
  ]
};

function renderModal(onImportComplete = vi.fn()) {
  return render(
    <AzureBoardsImportModal projectId="p1" open onOpenChange={vi.fn()} onImportComplete={onImportComplete} />
  );
}

async function runQuery() {
  fireEvent.click(screen.getByRole('button', { name: /boards\.run/ }));
  await screen.findByText('Title 2');
}

async function importMixedBatch() {
  api.queryAzureBoardsWorkItems.mockResolvedValueOnce({
    success: true,
    data: { items: [makeItem(1), makeItem(2), makeItem(3)], totalCount: 3, truncated: false }
  });
  api.importAzureBoardsWorkItems.mockResolvedValueOnce({ success: true, data: mixedImportResult });
  await runQuery();
  fireEvent.click(screen.getByRole('button', { name: 'boards.selectAll' }));
  fireEvent.click(screen.getByRole('button', { name: 'boards.importButton|3' }));
}

describe('AzureBoardsImportModal', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (window as unknown as { electronAPI: unknown }).electronAPI = api;
    api.getAzureBoardsSavedQueries.mockResolvedValue({ success: true, data: [] });
    api.getAzureBoardsMetadata.mockResolvedValue({
      success: true,
      data: { workItemTypes: ['Bug'], states: ['Active'] }
    });
    api.queryAzureBoardsWorkItems.mockResolvedValue({
      success: true,
      data: { items: [makeItem(1), makeItem(2, true)], totalCount: 2, truncated: false }
    });
    api.importAzureBoardsWorkItems.mockResolvedValue({
      success: true,
      data: {
        success: true,
        imported: 1,
        failed: 0,
        skipped: [],
        items: [{ id: 1, status: 'imported', specId: '001-a', title: 'Title 1' }]
      }
    });
  });

  it('does not query until Run query is clicked, then lists items', async () => {
    renderModal();
    await waitFor(() => expect(api.getAzureBoardsMetadata).toHaveBeenCalled());
    expect(api.queryAzureBoardsWorkItems).not.toHaveBeenCalled();
    await runQuery();
    expect(api.queryAzureBoardsWorkItems).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText('boards.alreadyImported')).toHaveLength(1);
    expect(screen.getByRole('listbox').getAttribute('aria-multiselectable')).toBe('true');
  });

  it('selects with the keyboard and imports numeric ids', async () => {
    renderModal();
    await runQuery();
    const options = screen.getAllByRole('option');
    options[0].focus();
    fireEvent.keyDown(options[0], { key: ' ' });
    expect(options[0].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(options[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(options[1]);
    fireEvent.click(screen.getByRole('button', { name: /boards\.importButton/ }));
    await waitFor(() =>
      expect(api.importAzureBoardsWorkItems).toHaveBeenCalledWith('p1', [1], false)
    );
    expect(await screen.findByRole('heading', { name: 'boards.summary.allImported|1' })).toBeTruthy();
  });

  it('selects all with Ctrl+A', async () => {
    renderModal();
    await runQuery();
    const options = screen.getAllByRole('option');
    fireEvent.keyDown(options[0], { key: 'a', ctrlKey: true });
    expect(screen.getAllByRole('option').every((o) => o.getAttribute('aria-selected') === 'true')).toBe(true);
  });

  async function selectDuplicateAndImport() {
    await runQuery();
    for (const option of screen.getAllByRole('option')) fireEvent.click(option);
    fireEvent.click(screen.getByRole('button', { name: /boards\.importButton/ }));
    await screen.findByText('boards.duplicateWarning.title');
  }

  it('skips duplicates with allowDuplicates false', async () => {
    renderModal();
    await selectDuplicateAndImport();
    expect(api.importAzureBoardsWorkItems).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'boards.duplicateWarning.skip' }));
    await waitFor(() =>
      expect(api.importAzureBoardsWorkItems).toHaveBeenCalledWith('p1', [1], false)
    );
  });

  it('imports duplicates with allowDuplicates true after confirmation', async () => {
    renderModal();
    await selectDuplicateAndImport();
    fireEvent.click(screen.getByRole('button', { name: 'boards.duplicateWarning.confirm' }));
    await waitFor(() =>
      expect(api.importAzureBoardsWorkItems).toHaveBeenCalledWith('p1', [1, 2], true)
    );
  });

  it('shows a partial summary with failed rows and retries only the failed id', async () => {
    const onImportComplete = vi.fn();
    renderModal(onImportComplete);
    await importMixedBatch();

    expect(await screen.findByRole('heading', { name: 'boards.summary.partial' })).toBeTruthy();
    expect(screen.getByText('boards.summary.importedCount|1')).toBeTruthy();
    expect(screen.getByText('boards.summary.skippedCount|1')).toBeTruthy();
    expect(screen.getByText('boards.summary.failedCount|1')).toBeTruthy();
    const failedList = screen.getByRole('list', { name: 'boards.summary.failedListLabel' });
    expect(within(failedList).getByRole('listitem').textContent).toContain('boom');
    expect(api.importAzureBoardsWorkItems).toHaveBeenNthCalledWith(1, 'p1', [1, 2, 3], false);

    let resolveRetry!: (result: IPCResult<AzureBoardsImportResult>) => void;
    const pendingRetry = new Promise<IPCResult<AzureBoardsImportResult>>((resolve) => {
      resolveRetry = resolve;
    });
    api.importAzureBoardsWorkItems.mockReturnValueOnce(pendingRetry);
    const retryButton = screen.getByRole<HTMLButtonElement>('button', { name: 'boards.retryFailed|1' });
    // Batch both clicks so the ref guard is exercised before the button re-renders.
    act(() => {
      fireEvent.click(retryButton);
      fireEvent.click(retryButton);
    });
    expect(retryButton.disabled).toBe(true);
    expect(retryButton.getAttribute('aria-busy')).toBe('true');
    expect(api.importAzureBoardsWorkItems).toHaveBeenCalledTimes(2);
    expect(api.importAzureBoardsWorkItems).toHaveBeenNthCalledWith(2, 'p1', [3], false);

    const retryResult: AzureBoardsImportResult = {
      success: true,
      imported: 1,
      failed: 0,
      skipped: [],
      items: [{ id: 3, status: 'imported', specId: '003-c', title: 'Title 3' }]
    };
    await act(async () => {
      resolveRetry({ success: true, data: retryResult });
    });

    const status = within(screen.getByRole('status'));
    expect(status.getByRole('heading', { name: 'boards.summary.allImported|2' })).toBeTruthy();
    expect(status.getByText('boards.summary.importedCount|2')).toBeTruthy();
    expect(status.getByText('boards.summary.skippedCount|1')).toBeTruthy();
    expect(status.getByText('boards.summary.failedCount|0')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^boards\.retry/ })).toBeNull();
    expect(onImportComplete).toHaveBeenCalledTimes(2);
    expect(onImportComplete).toHaveBeenNthCalledWith(2, retryResult);
  });

  it('keeps the summary and shows an error when the retry fails', async () => {
    renderModal();
    await importMixedBatch();
    const retryButton = await screen.findByRole<HTMLButtonElement>('button', { name: 'boards.retryFailed|1' });
    api.importAzureBoardsWorkItems.mockResolvedValueOnce({ success: false, error: 'network down' });

    fireEvent.click(retryButton);

    expect((await screen.findByRole('alert')).textContent).toContain('network down');
    expect(screen.getByRole('heading', { name: 'boards.summary.partial' })).toBeTruthy();
    const failedList = screen.getByRole('list', { name: 'boards.summary.failedListLabel' });
    expect(within(failedList).getByRole('listitem').textContent).toContain('boom');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'boards.retryFailed|1' }).disabled).toBe(false);
  });

  it('shows the zero-imports state', async () => {
    const result: AzureBoardsImportResult = {
      success: false,
      imported: 0,
      failed: 1,
      skipped: [],
      items: [{ id: 1, status: 'failed', title: 'Title 1', reason: 'boom' }]
    };
    api.importAzureBoardsWorkItems.mockResolvedValueOnce({ success: true, data: result });
    renderModal();
    await runQuery();
    fireEvent.click(screen.getAllByRole('option')[0]);
    fireEvent.click(screen.getByRole('button', { name: 'boards.importButton|1' }));

    expect(await screen.findByRole('heading', { name: 'boards.summary.noneImported' })).toBeTruthy();
  });

  it('shows an error when the query fails', async () => {
    api.queryAzureBoardsWorkItems.mockResolvedValue({ success: false, error: 'WIQL exploded' });
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: /boards\.run/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('WIQL exploded');
  });
});
