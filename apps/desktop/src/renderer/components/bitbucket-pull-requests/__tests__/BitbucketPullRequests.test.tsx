/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../../shared/i18n';
import { BitbucketPullRequests } from '../BitbucketPullRequests';

const getPRs = vi.fn();
const getPR = vi.fn();
const getDiff = vi.fn();
const runReview = vi.fn();
Object.defineProperty(window, 'electronAPI', {
  value: {
    getBitbucketPullRequests: getPRs,
    getBitbucketPullRequest: getPR,
    getBitbucketPullRequestDiff: getDiff,
    getBitbucketPRReview: vi.fn().mockResolvedValue(null),
    runBitbucketPRReview: runReview,
    cancelBitbucketPRReview: vi.fn().mockResolvedValue(false),
    getBitbucketPRLogs: vi.fn().mockResolvedValue(null),
    postBitbucketPRReview: vi.fn(),
    onBitbucketPRReviewProgress: vi.fn(() => () => {}),
    onBitbucketPRReviewComplete: vi.fn(() => () => {}),
    onBitbucketPRReviewError: vi.fn(() => () => {}),
    onBitbucketPRLogsUpdated: vi.fn(() => () => {}),
    postBitbucketPullRequestComment: vi.fn(),
    openExternal: vi.fn()
  },
  writable: true
});

describe('BitbucketPullRequests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window.electronAPI.getBitbucketPRReview as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (window.electronAPI.getBitbucketPRLogs as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  });

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

  it('starts an AI review for the selected PR', async () => {
    const pr = {
      id: 7,
      title: 'Add thing',
      description: '',
      state: 'OPEN',
      sourceBranch: 'feat',
      targetBranch: 'main',
      author: { displayName: 'Ann' },
      reviewers: [],
      commentCount: 0,
      webUrl: 'https://bitbucket.org/x/y/pull-requests/7'
    };
    getPRs.mockResolvedValue({ success: true, data: [pr] });
    getPR.mockResolvedValue({ success: true, data: pr });
    getDiff.mockResolvedValue({ success: true, data: '' });
    render(<BitbucketPullRequests projectId="p1" />);
    fireEvent.click(await screen.findByText(/#7 Add thing/));
    fireEvent.click(await screen.findByRole('button', { name: /Start AI review/i }));
    expect(runReview).toHaveBeenCalledWith('p1', 7);
  });
});
