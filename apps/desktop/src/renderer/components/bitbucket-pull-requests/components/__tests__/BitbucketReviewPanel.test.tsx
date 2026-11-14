/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../../../shared/i18n';
import { BitbucketReviewPanel } from '../BitbucketReviewPanel';

const startReview = vi.fn();
const postSelected = vi.fn().mockResolvedValue(true);

function makeReview(overrides: Record<string, unknown> = {}) {
  return {
    status: 'complete',
    progress: null,
    result: {
      prNumber: 1,
      repo: 'w/r',
      success: true,
      summary: 'Overall summary text',
      overallStatus: 'comment',
      reviewedAt: '2026-01-01',
      findings: [
        {
          id: 'f1',
          severity: 'high',
          category: 'security',
          title: 'Unsafe input handling',
          description: 'desc',
          file: 'a.ts',
          line: 3,
          fixable: false
        }
      ]
    },
    error: null,
    logs: null,
    selectedIds: new Set(['f1']),
    setSelectedIds: vi.fn(),
    postedIds: new Set<string>(),
    isPosting: false,
    postError: null,
    inlineFailed: [],
    startReview,
    cancelReview: vi.fn(),
    postSelected,
    ...overrides
  } as never;
}

describe('BitbucketReviewPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts a review from the button', () => {
    render(<BitbucketReviewPanel review={makeReview({ status: 'idle', result: null })} prId={1} prState="OPEN" />);
    fireEvent.click(screen.getByRole('button', { name: /start ai review/i }));
    expect(startReview).toHaveBeenCalledTimes(1);
  });

  it('disables the start button for non-open PRs', () => {
    render(<BitbucketReviewPanel review={makeReview({ status: 'idle', result: null })} prId={1} prState="MERGED" />);
    expect(screen.getByRole('button', { name: /start ai review/i })).toBeDisabled();
  });

  it('renders findings and the summary', () => {
    render(<BitbucketReviewPanel review={makeReview()} prId={1} prState="OPEN" />);
    expect(screen.getByText('Overall summary text')).toBeInTheDocument();
    expect(screen.getByText('Unsafe input handling')).toBeInTheDocument();
  });

  it('does not post until the dialog is confirmed', async () => {
    render(<BitbucketReviewPanel review={makeReview()} prId={1} prState="OPEN" />);
    fireEvent.click(screen.getByRole('button', { name: /post selected findings to bitbucket/i }));
    expect(await screen.findByText(/post findings to bitbucket\?/i)).toBeInTheDocument();
    expect(postSelected).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^post$/i }));
    expect(postSelected).toHaveBeenCalledWith({ postInline: false });
  });

  it('posts nothing when the dialog is cancelled', async () => {
    render(<BitbucketReviewPanel review={makeReview()} prId={1} prState="OPEN" />);
    fireEvent.click(screen.getByRole('button', { name: /post selected findings to bitbucket/i }));
    await screen.findByText(/post findings to bitbucket\?/i);
    const cancels = screen.getAllByRole('button', { name: /^cancel$/i });
    fireEvent.click(cancels[cancels.length - 1]);
    expect(postSelected).not.toHaveBeenCalled();
  });
});
