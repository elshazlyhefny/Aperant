/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';
import i18n from '@shared/i18n';
import type { GitLabMergeRequest } from '@shared/types';
import { MergeRequestList } from '../MergeRequestList';

function createMr(overrides: Partial<GitLabMergeRequest> = {}): GitLabMergeRequest {
  return {
    id: 1001,
    iid: 42,
    title: 'Fix the thing',
    state: 'opened',
    sourceBranch: 'feature/thing',
    targetBranch: 'main',
    author: { username: 'alice' },
    assignees: [],
    labels: [],
    webUrl: 'https://gitlab.example.com/group/project/-/merge_requests/42',
    createdAt: '2026-03-05T12:00:00Z',
    updatedAt: '2026-03-06T12:00:00Z',
    mergeStatus: 'can_be_merged',
    ...overrides
  };
}

function renderList(props: Partial<React.ComponentProps<typeof MergeRequestList>> = {}) {
  const handlers = {
    onSelectMr: vi.fn(),
    onRefresh: vi.fn(),
    onStateFilterChange: vi.fn()
  };
  const utils = render(
    <MergeRequestList
      mergeRequests={[createMr()]}
      isLoading={false}
      selectedMrIid={null}
      stateFilter="opened"
      {...handlers}
      {...props}
    />
  );
  return { ...utils, ...handlers };
}

describe('MergeRequestList', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  afterEach(async () => {
    cleanup();
    await i18n.changeLanguage('en');
  });

  it('renders the GitLab link outside any button with an accessible name containing the iid', () => {
    renderList();
    const link = screen.getByRole('link', { name: /42/ });
    expect(link).toHaveAttribute('href', 'https://gitlab.example.com/group/project/-/merge_requests/42');
    expect(link.closest('button')).toBeNull();
  });

  it('keeps the row button a sibling of the link and marks the selected row with aria-current', () => {
    const { onSelectMr, rerender, ...rest } = renderList({ selectedMrIid: 42 });
    const link = screen.getByRole('link', { name: /42/ });
    const rowButton = screen.getByRole('button', { name: /Fix the thing/ });
    expect(rowButton.parentElement).toBe(link.parentElement);
    expect(rowButton).toHaveAttribute('aria-current', 'true');

    rerender(
      <MergeRequestList
        mergeRequests={[createMr()]}
        isLoading={false}
        selectedMrIid={null}
        stateFilter="opened"
        onSelectMr={onSelectMr}
        onRefresh={rest.onRefresh}
        onStateFilterChange={rest.onStateFilterChange}
      />
    );
    expect(screen.getByRole('button', { name: /Fix the thing/ })).not.toHaveAttribute('aria-current');
  });

  it('selects on row click but not on link click', () => {
    const { onSelectMr } = renderList();
    const link = screen.getByRole('link', { name: /42/ });
    link.addEventListener('click', (e) => e.preventDefault());
    fireEvent.click(link);
    expect(onSelectMr).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Fix the thing/ }));
    expect(onSelectMr).toHaveBeenCalledTimes(1);
    expect(onSelectMr).toHaveBeenCalledWith(expect.objectContaining({ iid: 42 }));
  });

  it('exposes the Refresh button by accessible name', () => {
    const { onRefresh } = renderList();
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('exposes filter buttons in a group with aria-pressed state', () => {
    const { onStateFilterChange } = renderList({ stateFilter: 'merged' });
    const group = screen.getByRole('group');
    const buttons = within(group).getAllByRole('button');
    expect(buttons).toHaveLength(4);

    const merged = within(group).getByRole('button', { name: 'Merged' });
    expect(merged).toHaveAttribute('aria-pressed', 'true');
    for (const name of ['Open', 'Closed', 'All']) {
      expect(within(group).getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
    }

    fireEvent.click(within(group).getByRole('button', { name: 'Closed' }));
    expect(onStateFilterChange).toHaveBeenCalledWith('closed');
  });

  it('formats the date using the active i18n language', async () => {
    const mr = createMr({ createdAt: '2026-03-05T12:00:00Z' });

    const en = renderList({ mergeRequests: [mr] });
    expect(screen.getByText(/Mar/)).toBeInTheDocument();
    en.unmount();

    await i18n.changeLanguage('fr');
    renderList({ mergeRequests: [mr] });
    expect(screen.getByText(/mars/)).toBeInTheDocument();
    expect(screen.queryByText(/Mar\b/)).toBeNull();
  });
});
