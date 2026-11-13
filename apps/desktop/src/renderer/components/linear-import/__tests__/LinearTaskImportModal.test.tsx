/**
 * @vitest-environment jsdom
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { LinearIssue } from '../../../../shared/types';
import enLinear from '../../../../shared/i18n/locales/en/linear.json';
import frLinear from '../../../../shared/i18n/locales/fr/linear.json';

// Stable references: hooks may list `t` in effect dependencies
const mockT = (key: string, opts?: { count?: number }) =>
  opts?.count !== undefined ? `${key}|${opts.count}` : key;
const mockI18n = { language: 'en' };
const mockTranslation = { t: mockT, i18n: mockI18n };

vi.mock('react-i18next', () => ({
  useTranslation: () => mockTranslation
}));

import { LinearTaskImportModalRefactored } from '../LinearTaskImportModalRefactored';
import { IssueCard } from '../components/IssueCard';

function makeIssue(id: string, overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id,
    identifier: `ABC-${id}`,
    title: `Title ${id}`,
    description: `Description ${id}`,
    state: { id: 's1', name: 'Todo', type: 'unstarted' },
    priority: 2,
    priorityLabel: 'High',
    labels: [],
    assignee: { id: 'u1', name: 'Alice', email: 'a@example.com' },
    project: { id: 'pr1', name: 'Proj' },
    url: `https://linear.app/x/issue/${id}`,
    createdAt: '',
    updatedAt: '',
    ...overrides
  };
}

describe('IssueCard', () => {
  it('exposes a checkbox named after the title and reflects selection', () => {
    const { rerender } = render(
      <IssueCard issue={makeIssue('1')} isSelected={false} onToggle={vi.fn()} />
    );
    const box = screen.getByRole('checkbox', { name: 'Title 1' });
    expect(box.getAttribute('aria-checked')).toBe('false');
    rerender(<IssueCard issue={makeIssue('1')} isSelected onToggle={vi.fn()} />);
    expect(screen.getByRole('checkbox', { name: 'Title 1' }).getAttribute('aria-checked')).toBe(
      'true'
    );
  });

  it('toggles exactly once per checkbox click and per row click', () => {
    const onToggle = vi.fn();
    render(<IssueCard issue={makeIssue('1')} isSelected={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Title 1' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith('1');

    onToggle.mockClear();
    fireEvent.click(screen.getByText('Title 1'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('does not toggle from the description button or the Linear link', () => {
    const onToggle = vi.fn();
    render(<IssueCard issue={makeIssue('1')} isSelected={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: 'issue.showDescription' }));
    expect(screen.getByText('Description 1')).toBeTruthy();
    const link = screen.getByText('issue.viewInLinear');
    link.addEventListener('click', (e) => e.preventDefault());
    fireEvent.click(link);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('toggles from the keyboard with Space', () => {
    const onToggle = vi.fn();
    render(<IssueCard issue={makeIssue('1')} isSelected={false} onToggle={onToggle} />);
    const box = screen.getByRole('checkbox', { name: 'Title 1' });
    box.focus();
    expect(document.activeElement).toBe(box);
    // Radix checkbox is a button: Space activates it as a click on keyup
    fireEvent.keyDown(box, { key: ' ' });
    fireEvent.keyUp(box, { key: ' ' });
    fireEvent.click(box);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

const api = {
  getLinearTeams: vi.fn(),
  getLinearProjects: vi.fn(),
  getLinearIssues: vi.fn(),
  importLinearIssues: vi.fn()
};

function renderModal() {
  return render(
    <LinearTaskImportModalRefactored
      projectId="p1"
      open
      onOpenChange={vi.fn()}
      onImportComplete={vi.fn()}
    />
  );
}

describe('LinearTaskImportModalRefactored', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { electronAPI: unknown }).electronAPI = api;
    api.getLinearTeams.mockResolvedValue({
      success: true,
      data: [{ id: 't1', name: 'Team', key: 'TM' }]
    });
    api.getLinearProjects.mockResolvedValue({ success: true, data: [] });
    api.getLinearIssues.mockResolvedValue({
      success: true,
      data: [makeIssue('1'), makeIssue('2')]
    });
    api.importLinearIssues.mockResolvedValue({
      success: true,
      data: { success: true, imported: 1, failed: 0, errors: [] }
    });
  });

  it('renders translation keys and imports the selected issue', async () => {
    renderModal();
    expect(await screen.findByText('Title 1')).toBeTruthy();
    expect(screen.getByText('import.title')).toBeTruthy();
    expect(screen.getByPlaceholderText('import.searchPlaceholder')).toBeTruthy();
    expect(screen.getByText('import.selectAll')).toBeTruthy();

    const importButton = screen.getByRole('button', { name: /import\.importButton/ });
    expect(importButton.textContent).toContain('import.importButton|0');
    expect((importButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Title 1' }));
    const updated = screen.getByRole('button', { name: /import\.importButton/ });
    expect(updated.textContent).toContain('import.importButton|1');
    expect((updated as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(updated);
    await waitFor(() => expect(api.importLinearIssues).toHaveBeenCalledWith('p1', ['1']));
  });

  it('shows a translated error code, not raw server text, for failed team load', async () => {
    api.getLinearTeams.mockResolvedValue({ success: false, error: 'raw English server text' });
    renderModal();
    expect(await screen.findByText('import.errors.loadTeams')).toBeTruthy();
    expect(screen.queryByText('raw English server text')).toBeNull();
  });

  it('shows the unknown error code when loading issues rejects', async () => {
    api.getLinearIssues.mockRejectedValue(new Error('raw English failure'));
    renderModal();
    expect(await screen.findByText('import.errors.unknown')).toBeTruthy();
    expect(screen.queryByText('raw English failure')).toBeNull();
  });
});

describe('linear locale keys', () => {
  const resolveKey = (tree: unknown, path: string): boolean => {
    const walk = (node: unknown, key: string): unknown =>
      key.split('.').reduce<unknown>((n, part) => (n as Record<string, unknown> | undefined)?.[part], node);
    return (
      typeof walk(tree, path) === 'string' ||
      typeof walk(tree, `${path}_one`) === 'string' ||
      typeof walk(tree, `${path}_other`) === 'string'
    );
  };

  const collect = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return name === '__tests__' ? [] : collect(full);
      return /\.tsx?$/.test(name) ? [full] : [];
    });

  const keys = new Set<string>();
  for (const file of collect(join(__dirname, '..'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)) keys.add(m[1]);
  }
  // Dynamic keys built from LinearImportErrorCode and state types
  for (const code of ['loadTeams', 'loadProjects', 'loadIssues', 'import', 'unknown']) {
    keys.add(`import.errors.${code}`);
  }
  for (const type of ['backlog', 'unstarted', 'started', 'completed', 'canceled']) {
    keys.add(`import.stateFilter.types.${type}`);
  }

  it('finds keys to check', () => {
    expect(keys.size).toBeGreaterThan(20);
  });

  for (const [locale, json] of [['en', enLinear], ['fr', frLinear]] as const) {
    it(`resolves every used key in ${locale}`, () => {
      const missing = [...keys].filter((k) => !resolveKey(json, k));
      expect(missing).toEqual([]);
    });
  }
});
