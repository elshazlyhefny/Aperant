/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { JiraIssue } from '../../../../shared/types';

// Stable references: the hook lists `t` in effect dependencies
const mockT = (key: string, opts?: { count?: number }) =>
  opts?.count !== undefined ? `${key}|${opts.count}` : key;
const mockI18n = { language: 'en' };
const mockTranslation = { t: mockT, i18n: mockI18n };

vi.mock('react-i18next', () => ({
  useTranslation: () => mockTranslation
}));

import { JiraTaskImportModal } from '../JiraTaskImportModal';

function makeIssue(key: string, alreadyImported = false): JiraIssue {
  return {
    id: key,
    key,
    summary: `Summary ${key}`,
    description: '',
    statusName: 'To Do',
    statusCategory: 'new',
    priorityName: 'High',
    issueType: 'Bug',
    labels: ['backend'],
    assigneeName: 'Alice',
    createdAt: '',
    updatedAt: '',
    url: '',
    alreadyImported
  };
}

const api = {
  getJiraProjects: vi.fn(),
  getJiraIssues: vi.fn(),
  importJiraIssues: vi.fn()
};

function renderModal() {
  return render(
    <JiraTaskImportModal projectId="p1" open onOpenChange={vi.fn()} onImportComplete={vi.fn()} />
  );
}

describe('JiraTaskImportModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { electronAPI: unknown }).electronAPI = api;
    api.getJiraProjects.mockResolvedValue({ success: true, data: [] });
    api.getJiraIssues.mockResolvedValue({
      success: true,
      data: { issues: [makeIssue('PROJ-1'), makeIssue('PROJ-2', true)], isLast: true }
    });
    api.importJiraIssues.mockResolvedValue({
      success: true,
      data: { success: true, imported: 1, failed: 0, skipped: [] }
    });
  });

  it('renders issues and the already-imported badge', async () => {
    renderModal();
    expect(await screen.findByText('Summary PROJ-1')).toBeTruthy();
    expect(screen.getByText('Summary PROJ-2')).toBeTruthy();
    expect(screen.getAllByText('import.alreadyImported')).toHaveLength(1);
  });

  async function selectDuplicateAndImport() {
    await screen.findByText('Summary PROJ-2');
    fireEvent.click(screen.getByRole('checkbox', { name: 'PROJ-1' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'PROJ-2' }));
    fireEvent.click(screen.getByRole('button', { name: /import\.importButton/ }));
    await screen.findByText('import.duplicateWarning.title');
  }

  it('skips duplicates with allowDuplicates false', async () => {
    renderModal();
    await selectDuplicateAndImport();
    expect(api.importJiraIssues).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'import.skipReimport' }));
    await waitFor(() =>
      expect(api.importJiraIssues).toHaveBeenCalledWith('p1', ['PROJ-1'], false)
    );
  });

  it('imports duplicates with allowDuplicates true after confirmation', async () => {
    renderModal();
    await selectDuplicateAndImport();
    fireEvent.click(screen.getByRole('button', { name: 'import.confirmReimport' }));
    await waitFor(() =>
      expect(api.importJiraIssues).toHaveBeenCalledWith('p1', ['PROJ-1', 'PROJ-2'], true)
    );
    expect(await screen.findByText('import.successImported|1')).toBeTruthy();
  });
});
