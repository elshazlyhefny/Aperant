/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useBitbucketPRReview } from '../useBitbucketPRReview';

type Cb = (...args: any[]) => void;
const handlers: Record<string, Cb> = {};
const sub = (name: string) =>
  vi.fn((cb: Cb) => {
    handlers[name] = cb;
    return vi.fn();
  });

const api = {
  getBitbucketPRReview: vi.fn(),
  runBitbucketPRReview: vi.fn(),
  cancelBitbucketPRReview: vi.fn(),
  getBitbucketPRLogs: vi.fn(),
  postBitbucketPRReview: vi.fn(),
  onBitbucketPRReviewProgress: sub('progress'),
  onBitbucketPRReviewComplete: sub('complete'),
  onBitbucketPRReviewError: sub('error'),
  onBitbucketPRLogsUpdated: sub('logs')
};
Object.defineProperty(window, 'electronAPI', { value: api, writable: true });

const finding = (id: string, severity: string) => ({
  id, severity, category: 'quality', title: id, description: '', file: 'a.ts', line: 1, fixable: false
});
const review = (extra: Record<string, unknown> = {}) => ({
  prNumber: 7,
  repo: 'w/r',
  success: true,
  findings: [finding('f1', 'critical'), finding('f2', 'low')],
  summary: 's',
  overallStatus: 'comment',
  reviewedAt: 'now',
  ...extra
});

describe('useBitbucketPRReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getBitbucketPRReview.mockResolvedValue(null);
    api.getBitbucketPRLogs.mockResolvedValue(null);
  });

  it('loads a saved review and selects critical/high findings', async () => {
    api.getBitbucketPRReview.mockResolvedValue(review());
    const { result } = renderHook(() => useBitbucketPRReview('p1', 7));
    await waitFor(() => expect(result.current.status).toBe('complete'));
    expect(Array.from(result.current.selectedIds)).toEqual(['f1']);
  });

  it('ignores events for another PR id', async () => {
    const { result } = renderHook(() => useBitbucketPRReview('p1', 7));
    await waitFor(() => expect(api.getBitbucketPRReview).toHaveBeenCalled());
    act(() => {
      handlers.progress('p1', { prId: 8, phase: 'analyzing', progress: 5, message: 'x' });
      handlers.complete('p1', review({ prNumber: 8 }));
      handlers.error('p1', { prId: 8, error: 'boom' });
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeNull();
    act(() => {
      handlers.progress('p1', { prId: 7, phase: 'analyzing', progress: 5, message: 'x' });
    });
    expect(result.current.status).toBe('reviewing');
    act(() => handlers.error('p1', { prId: 7, error: 'boom' }));
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('boom');
  });

  it('applies a logs delta without resync', async () => {
    const base = {
      pr_number: 7, repo: 'r', created_at: 'c', updated_at: 'u1', is_followup: false,
      phases: {
        context: { phase: 'context', status: 'pending', started_at: null, completed_at: null, entries: [] },
        analysis: { phase: 'analysis', status: 'pending', started_at: null, completed_at: null, entries: [] },
        synthesis: { phase: 'synthesis', status: 'pending', started_at: null, completed_at: null, entries: [] }
      }
    };
    api.getBitbucketPRLogs.mockResolvedValue(base);
    const { result } = renderHook(() => useBitbucketPRReview('p1', 7));
    await waitFor(() => expect(api.getBitbucketPRReview).toHaveBeenCalled());
    act(() => handlers.progress('p1', { prId: 7, phase: 'fetching', progress: 1, message: '' }));
    await waitFor(() => expect(result.current.logs).not.toBeNull());
    const calls = api.getBitbucketPRLogs.mock.calls.length;
    act(() =>
      handlers.logs('p1', {
        prNumber: 7,
        entryCount: 1,
        delta: {
          pr_number: 7, created_at: 'c', updated_at: 'u2',
          phases: {
            context: {
              baseCount: 0, status: 'active', started_at: 's', completed_at: null,
              entries: [{ timestamp: 't', type: 'info', content: 'hi', phase: 'context' }]
            }
          }
        }
      })
    );
    expect(result.current.logs?.updated_at).toBe('u2');
    expect(result.current.logs?.phases.context.entries).toHaveLength(1);
    expect(api.getBitbucketPRLogs.mock.calls.length).toBe(calls);
  });

  it('cancels a review', async () => {
    api.cancelBitbucketPRReview.mockResolvedValue(true);
    const { result } = renderHook(() => useBitbucketPRReview('p1', 7));
    act(() => result.current.startReview());
    expect(api.runBitbucketPRReview).toHaveBeenCalledWith('p1', 7);
    await act(async () => {
      await result.current.cancelReview();
    });
    expect(api.cancelBitbucketPRReview).toHaveBeenCalledWith('p1', 7);
    expect(result.current.status).toBe('idle');
  });

  it('postSelected passes confirmed:true and postInline, then reloads', async () => {
    api.getBitbucketPRReview.mockResolvedValueOnce(review());
    api.postBitbucketPRReview.mockResolvedValue({ success: true, data: {} });
    const { result } = renderHook(() => useBitbucketPRReview('p1', 7));
    await waitFor(() => expect(result.current.status).toBe('complete'));
    api.getBitbucketPRReview.mockResolvedValue(review({ postedFindingIds: ['f1'] }));
    await act(async () => {
      await result.current.postSelected({ postInline: true });
    });
    expect(api.postBitbucketPRReview).toHaveBeenCalledWith('p1', 7, ['f1'], {
      confirmed: true,
      postInline: true
    });
    expect(Array.from(result.current.postedIds)).toEqual(['f1']);
  });

  it('surfaces post failures', async () => {
    api.postBitbucketPRReview.mockResolvedValue({ success: false, error: 'nope' });
    const { result } = renderHook(() => useBitbucketPRReview('p1', 7));
    await act(async () => {
      await result.current.postSelected({ postInline: false });
    });
    expect(result.current.postError).toBe('nope');
  });
});
