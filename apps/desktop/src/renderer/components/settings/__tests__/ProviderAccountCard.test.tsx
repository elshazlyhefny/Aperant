/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import i18n from '../../../../shared/i18n';
import type { ProviderAccountView } from '../../../../shared/types/provider-account';
import { TooltipProvider } from '../../ui/tooltip';
import { ProviderAccountCard } from '../ProviderAccountCard';

function renderCard(overrides: Partial<ProviderAccountView> = {}) {
  const account: ProviderAccountView = {
    id: 'pa_test',
    name: 'Provider account',
    provider: 'zai',
    authType: 'api-key',
    billingModel: 'subscription',
    hasApiKey: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
  return render(
    <TooltipProvider>
      <ProviderAccountCard account={account} onEdit={vi.fn()} onDelete={vi.fn()} />
    </TooltipProvider>
  );
}

describe('ProviderAccountCard saved key', () => {
  it('shows the endpoint and saved-key status without a reveal action or masked key', () => {
    const baseUrl = 'https://api.example.com';
    renderCard({ baseUrl });

    expect(screen.getByText(baseUrl)).toBeInTheDocument();
    expect(screen.getByText(i18n.t('settings:providers.card.keySaved'))).toBeInTheDocument();
    expect(screen.queryByText(/•+/)).not.toBeInTheDocument();
    const actions = screen.getAllByRole('button');
    expect(actions).toEqual([
      screen.getByRole('button', { name: i18n.t('settings:providers.card.edit') }),
      screen.getByRole('button', { name: i18n.t('settings:providers.card.delete') }),
    ]);
  });

  it('shows when neither an endpoint nor a key is saved', () => {
    renderCard({ hasApiKey: false });

    expect(screen.getByText(i18n.t('settings:providers.card.noEndpoint'))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('settings:providers.card.noKeySaved'))).toBeInTheDocument();
  });
});
