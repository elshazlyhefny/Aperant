/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../../../shared/i18n/locales/en/tasks.json';
import fr from '../../../../shared/i18n/locales/fr/tasks.json';
import type { IPCResult } from '../../../../shared/types/common';
import {
  DELIVERY_EVENTS,
  DELIVERY_OPERATIONS,
  DELIVERY_PROVIDERS,
  DELIVERY_REASONS,
  type DeliveryReceipt,
} from '../../../../shared/types/delivery-receipt';
import { TaskDeliveryReceipts } from '../TaskDeliveryReceipts';

const getTaskDeliveryReceipts = vi.fn<(projectId: string, specId: string) => Promise<IPCResult<DeliveryReceipt[]>>>();
const task = { projectId: 'task-project', specId: '001-task' };
const comment: DeliveryReceipt = {
  id: 'comment', operation: 'issue_comment', provider: 'jira', event: 'review_ready',
  createdAt: '2026-11-27T12:00:00.000Z', status: 'delivered',
};
const transition: DeliveryReceipt = {
  ...comment, id: 'transition', operation: 'issue_transition', createdAt: '2026-11-27T12:02:00.000Z',
  status: 'unknown', reason: 'unconfirmed',
};
const webhook: DeliveryReceipt = {
  id: 'webhook', operation: 'webhook', provider: 'slack', event: 'pr_opened',
  createdAt: '2026-11-27T12:01:00.000Z', status: 'failed', reason: 'rate_limited',
};
const skipped: DeliveryReceipt = {
  id: 'skip', operation: 'issue_comment', event: 'blocked',
  createdAt: '2026-11-27T11:00:00.000Z', status: 'skipped', reason: 'not_linked',
};

beforeEach(() => {
  getTaskDeliveryReceipts.mockReset();
  (window as unknown as { electronAPI: unknown }).electronAPI = { getTaskDeliveryReceipts };
});

async function renderHistory({ open = true, lng = 'en' } = {}) {
  const i18n = createInstance();
  await i18n.init({ lng, resources: { en: { tasks: en }, fr: { tasks: fr } }, fallbackLng: false });
  const view = (isOpen: boolean, scope: typeof task) => (
    <I18nextProvider i18n={i18n}>
      <TaskDeliveryReceipts task={scope} open={isOpen} />
    </I18nextProvider>
  );
  const { rerender } = render(view(open, task));
  return (isOpen: boolean, scope = task) => rerender(view(isOpen, scope));
}

function pendingRead() {
  let resolve!: (result: IPCResult<DeliveryReceipt[]>) => void;
  getTaskDeliveryReceipts.mockReturnValueOnce(new Promise((settle) => { resolve = settle; }));
  return resolve;
}

describe('TaskDeliveryReceipts', () => {
  it('shows distinct operations, outcomes and safe details in newest-first order', async () => {
    getTaskDeliveryReceipts.mockResolvedValue({ success: true, data: [skipped, comment, transition, webhook] });
    await renderHistory();
    expect(screen.getByRole('region', { name: 'Delivery history' })).toBeInTheDocument();
    const [first, second, third, fourth] = await screen.findAllByRole('listitem');
    expect(first).toHaveTextContent('Issue state change');
    expect(first).toHaveTextContent('Jira');
    expect(first).toHaveTextContent('Ready for review');
    expect(first).toHaveTextContent('Not confirmed');
    expect(first).toHaveTextContent('No confirmation was recorded.');
    expect(first.querySelector('time')).toHaveAttribute('datetime', transition.createdAt);
    expect(second).toHaveTextContent('Webhook notification');
    expect(second).toHaveTextContent('Slack');
    expect(second).toHaveTextContent('Pull request opened');
    expect(second).toHaveTextContent('Failed');
    expect(third).toHaveTextContent('Issue comment');
    expect(third).toHaveTextContent('Delivered');
    expect(fourth).toHaveTextContent('Skipped');
    expect(fourth).toHaveTextContent('No linked issue was found.');
    expect(screen.getByText(/may still be underway or may have been interrupted/)).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toEqual([screen.getByRole('button', { name: 'Refresh' })]);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('loads on opening and refreshes a late completion using the same task scope', async () => {
    const settle = pendingRead();
    getTaskDeliveryReceipts.mockResolvedValueOnce({ success: true, data: [comment] });
    const show = await renderHistory({ open: false });
    expect(getTaskDeliveryReceipts).not.toHaveBeenCalled();
    show(true);
    expect(screen.getByRole('status')).toHaveTextContent('Loading delivery history');
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    await act(() => settle({ success: true, data: [] }));
    expect(screen.getByRole('status')).toHaveTextContent('No delivery history recorded for this task.');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Delivered')).toBeInTheDocument();
    expect(getTaskDeliveryReceipts.mock.calls).toEqual([[task.projectId, task.specId], [task.projectId, task.specId]]);
  });

  it('ignores stale reads after switching projects or closing and reopening', async () => {
    const settleOriginal = pendingRead();
    const settleOther = pendingRead();
    const settleReopened = pendingRead();
    const show = await renderHistory();
    const other = { ...task, projectId: 'other-project' };
    show(true, other);
    expect(getTaskDeliveryReceipts).toHaveBeenLastCalledWith(other.projectId, other.specId);
    await act(() => settleOriginal({ success: true, data: [comment] }));
    expect(screen.getByRole('status')).toHaveTextContent('Loading delivery history');
    expect(screen.queryByText('Delivered')).not.toBeInTheDocument();
    show(false, other);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    show(true, other);
    await act(() => settleOther({ success: true, data: [transition] }));
    expect(screen.queryByText('Not confirmed')).not.toBeInTheDocument();
    await act(() => settleReopened({ success: true, data: [] }));
    expect(screen.getByRole('status')).toHaveTextContent('No delivery history recorded');
  });

  it('shows a fixed error for both failed and rejected reads without leaking diagnostic text', async () => {
    const diagnostic = 'private bridge diagnostic';
    getTaskDeliveryReceipts.mockResolvedValueOnce({ success: false, error: diagnostic })
      .mockRejectedValueOnce(new Error(diagnostic));
    await renderHistory();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read delivery history.');
    expect(screen.queryByText(diagnostic)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read delivery history.');
    expect(screen.queryByText(diagnostic)).not.toBeInTheDocument();
  });

  it('renders French labels and covers every receipt enum in both locales', async () => {
    getTaskDeliveryReceipts.mockResolvedValue({ success: true, data: [transition] });
    await renderHistory({ lng: 'fr' });
    expect(screen.getByRole('region', { name: 'Historique des envois' })).toBeInTheDocument();
    expect(await screen.findByText('Changement d’état du ticket')).toBeInTheDocument();
    expect(screen.getByText('Non confirmé')).toBeInTheDocument();
    for (const { deliveryHistory } of [en, fr]) {
      expect(Object.keys(deliveryHistory.operations)).toEqual(expect.arrayContaining([...DELIVERY_OPERATIONS]));
      expect(Object.keys(deliveryHistory.providers)).toEqual(expect.arrayContaining([...DELIVERY_PROVIDERS]));
      expect(Object.keys(deliveryHistory.events)).toEqual(expect.arrayContaining([...DELIVERY_EVENTS]));
      expect(Object.keys(deliveryHistory.statuses)).toEqual(expect.arrayContaining(['delivered', ...Object.keys(DELIVERY_REASONS)]));
      expect(Object.keys(deliveryHistory.reasons)).toEqual(expect.arrayContaining(Object.values(DELIVERY_REASONS).flat()));
    }
  });
});
