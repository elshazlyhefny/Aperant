/**
 * @vitest-environment jsdom
 */
/**
 * zeenha fork: the GitHub triage dialog driven through the real hook, with
 * window.electronAPI.github mocked. Real i18n, so a missing key shows up as
 * the raw key in an assertion.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../../../../../shared/i18n';
import type { GitHubTriageConfig, GitHubTriageResult } from '../../../../../shared/types';
import { useGitHubTriage } from '../../hooks/useGitHubTriage';
import { IssueListHeader } from '../IssueListHeader';
import { TriageDialog } from '../TriageDialog';

type Listener = (projectId: string, payload: unknown) => void;

const config: GitHubTriageConfig = {
  enabled: false,
  duplicateThreshold: 0.8,
  spamThreshold: 0.75,
  featureCreepThreshold: 0.7,
  enableComments: false,
};

const result = (issueNumber: number, overrides: Partial<GitHubTriageResult> = {}): GitHubTriageResult => ({
  issueNumber,
  repo: 'o/r',
  category: 'bug',
  confidence: 0.92,
  labelsToAdd: ['bug'],
  labelsToRemove: ['needs triage'],
  isDuplicate: false,
  isSpam: false,
  isFeatureCreep: false,
  suggestedBreakdown: [],
  priority: 'high',
  triagedAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

let listeners: { progress: Listener[]; complete: Listener[]; error: Listener[] };
let api: Record<string, ReturnType<typeof vi.fn>>;

function emit(kind: keyof typeof listeners, projectId: string, payload: unknown) {
  act(() => {
    for (const l of listeners[kind]) l(projectId, payload);
  });
}

function Harness({ projectId = 'p1' }: { projectId?: string }) {
  const triage = useGitHubTriage(projectId);
  const [open, setOpen] = useState(true);
  return (
    <TriageDialog
      open={open}
      onOpenChange={setOpen}
      repoFullName="o/r"
      triage={triage}
      issueTitles={new Map([[1, 'App crashes on start']])}
    />
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  listeners = { progress: [], complete: [], error: [] };
  const on = (kind: keyof typeof listeners) =>
    vi.fn((cb: Listener) => {
      listeners[kind].push(cb);
      return () => {
        listeners[kind] = listeners[kind].filter((l) => l !== cb);
      };
    });
  api = {
    getTriageConfig: vi.fn().mockResolvedValue(config),
    saveTriageConfig: vi.fn().mockResolvedValue(true),
    getTriageResults: vi.fn().mockResolvedValue([result(1), result(2, { labelsToAdd: [], labelsToRemove: [], category: 'question' })]),
    runTriage: vi.fn(),
    applyTriageLabels: vi.fn().mockResolvedValue({ success: true, applied: [], failed: [] }),
    onTriageProgress: on('progress'),
    onTriageComplete: on('complete'),
    onTriageError: on('error'),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { github: api };
});

afterEach(() => {
  vi.clearAllMocks();
});

async function renderLoaded() {
  render(<Harness />);
  await screen.findByTestId('triage-result-1');
}

describe('TriageDialog', () => {
  it('loads the saved settings and results when opened', async () => {
    await renderLoaded();

    expect(api.getTriageConfig).toHaveBeenCalledWith('p1');
    expect(screen.getByLabelText('Duplicate')).toHaveValue(80);
    const row = screen.getByTestId('triage-result-1');
    expect(within(row).getByText('App crashes on start')).toBeInTheDocument();
    expect(within(row).getByText('Bug')).toBeInTheDocument();
    expect(within(row).getByText('92% confident')).toBeInTheDocument();
    expect(within(row).getByText('+ bug, − needs triage')).toBeInTheDocument();
    expect(within(screen.getByTestId('triage-result-2')).getByText('No label changes suggested')).toBeInTheDocument();
  });

  it('saves changed thresholds, and refuses a value outside 0-100', async () => {
    await renderLoaded();
    const save = screen.getByRole('button', { name: 'Save thresholds' });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Duplicate'), { target: { value: '150' } });
    expect(screen.getByText('Enter a value from 0 to 100')).toBeInTheDocument();
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Duplicate'), { target: { value: '90' } });
    fireEvent.click(save);

    await screen.findByText('Thresholds saved');
    expect(api.saveTriageConfig).toHaveBeenCalledWith('p1', { ...config, duplicateThreshold: 0.9 });
  });

  it('says so when the thresholds could not be saved', async () => {
    api.saveTriageConfig.mockResolvedValue(false);
    await renderLoaded();

    fireEvent.change(screen.getByLabelText('Spam'), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save thresholds' }));

    await screen.findByText('Could not save the thresholds');
  });

  it('starts a run, shows its progress, and reloads the results when it completes', async () => {
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'Triage again' }));
    expect(api.runTriage).toHaveBeenCalledWith('p1', undefined);
    expect(screen.getByRole('button', { name: 'Triaging…' })).toBeDisabled();

    emit('progress', 'p1', { phase: 'analyzing', progress: 40, message: 'Triaging issue #1 (1/2)...', totalIssues: 2, processedIssues: 1 });
    expect(screen.getByTestId('triage-progress')).toHaveTextContent('Triaging issue #1 (1/2)...');

    api.getTriageResults.mockResolvedValue([result(3)]);
    emit('progress', 'p1', { phase: 'complete', progress: 100, message: 'Triaged 1 issues', totalIssues: 1, processedIssues: 1 });
    emit('complete', 'p1', [result(3)]);

    await screen.findByTestId('triage-result-3');
    expect(screen.getByText('Triaged 1 issues')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Triage again' })).toBeEnabled();
  });

  it('shows a run error, and ignores events for another project', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Triage again' }));

    emit('error', 'other-project', { error: 'not ours' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Triaging…' })).toBeDisabled();

    emit('error', 'p1', { error: 'GitHub is not configured for this project' });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Triage failed');
    expect(alert).toHaveTextContent('GitHub is not configured for this project');
    expect(screen.getByRole('button', { name: 'Triage again' })).toBeEnabled();
  });

  it('offers no selection for a result with nothing to change', async () => {
    await renderLoaded();

    expect(screen.getByRole('checkbox', { name: 'Select issue #2' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Select issue #1' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Apply labels (0)' })).toBeDisabled();
  });

  it('writes labels only after the confirmation, which lists every change', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select issue #1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply labels (1)' }));

    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('Change labels on GitHub?')).toBeInTheDocument();
    expect(within(confirm).getByText(/edits the labels of 1 issue in o\/r/)).toBeInTheDocument();
    expect(within(confirm).getByTestId('triage-confirm-list')).toHaveTextContent('#1 + bug, − needs triage');
    expect(api.applyTriageLabels).not.toHaveBeenCalled();

    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(api.applyTriageLabels).not.toHaveBeenCalled();

    api.applyTriageLabels.mockResolvedValue({
      success: true,
      applied: [{ issueNumber: 1, added: ['bug'], removed: [], skipped: ['needs triage'] }],
      failed: [],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply labels (1)' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Apply labels' }));

    await waitFor(() => expect(api.applyTriageLabels).toHaveBeenCalledWith('p1', [1]));
    const summary = await screen.findByTestId('triage-apply-result');
    expect(summary).toHaveTextContent('Labels updated on 1 issue.');
    expect(summary).toHaveTextContent('#1: not in the repository, skipped: needs triage');
  });

  it('reports the issues that could not be updated and keeps them selected', async () => {
    api.applyTriageLabels.mockResolvedValue({
      success: true,
      applied: [],
      failed: [{ issueNumber: 1, error: 'GitHub API error: 403 - Resource not accessible' }],
    });
    await renderLoaded();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select issue #1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply labels (1)' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Apply labels' }));

    const summary = await screen.findByTestId('triage-apply-result');
    expect(summary).toHaveTextContent('#1 not updated: GitHub API error: 403 - Resource not accessible');
    expect(screen.getByRole('button', { name: 'Apply labels (1)' })).toBeEnabled();
  });

  it('shows why nothing was applied when the request is refused', async () => {
    api.applyTriageLabels.mockResolvedValue({ success: false, error: 'GitHub is not configured for this project', applied: [], failed: [] });
    await renderLoaded();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select issue #1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply labels (1)' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Apply labels' }));

    expect(await screen.findByTestId('triage-apply-result')).toHaveTextContent(
      'Labels were not applied: GitHub is not configured for this project',
    );
  });

  it('renders in French', async () => {
    await i18n.changeLanguage('fr');
    await renderLoaded();

    expect(screen.getByText('Tri des tickets')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Appliquer les étiquettes (0)' })).toBeDisabled();
  });
});

describe('IssueListHeader triage entry point', () => {
  it('opens triage from the issues header', () => {
    const onOpenTriage = vi.fn();
    render(
      <IssueListHeader
        repoFullName="o/r"
        openIssuesCount={3}
        isLoading={false}
        searchQuery=""
        filterState="open"
        onSearchChange={vi.fn()}
        onFilterChange={vi.fn()}
        onRefresh={vi.fn()}
        onOpenTriage={onOpenTriage}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Triage Issues' }));
    expect(onOpenTriage).toHaveBeenCalledTimes(1);
  });
});
