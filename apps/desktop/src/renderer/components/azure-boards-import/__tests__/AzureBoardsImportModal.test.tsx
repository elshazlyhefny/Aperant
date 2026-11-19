/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { AzureBoardsWorkItem } from '../../../../shared/types';

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

function renderModal() {
  return render(
    <AzureBoardsImportModal projectId="p1" open onOpenChange={vi.fn()} onImportComplete={vi.fn()} />
  );
}

async function runQuery() {
  fireEvent.click(screen.getByRole('button', { name: /boards\.run/ }));
  await screen.findByText('Title 2');
}

describe('AzureBoardsImportModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('shows an error when the query fails', async () => {
    api.queryAzureBoardsWorkItems.mockResolvedValue({ success: false, error: 'WIQL exploded' });
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: /boards\.run/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('WIQL exploded');
  });
});
