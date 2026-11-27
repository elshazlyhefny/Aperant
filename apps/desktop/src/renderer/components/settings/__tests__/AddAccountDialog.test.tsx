/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import i18n from '../../../../shared/i18n';
import type { ProviderAccount, ProviderAccountView } from '../../../../shared/types/provider-account';
import { AddAccountDialog } from '../AddAccountDialog';

const addProviderAccount = vi.fn();
const updateProviderAccount = vi.fn(async (_id: string, _updates: Partial<ProviderAccount>) => ({ success: true }));

vi.mock('../../../stores/settings-store', () => ({
  useSettingsStore: () => ({ addProviderAccount, updateProviderAccount }),
}));

const savedAccount: ProviderAccountView = {
  id: 'pa_test',
  name: 'OpenAI account',
  provider: 'openai',
  authType: 'api-key',
  billingModel: 'pay-per-use',
  hasApiKey: true,
  createdAt: 0,
  updatedAt: 0,
};

function renderDialog(editAccount?: ProviderAccountView) {
  const onOpenChange = vi.fn();
  render(
    <AddAccountDialog
      open
      onOpenChange={onOpenChange}
      provider="openai"
      authType="api-key"
      editAccount={editAccount}
    />
  );
  return onOpenChange;
}

const t = (key: string) => i18n.t(`settings:providers.dialog.${key}`);

describe('AddAccountDialog write-only key', () => {
  it.each(['', '   '])('keeps the saved key when the replacement input is %j', async (input) => {
    const onOpenChange = renderDialog(savedAccount);
    const keyField = screen.getByLabelText(t('fields.replaceApiKey'));
    expect(keyField).toHaveValue('');
    expect(keyField).toHaveAttribute('type', 'password');
    expect(keyField).toHaveAttribute('autocomplete', 'off');
    expect(keyField).toHaveAttribute('placeholder', t('placeholders.keepSavedKey'));
    expect(keyField).toHaveAccessibleDescription(t('replaceKeyHint'));

    fireEvent.change(keyField, { target: { value: input } });
    const save = screen.getByRole('button', { name: t('save') });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(updateProviderAccount).toHaveBeenCalledOnce();
    const [id, updates] = updateProviderAccount.mock.calls[0];
    expect(id).toBe(savedAccount.id);
    expect(updates).not.toHaveProperty('apiKey');
  });

  it('sends a trimmed replacement key', async () => {
    const onOpenChange = renderDialog(savedAccount);
    fireEvent.change(screen.getByLabelText(t('fields.replaceApiKey')), {
      target: { value: '  test-replacement  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('save') }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(updateProviderAccount).toHaveBeenCalledWith(
      savedAccount.id,
      expect.objectContaining({ apiKey: 'test-replacement' })
    );
  });

  it.each(['add', 'save'])('requires a key on %s when none is saved', (action) => {
    renderDialog(action === 'add' ? undefined : { ...savedAccount, hasApiKey: false });
    fireEvent.change(screen.getByLabelText(t('fields.name')), { target: { value: 'OpenAI account' } });
    const keyField = screen.getByLabelText(t('fields.apiKey'));
    const save = screen.getByRole('button', { name: t(action) });
    expect(save).toBeDisabled();
    fireEvent.change(keyField, { target: { value: 'test-new-key' } });
    expect(save).toBeEnabled();
  });
});
