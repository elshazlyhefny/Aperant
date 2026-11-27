/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAccount } from '@shared/types/provider-account';
import { AddAccountDialog } from './AddAccountDialog';

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../../hooks/use-toast', () => ({ toast, useToast: () => ({ toast }) }));

const storageUnavailable = { success: false, error: 'SECURE_STORAGE_UNAVAILABLE' };
const account: ProviderAccount = {
  id: 'provider-account',
  name: 'Test account',
  provider: 'openai',
  authType: 'api-key',
  billingModel: 'pay-per-use',
  apiKey: 'test-key',
  createdAt: 1,
  updatedAt: 1,
};

const saveProviderAccount = vi.fn();
const updateProviderAccount = vi.fn();
const requestAllProfilesUsage = vi.fn();

function openAddDialog() {
  const onOpenChange = vi.fn();
  render(<AddAccountDialog open onOpenChange={onOpenChange} provider="openai" authType="api-key" />);
  fireEvent.change(screen.getByLabelText('Account Name'), { target: { value: account.name } });
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: account.apiKey } });
  fireEvent.click(screen.getByRole('button', { name: 'Add Account' }));
  return onOpenChange;
}

async function getStoragePrompt() {
  return within(await screen.findByRole('alertdialog', { name: 'Secure storage unavailable' }));
}

describe('AddAccountDialog session-only API keys', () => {
  beforeEach(() => {
    saveProviderAccount.mockReset();
    updateProviderAccount.mockReset();
    vi.stubGlobal('electronAPI', { saveProviderAccount, updateProviderAccount, requestAllProfilesUsage });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('requires confirmation before creating a session-only account', async () => {
    saveProviderAccount.mockResolvedValueOnce(storageUnavailable).mockResolvedValueOnce({ success: true });
    const onOpenChange = openAddDialog();
    const prompt = await getStoragePrompt();

    expect(saveProviderAccount).toHaveBeenCalledTimes(1);
    const [initialPayload] = saveProviderAccount.mock.calls[0];
    expect(initialPayload).toMatchObject({ name: account.name, apiKey: account.apiKey });
    expect(initialPayload).not.toHaveProperty('apiKeySessionOnly');
    expect(toast).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(prompt.getByRole('button', { name: 'Use for this session only' }));

    expect(saveProviderAccount).toHaveBeenCalledTimes(2);
    expect(saveProviderAccount).toHaveBeenNthCalledWith(2, { ...initialPayload, apiKeySessionOnly: true });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('retries an edit with the same account ID and updates after confirmation', async () => {
    updateProviderAccount.mockResolvedValueOnce(storageUnavailable).mockResolvedValueOnce({ success: true });
    const onOpenChange = vi.fn();
    render(<AddAccountDialog open onOpenChange={onOpenChange} provider="openai" authType="api-key" editAccount={account} />);
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'replacement-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    const prompt = await getStoragePrompt();

    const [id, updates] = updateProviderAccount.mock.calls[0];
    expect(id).toBe(account.id);
    expect(updates).toMatchObject({ apiKey: 'replacement-key' });
    expect(updates).not.toHaveProperty('apiKeySessionOnly');
    expect(toast).not.toHaveBeenCalled();

    fireEvent.click(prompt.getByRole('button', { name: 'Use for this session only' }));

    expect(updateProviderAccount).toHaveBeenCalledTimes(2);
    expect(updateProviderAccount).toHaveBeenNthCalledWith(2, account.id, { ...updates, apiKeySessionOnly: true });
    expect(saveProviderAccount).not.toHaveBeenCalled();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('dismisses the confirmation without resubmitting or discarding the form', async () => {
    saveProviderAccount.mockResolvedValueOnce(storageUnavailable);
    const onOpenChange = openAddDialog();
    const prompt = await getStoragePrompt();

    fireEvent.click(prompt.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('API Key')).toHaveValue(account.apiKey);
    expect(saveProviderAccount).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add Account' })).toHaveFocus());
  });
});
