/**
 * @vitest-environment jsdom
 *
 * zeenha fork: the PR feedback panel: opt-in selection, explicit send only.
 */
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import { PRFeedbackPanel } from '../PRFeedbackPanel';

const getPRFeedback = vi.fn();
const startPRFollowUp = vi.fn();
const openExternal = vi.fn();

const item = (id: string, kind: string, o: Record<string, unknown> = {}) => ({
  id, kind, title: `title-${id}`, summary: `summary-${id}`, truncated: false, ...o,
});
const feedback = (o: Record<string, unknown> = {}) => ({
  prNumber: 1, prUrl: 'https://github.com/o/r/pull/1', prState: 'open', headRef: 'b', headSha: 'abc',
  worktree: { available: true }, canStartFollowUp: true,
  checks: [item('c1', 'check', { url: 'https://example.com/run' })],
  threads: [item('t1', 'review_thread')],
  reviews: [item('r1', 'review')],
  fetchedAt: 'now', ...o,
});
const task = (o: Record<string, unknown> = {}) =>
  ({ id: 't1', status: 'pr_created', logs: [], metadata: { prUrl: 'https://github.com/o/r/pull/1' }, ...o }) as never;

beforeEach(() => {
  getPRFeedback.mockReset().mockResolvedValue({ success: true, data: feedback() });
  startPRFollowUp.mockReset().mockResolvedValue({ success: true, data: { started: true, itemCount: 1 } });
  openExternal.mockReset();
  (window as unknown as { electronAPI: unknown }).electronAPI = { getPRFeedback, startPRFollowUp, openExternal };
});

const renderPanel = async (t = task()) => {
  await act(async () => {
    render(<PRFeedbackPanel task={t} />);
  });
};

describe('PRFeedbackPanel', () => {
  it('renders failed checks and unresolved comments', async () => {
    await renderPanel();
    expect(screen.getByText('title-c1')).toBeInTheDocument();
    expect(screen.getByText('title-t1')).toBeInTheDocument();
    expect(screen.getByText('title-r1')).toBeInTheDocument();
  });

  it('has nothing selected and the send button disabled by default', async () => {
    await renderPanel();
    expect(screen.getByTestId('pr-feedback-item-c1')).not.toBeChecked();
    expect(screen.getByTestId('pr-feedback-send')).toBeDisabled();
    expect(startPRFollowUp).not.toHaveBeenCalled();
  });

  it('sends exactly the selected ids once', async () => {
    await renderPanel();
    fireEvent.click(screen.getByTestId('pr-feedback-item-c1'));
    fireEvent.click(screen.getByTestId('pr-feedback-item-r1'));
    await act(async () => fireEvent.click(screen.getByTestId('pr-feedback-send')));
    expect(startPRFollowUp).toHaveBeenCalledTimes(1);
    expect(startPRFollowUp).toHaveBeenCalledWith('t1', ['c1', 'r1']);
  });

  it('does not start a follow-up on mount or refresh', async () => {
    await renderPanel();
    await act(async () => fireEvent.click(screen.getByTestId('pr-feedback-refresh')));
    expect(getPRFeedback).toHaveBeenCalledTimes(2);
    expect(startPRFollowUp).not.toHaveBeenCalled();
  });

  it('explains a missing worktree and offers no send button', async () => {
    getPRFeedback.mockResolvedValue({
      success: true,
      data: feedback({ canStartFollowUp: false, blockedReason: 'worktree_missing' }),
    });
    await renderPanel();
    expect(screen.getByTestId('pr-feedback-blocked')).toHaveTextContent('tasks:prFeedback.blocked.worktree_missing');
    expect(screen.queryByTestId('pr-feedback-send')).not.toBeInTheDocument();
  });

  it('renders GitHub text as plain text', async () => {
    const evil = '<img src=x onerror="alert(1)"> **bold** [l](http://x)';
    getPRFeedback.mockResolvedValue({
      success: true,
      data: feedback({ threads: [item('t1', 'review_thread', { summary: evil })] }),
    });
    const { container } = render(<PRFeedbackPanel task={task()} />);
    await act(async () => {});
    expect(screen.getByText(evil)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('shows an inline error when the start fails', async () => {
    startPRFollowUp.mockResolvedValue({ success: false, error: 'boom' });
    await renderPanel();
    fireEvent.click(screen.getByTestId('pr-feedback-item-c1'));
    await act(async () => fireEvent.click(screen.getByTestId('pr-feedback-send')));
    expect(screen.getByTestId('pr-feedback-send-error')).toHaveTextContent('boom');
  });

  it('is not rendered for tasks without a PR', async () => {
    await renderPanel(task({ metadata: {} }));
    expect(screen.queryByTestId('pr-feedback-panel')).not.toBeInTheDocument();
    expect(getPRFeedback).not.toHaveBeenCalled();
  });
});
