/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../../shared/i18n';
import i18n from '../../../../shared/i18n';
import { TooltipProvider } from '../../ui/tooltip';
import { AccountPriorityList, type UnifiedAccount } from '../AccountPriorityList';

function makeAccount(overrides: Partial<UnifiedAccount>): UnifiedAccount {
  return {
    id: 'a1',
    name: 'Acct',
    type: 'api',
    provider: 'anthropic',
    displayName: 'Acct',
    identifier: 'https://api.example.com',
    isActive: false,
    isNext: false,
    isAvailable: true,
    hasUnlimitedUsage: true,
    ...overrides,
  };
}

function renderList(accounts: UnifiedAccount[]) {
  return render(
    <TooltipProvider>
      <AccountPriorityList accounts={accounts} onReorder={() => {}} />
    </TooltipProvider>
  );
}

describe('AccountPriorityList key status', () => {
  const rejectedText = () => i18n.t('settings:accounts.priority.keyRejected');

  it('shows the rejected badge for a rejected API account', () => {
    renderList([makeAccount({ keyStatus: 'rejected', isAvailable: false })]);
    expect(screen.getByText(rejectedText())).toBeInTheDocument();
  });

  it('does not show it for unverified or valid API accounts', () => {
    renderList([
      makeAccount({ id: 'a1', keyStatus: 'unverified' }),
      makeAccount({ id: 'a2', keyStatus: 'valid' }),
    ]);
    expect(screen.queryByText(rejectedText())).not.toBeInTheDocument();
  });

  it('does not show it for an unavailable OAuth account without keyStatus', () => {
    renderList([makeAccount({ type: 'oauth', isAvailable: false })]);
    expect(screen.queryByText(rejectedText())).not.toBeInTheDocument();
  });
});
