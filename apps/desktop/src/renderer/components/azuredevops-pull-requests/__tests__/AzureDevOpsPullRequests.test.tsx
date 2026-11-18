/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../../shared/i18n';
import { AzureDevOpsPullRequests } from '../AzureDevOpsPullRequests';

const api = {
  getAzureDevOpsPullRequests: vi.fn(),
  getAzureDevOpsPullRequest: vi.fn(),
  getAzureDevOpsPullRequestDiff: vi.fn(),
  getAzureDevOpsPRReview: vi.fn(),
  runAzureDevOpsPRReview: vi.fn(),
  cancelAzureDevOpsPRReview: vi.fn().mockResolvedValue(false),
  getAzureDevOpsPRLogs: vi.fn(),
  postAzureDevOpsPRReview: vi.fn(),
  postAzureDevOpsPullRequestComment: vi.fn(),
  onAzureDevOpsPRReviewProgress: vi.fn(() => () => {}),
  onAzureDevOpsPRReviewComplete: vi.fn(() => () => {}),
  onAzureDevOpsPRReviewError: vi.fn(() => () => {}),
  onAzureDevOpsPRLogsUpdated: vi.fn(() => () => {}),
  openExternal: vi.fn()
};
Object.defineProperty(window, 'electronAPI', { value: api, writable: true });

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
  webUrl: 'https://dev.azure.com/org/proj/_git/repo/pullrequest/7'
};

async function selectPR() {
  api.getAzureDevOpsPullRequests.mockResolvedValue({ success: true, data: [pr] });
  api.getAzureDevOpsPullRequest.mockResolvedValue({ success: true, data: pr });
  api.getAzureDevOpsPullRequestDiff.mockResolvedValue({ success: true, data: '' });
  render(<AzureDevOpsPullRequests projectId="p1" />);
  fireEvent.click(await screen.findByText(/#7 Add thing/));
}

describe('AzureDevOpsPullRequests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getAzureDevOpsPRReview.mockResolvedValue(null);
    api.getAzureDevOpsPRLogs.mockResolvedValue(null);
  });

  it('lists PRs and shows detail with the AI review button', async () => {
    await selectPR();
    expect(await screen.findByRole('button', { name: /Start AI review/i })).toBeInTheDocument();
    expect(api.getAzureDevOpsPullRequests).toHaveBeenCalledWith('p1', 'OPEN');
  });

  it('shows the not configured state and opens settings', async () => {
    api.getAzureDevOpsPullRequests.mockResolvedValue({ success: false, error: 'Azure DevOps not configured' });
    const onOpenSettings = vi.fn();
    render(<AzureDevOpsPullRequests projectId="p1" onOpenSettings={onOpenSettings} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Azure DevOps Settings' }));
    await waitFor(() => expect(onOpenSettings).toHaveBeenCalled());
  });

  it('starts a review via runAzureDevOpsPRReview', async () => {
    await selectPR();
    fireEvent.click(await screen.findByRole('button', { name: /Start AI review/i }));
    expect(api.runAzureDevOpsPRReview).toHaveBeenCalledWith('p1', 7);
  });

  it('posts findings only after confirmation, with confirmed: true', async () => {
    api.getAzureDevOpsPRReview.mockResolvedValue({
      prNumber: 7,
      repo: 'repo',
      success: true,
      summary: 'Sum',
      overallStatus: 'request_changes',
      reviewedAt: new Date().toISOString(),
      findings: [
        {
          id: 'f1',
          severity: 'critical',
          category: 'security',
          title: 'Bad',
          description: 'Bad thing',
          file: 'a.ts',
          line: 1,
          fixable: false
        }
      ]
    });
    api.postAzureDevOpsPRReview.mockResolvedValue({ success: true, data: { posted: 1 } });
    await selectPR();
    fireEvent.click(await screen.findByRole('button', { name: 'Post selected findings to Azure DevOps' }));
    expect(api.postAzureDevOpsPRReview).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Post' }));
    await waitFor(() =>
      expect(api.postAzureDevOpsPRReview).toHaveBeenCalledWith(
        'p1',
        7,
        ['f1'],
        expect.objectContaining({ confirmed: true })
      )
    );
  });
});
