/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { AzureBoardsQueryResult, AzureBoardsWorkItem, IPCResult } from '../../../../shared/types';

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

function deferQuery() {
  let resolve!: (result: IPCResult<AzureBoardsQueryResult>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<IPCResult<AzureBoardsQueryResult>>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const api = {
  getAzureBoardsSavedQueries: vi.fn(),
  getAzureBoardsMetadata: vi.fn(),
  queryAzureBoardsWorkItems: vi.fn(),
  importAzureBoardsWorkItems: vi.fn()
};

function renderModal() {
  return render(
    <AzureBoardsImportModal projectId="p1" open onOpenChange={vi.fn()} onImportComplete={vi.fn()} />
  );
}

async function runQuery() {
  fireEvent.click(screen.getByRole('button', { name: 'boards.run' }));
  await screen.findByText('Title 2');
}

function importButton() {
  return screen.getByRole<HTMLButtonElement>('button', { name: /boards\.importButton/ });
}

function expectNoImportableResult() {
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(screen.queryByText(/boards\.selectedCount/)).toBeNull();
  expect(screen.queryByText('boards.truncated')).toBeNull();
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(screen.queryByRole('button', { name: 'boards.duplicateWarning.confirm' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'boards.duplicateWarning.skip' })).toBeNull();
  const button = importButton();
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(api.importAzureBoardsWorkItems).not.toHaveBeenCalled();
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
      data: { success: true, imported: 1, failed: 0, skipped: [] }
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
    expect(await screen.findByText('boards.successImported|1')).toBeTruthy();
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

  it('closes the prompt without importing when all selected items are duplicates', async () => {
    renderModal();
    await runQuery();
    fireEvent.click(screen.getByRole('option', { name: /Title 2/ }));
    fireEvent.click(importButton());
    fireEvent.click(screen.getByRole('button', { name: 'boards.duplicateWarning.skip' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.importAzureBoardsWorkItems).not.toHaveBeenCalled();
  });

  it.each([
    {
      failure: 'resolved failure',
      settle: (query: ReturnType<typeof deferQuery>) =>
        query.resolve({ success: false, error: 'WIQL exploded' }),
      error: 'WIQL exploded'
    },
    {
      failure: 'rejected query',
      settle: (query: ReturnType<typeof deferQuery>) => query.reject(new Error('IPC failed')),
      error: 'boards.errors.query'
    }
  ])('blocks stale imports through $failure and requires a fresh selection', async ({ settle, error }) => {
    const failedQuery = deferQuery();
    api.queryAzureBoardsWorkItems
      .mockResolvedValueOnce({
        success: true,
        data: { items: [makeItem(1), makeItem(2, true)], totalCount: 5, truncated: true }
      })
      .mockReturnValueOnce(failedQuery.promise)
      .mockResolvedValueOnce({
        success: true,
        data: { items: [makeItem(3), makeItem(4)], totalCount: 2, truncated: false }
      });

    renderModal();
    await selectDuplicateAndImport();
    expect(screen.getByText('boards.truncated')).toBeTruthy();
    expect(screen.getAllByRole('option', { selected: true })).toHaveLength(2);
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(api.importAzureBoardsWorkItems).not.toHaveBeenCalled();

    const runButton = screen.getByRole('button', { name: 'boards.run' });
    fireEvent.click(runButton);
    expect(screen.getByText('boards.loading')).toBeTruthy();
    expectNoImportableResult();

    await act(async () => settle(failedQuery));
    expect(screen.getByRole('alert').textContent).toContain(error);
    expect(screen.queryByText('boards.loading')).toBeNull();
    expectNoImportableResult();

    fireEvent.click(runButton);
    const freshOption = await screen.findByRole('option', { name: /Title 3/ });
    expect(screen.getAllByRole('option', { selected: false })).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(importButton().disabled).toBe(true);

    fireEvent.click(freshOption);
    expect(importButton().disabled).toBe(false);
    fireEvent.keyDown(freshOption, { key: 'Enter' });
    expect(await screen.findByText('boards.successImported|1')).toBeTruthy();
    expect(api.importAzureBoardsWorkItems).toHaveBeenCalledTimes(1);
    expect(api.importAzureBoardsWorkItems).toHaveBeenCalledWith('p1', [3], false);
  });

  it('ignores a superseded success while a newer Area Path query is pending', async () => {
    const supersededQuery = deferQuery();
    const currentQuery = deferQuery();
    api.queryAzureBoardsWorkItems
      .mockReturnValueOnce(supersededQuery.promise)
      .mockReturnValueOnce(currentQuery.promise);

    renderModal();
    const runButton = screen.getByRole<HTMLButtonElement>('button', { name: 'boards.run' });
    fireEvent.click(runButton);
    expect(runButton.disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'boards.areaPath.label' }), { key: 'Enter' });
    expect(api.queryAzureBoardsWorkItems).toHaveBeenCalledTimes(2);

    await act(async () => {
      supersededQuery.resolve({
        success: true,
        data: { items: [makeItem(1)], totalCount: 3, truncated: true }
      });
    });
    expect(screen.getByText('boards.loading')).toBeTruthy();
    expect(runButton.disabled).toBe(true);
    expectNoImportableResult();

    await act(async () => {
      currentQuery.resolve({ success: true, data: { items: [], totalCount: 0, truncated: false } });
    });
    expect(screen.getByText('boards.empty')).toBeTruthy();
    expect(screen.queryByText('boards.loading')).toBeNull();
    expect(runButton.disabled).toBe(false);
    expectNoImportableResult();
  });
});
