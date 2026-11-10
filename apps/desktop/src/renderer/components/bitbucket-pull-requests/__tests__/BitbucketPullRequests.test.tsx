/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../../shared/i18n';
import { BitbucketPullRequests } from '../BitbucketPullRequests';

const getPRs = vi.fn();
Object.defineProperty(window, 'electronAPI', {
  value: {
    getBitbucketPullRequests: getPRs,
    getBitbucketPullRequest: vi.fn(),
    getBitbucketPullRequestDiff: vi.fn(),
    postBitbucketPullRequestComment: vi.fn(),
    openExternal: vi.fn()
  },
  writable: true
});

describe('BitbucketPullRequests', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the loading state', () => {
    getPRs.mockReturnValue(new Promise(() => undefined));
    render(<BitbucketPullRequests projectId="p1" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows the empty state', async () => {
    getPRs.mockResolvedValue({ success: true, data: [] });
    render(<BitbucketPullRequests projectId="p1" />);
    expect(await screen.findByText('No pull requests found')).toBeInTheDocument();
  });

  it('shows the error state with retry', async () => {
    getPRs.mockResolvedValue({ success: false, error: 'boom' });
    render(<BitbucketPullRequests projectId="p1" />);
    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
  });

  it('shows the not configured state and opens settings', async () => {
    getPRs.mockResolvedValue({ success: false, error: 'Bitbucket not configured' });
    const onOpenSettings = vi.fn();
    render(<BitbucketPullRequests projectId="p1" onOpenSettings={onOpenSettings} />);
    const button = await screen.findByRole('button', { name: 'Open Bitbucket Settings' });
    button.click();
    await waitFor(() => expect(onOpenSettings).toHaveBeenCalled());
  });
});
