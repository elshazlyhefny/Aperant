/**
 * @vitest-environment jsdom
 */
/**
 * Tests for UsageIndicator popover variants and account actions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { UsageIndicator } from './UsageIndicator';
import { useSettingsStore, saveSettings } from '../stores/settings-store';
import type { ClaudeUsageSnapshot, ProfileUsageSummary } from '../../shared/types/agent';
import type { ProviderAccount } from '../../shared/types/provider-account';

vi.mock('../stores/settings-store', () => ({
  useSettingsStore: vi.fn(),
  saveSettings: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: vi.fn(() => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'common:usage.loading': 'Loading...',
        'common:usage.usageBreakdown': 'Usage Breakdown',
        'common:usage.unlimited': 'Unlimited',
        'common:usage.unlimitedApiKey': 'Unlimited (API Key)',
        'common:usage.noUsageMonitoring': 'Usage monitoring not available',
        'common:usage.subscriptionBadge': 'Subscription',
        'common:usage.subscriptionLimitsApply': 'Rate limits apply',
        'common:usage.subscriptionMonitoringComingSoon': 'Monitoring not available',
        'common:usage.dataUnavailable': 'Usage data unavailable',
        'common:usage.dataUnavailableDescription': 'Usage data is unavailable',
        'common:usage.notAvailable': 'N/A',
        'common:usage.reauthRequired': 'Re-authentication required',
        'common:usage.reauthRequiredDescription': 'Your session has expired. Re-authenticate to view usage and continue using this account.',
        'common:usage.reauthButton': 'Re-authenticate',
        'common:usage.needsReauth': 'Needs re-auth',
        'common:usage.weeklyLimitReached': 'Weekly limit reached',
        'common:usage.next': 'Next',
        'common:usage.notAuthenticated': 'Not authenticated',
        'common:usage.sessionDefault': 'Session',
        'common:usage.weeklyDefault': 'Weekly',
        'common:usage.crossProviderUsage': 'Cross-Provider Usage',
        'common:usage.crossProvider': 'Cross-Provider',
        'common:usage.swap': 'Swap',
        'common:usage.inUse': 'In Use',
        'common:usage.otherAccounts': 'Other Accounts',
        'common:usage.activeAccount': 'Active Account',
        'common:usage.providerAnthropic': 'Anthropic',
        'common:usage.providerOpenAI': 'OpenAI',
        'common:usage.providerGoogle': 'Google AI',
        'common:usage.windowCredit': 'Credit',
        'common:usage.creditRemaining': 'Remaining',
        'common:usage.creditNoLimit': 'No limit set',
      };

      if (params && Object.keys(params).length > 0) {
        const translated = translations[key] || key;
        if (translated.includes('{{provider}}')) {
          return translated.replace('{{provider}}', String(params.provider));
        }
        return translated;
      }

      return translations[key] || key;
    },
    i18n: {
      language: 'en',
    },
  })),
}));

const crossProviderAccounts: ProviderAccount[] = [
  {
    id: 'account-openai',
    provider: 'openai',
    name: 'OpenAI API',
    authType: 'api-key',
    billingModel: 'pay-per-use',
    apiKey: 'openai-key',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'account-anthropic',
    provider: 'anthropic',
    name: 'Anthropic OAuth',
    authType: 'oauth',
    billingModel: 'subscription',
    claudeProfileId: 'account-anthropic',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];

const crossProviderMonitoredAccounts: ProviderAccount[] = [
  {
    id: 'account-anthropic-active',
    provider: 'anthropic',
    name: 'Anthropic OAuth',
    authType: 'oauth',
    billingModel: 'subscription',
    claudeProfileId: 'account-anthropic-active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'account-openai-other',
    provider: 'openai',
    name: 'OpenAI OAuth',
    authType: 'oauth',
    billingModel: 'pay-per-use',
    claudeProfileId: 'account-openai-other',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];

const commonStoreMock = {
  setQueueOrder: vi.fn(),
  setSettings: vi.fn(),
  updateSettings: vi.fn(),
  loadProfiles: vi.fn(),
  loadProviderAccounts: vi.fn(),
};

function createStoreMock(overrides?: {
  customMixedProfileActive?: boolean;
  customMixedPhaseConfig?: Record<string, { provider: 'anthropic' | 'openai' }>;
  globalPriorityOrder?: string[];
  providerAccounts?: ProviderAccount[];
}) {
  return {
    providerAccounts: overrides?.providerAccounts ?? crossProviderAccounts,
    settings: {
      globalPriorityOrder: overrides?.globalPriorityOrder ?? ['account-openai', 'account-anthropic'],
      customMixedProfileActive: overrides?.customMixedProfileActive,
      customMixedPhaseConfig: overrides?.customMixedPhaseConfig,
    },
    ...commonStoreMock,
  } as any;
}

describe('UsageIndicator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commonStoreMock.setQueueOrder.mockResolvedValue({ success: true });

    (window as any).electronAPI = {
      onUsageUpdated: vi.fn(() => vi.fn()),
      requestUsageUpdate: vi.fn().mockResolvedValue({
        success: true,
        data: {
          profileId: 'account-openai',
          profileName: 'OpenAI API',
          profileEmail: 'openai@example.com',
          sessionPercent: 45,
          weeklyPercent: 55,
          sessionResetTimestamp: '2026-03-04T12:00:00.000Z',
          weeklyResetTimestamp: '2026-03-11T12:00:00.000Z',
          fetchedAt: new Date(),
          needsReauthentication: false,
        },
      }),
      requestAllProfilesUsage: vi.fn().mockResolvedValue({
        success: true,
        data: {
          allProfiles: [
            {
              profileId: 'account-anthropic',
              profileName: 'Anthropic OAuth',
              sessionPercent: 70,
              weeklyPercent: 80,
              isAuthenticated: true,
              isRateLimited: false,
              availabilityScore: 20,
              isActive: false,
            },
          ],
          activeProfile: {
            profileId: 'account-openai',
            profileName: 'OpenAI API',
            profileEmail: 'openai@example.com',
            sessionPercent: 45,
            weeklyPercent: 55,
            isActive: true,
          },
        },
      }),
      onAllProfilesUsageUpdated: vi.fn(),
      setQueueOrder: vi.fn(),
      setActiveClaudeProfile: vi.fn().mockResolvedValue({ success: true }),
    };
  });

  describe('popover variants', () => {
    const usageStatusLabel = 'common:usage.usageStatusAriaLabel';
    const unavailableLabel = 'Usage data unavailable';
    const reauthLabel = 'Re-authentication required';
    const reauthDescription = /^Your session has expired\./;
    const asyncOptions = { timeout: 2000 };

    const subscriptionAccount: ProviderAccount = {
      ...crossProviderAccounts[0],
      name: 'OpenAI Subscription',
      billingModel: 'subscription',
    };
    const unmeteredAccount: ProviderAccount = {
      ...crossProviderAccounts[0],
      id: 'account-google',
      provider: 'google',
      name: 'Google API',
    };
    const monitoredAccount = crossProviderMonitoredAccounts[0];
    const limitedAccount = crossProviderAccounts[1];
    const expiredAccount: ProviderAccount = {
      ...limitedAccount,
      id: 'account-anthropic-expired',
      claudeProfileId: 'profile-expired',
      name: 'Expired Anthropic Account',
    };
    const activeUsage: ClaudeUsageSnapshot = {
      profileId: monitoredAccount.id,
      profileName: monitoredAccount.name,
      profileEmail: 'active@example.com',
      sessionPercent: 42,
      weeklyPercent: 33,
      fetchedAt: new Date(),
    };

    function profileSummary(overrides: Partial<ProfileUsageSummary>): ProfileUsageSummary {
      return {
        profileId: limitedAccount.id,
        profileName: limitedAccount.name,
        sessionPercent: 27,
        weeklyPercent: 68,
        isAuthenticated: true,
        isRateLimited: false,
        availabilityScore: 32,
        isActive: false,
        ...overrides,
      };
    }

    const limitedProfile = profileSummary({
      isRateLimited: true,
      rateLimitType: 'weekly',
      weeklyPercent: 100,
      availabilityScore: 0,
    });

    function mockProfiles(...allProfiles: ProfileUsageSummary[]) {
      vi.mocked(window.electronAPI.requestAllProfilesUsage).mockResolvedValue({
        success: true,
        data: { allProfiles, activeProfile: activeUsage, fetchedAt: activeUsage.fetchedAt },
      });
    }

    function mockAccounts(active: ProviderAccount, ...queued: ProviderAccount[]) {
      vi.mocked(useSettingsStore).mockReturnValue(createStoreMock({
        providerAccounts: [...queued, active],
        globalPriorityOrder: [active, ...queued].map((account) => account.id),
      }));
    }

    function mockUnavailableUsage() {
      vi.mocked(window.electronAPI.requestUsageUpdate).mockResolvedValue({ success: false });
    }

    async function findTrigger(name = usageStatusLabel) {
      return screen.findByRole('button', { name }, asyncOptions);
    }

    async function openPopover(triggerName = usageStatusLabel) {
      fireEvent.click(await findTrigger(triggerName));
      await screen.findByText('Usage Breakdown', {}, asyncOptions);
    }

    async function accountRow(displayName: string) {
      const label = await screen.findByText(displayName, {}, asyncOptions);
      // The name and Swap share a line; the status is directly below it.
      const row = label.parentElement?.parentElement;
      if (!row) throw new Error(`Missing account row for ${displayName}`);
      return within(row);
    }

    beforeEach(() => {
      mockAccounts(monitoredAccount);
      vi.mocked(window.electronAPI.requestUsageUpdate).mockResolvedValue({ success: true, data: activeUsage });
      mockProfiles();
    });

    it('shows a loading badge without a popover trigger while usage is pending', async () => {
      vi.mocked(window.electronAPI.requestUsageUpdate).mockReturnValue(new Promise(() => {
        // Leave the initial usage request pending.
      }));
      await act(async () => { render(<UsageIndicator />); });

      expect(screen.getByText('Loading...')).toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('explains subscription limits when monitoring is not supported', async () => {
      mockAccounts(subscriptionAccount);
      render(<UsageIndicator />);

      expect(await findTrigger()).toHaveTextContent('Subscription');
      await openPopover();

      expect(screen.getByText('Rate limits apply')).toBeInTheDocument();
      expect(screen.getByText('Monitoring not available')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Active Account.*OpenAI Subscription/ })).toBeInTheDocument();
    });

    it('shows unlimited API usage and labels even a queued unmonitored subscription Unlimited', async () => {
      mockAccounts(unmeteredAccount, subscriptionAccount);
      render(<UsageIndicator />);

      expect(await findTrigger()).toHaveTextContent('Unlimited');
      await openPopover();

      expect(screen.getByText('Unlimited (API Key)')).toBeInTheDocument();
      const row = await accountRow(subscriptionAccount.name);
      expect(row.getByText('Unlimited')).toBeInTheDocument();
      expect(row.queryByText('Subscription')).not.toBeInTheDocument();
    });

    it('shows the unavailable badge and explanation when the usage request fails', async () => {
      mockUnavailableUsage();
      render(<UsageIndicator />);

      expect(await findTrigger(unavailableLabel)).toHaveTextContent('N/A');
      await openPopover(unavailableLabel);

      expect(screen.getByText(unavailableLabel)).toBeInTheDocument();
      expect(screen.getByText('Usage data is unavailable')).toBeInTheDocument();
    });

    it('shows a reauthentication warning when usage is unavailable and the active profile has expired', async () => {
      mockUnavailableUsage();
      mockProfiles(profileSummary({
        profileId: monitoredAccount.id,
        profileName: monitoredAccount.name,
        isActive: true,
        needsReauthentication: true,
      }));
      render(<UsageIndicator />);

      expect(await findTrigger(reauthLabel)).toHaveTextContent('!');
      await openPopover(reauthLabel);

      expect(screen.getByText(reauthDescription)).toBeInTheDocument();
      const footer = screen.getByRole('button', { name: /Active Account/ });
      expect(within(footer).getByText('Needs re-auth')).toBeInTheDocument();
    });

    it('opens Accounts settings from the monitored reauthentication prompt', async () => {
      vi.mocked(window.electronAPI.requestUsageUpdate).mockResolvedValue({
        success: true,
        data: { ...activeUsage, needsReauthentication: true },
      });
      render(<UsageIndicator />);

      expect(await findTrigger()).toHaveTextContent('!');
      await openPopover();
      expect(screen.getByText(reauthLabel)).toBeInTheDocument();
      expect(screen.getByText(reauthDescription)).toBeInTheDocument();

      const onOpenSettings = vi.fn();
      window.addEventListener('open-app-settings', onOpenSettings);
      try {
        fireEvent.click(screen.getByRole('button', { name: 'Re-authenticate' }));
        await waitFor(() => {
          expect(onOpenSettings).toHaveBeenCalledWith(expect.objectContaining({ detail: 'accounts' }));
        }, asyncOptions);
      } finally {
        window.removeEventListener('open-app-settings', onOpenSettings);
      }
    });

    it('shows session and weekly usage in the monitored badge and breakdown', async () => {
      render(<UsageIndicator />);

      expect(await findTrigger()).toHaveTextContent(/^42\s*\|\s*33$/);
      await openPopover();

      expect(screen.getByText('Session')).toBeInTheDocument();
      expect(screen.getByText('42%')).toBeInTheDocument();
      expect(screen.getByText('Weekly')).toBeInTheDocument();
      expect(screen.getByText('33%')).toBeInTheDocument();
    });

    describe('queued accounts', () => {
      it.each([
        { variant: 'subscription-only', active: subscriptionAccount, triggerName: usageStatusLabel },
        { variant: 'unmetered', active: unmeteredAccount, triggerName: usageStatusLabel },
        { variant: 'unavailable', active: monitoredAccount, triggerName: unavailableLabel },
        { variant: 'monitored', active: monitoredAccount, triggerName: usageStatusLabel },
      ])('moves the selected account to the front and refreshes usage in the $variant popover', async ({ active, triggerName }) => {
        if (triggerName === unavailableLabel) mockUnavailableUsage();
        mockAccounts(active, expiredAccount, limitedAccount);
        render(<UsageIndicator />);

        await openPopover(triggerName);
        expect(screen.getByText('Other Accounts')).toBeInTheDocument();
        const row = await accountRow(limitedAccount.name);
        const requestUsageUpdate = window.electronAPI.requestUsageUpdate;
        expect(requestUsageUpdate).toHaveBeenCalledTimes(1);
        fireEvent.click(row.getByRole('button', { name: 'Swap' }));

        expect(commonStoreMock.setQueueOrder).toHaveBeenCalledWith([limitedAccount.id, active.id, expiredAccount.id]);
        await waitFor(() => expect(requestUsageUpdate).toHaveBeenCalledTimes(2), asyncOptions);
        expect(window.electronAPI.setActiveClaudeProfile).not.toHaveBeenCalled();
      });

      it.each([
        { variant: 'unavailable', triggerName: unavailableLabel },
        { variant: 'monitored', triggerName: usageStatusLabel },
      ])('shows weekly-limit and reauthentication statuses in the $variant popover', async ({ triggerName }) => {
        if (triggerName === unavailableLabel) mockUnavailableUsage();
        mockAccounts(monitoredAccount, limitedAccount, expiredAccount);
        mockProfiles(limitedProfile, profileSummary({
          profileId: expiredAccount.claudeProfileId,
          profileName: expiredAccount.name,
          needsReauthentication: true,
        }));
        render(<UsageIndicator />);

        await openPopover(triggerName);
        const limitedRow = await accountRow(limitedAccount.name);
        const expiredRow = await accountRow(expiredAccount.name);
        expect(limitedRow.getByText('Weekly limit reached')).toBeInTheDocument();
        expect(expiredRow.getByText('Needs re-auth')).toBeInTheDocument();
      });

      it('uses mini usage bars instead of the weekly-limit message in the subscription-only popover', async () => {
        mockAccounts(subscriptionAccount, limitedAccount);
        mockProfiles(limitedProfile);
        render(<UsageIndicator />);

        await openPopover();
        const row = await accountRow(limitedAccount.name);
        expect(await row.findByText('27%', {}, asyncOptions)).toBeInTheDocument();
        expect(row.getByText('100%')).toBeInTheDocument();
        expect(row.queryByText('Weekly limit reached')).not.toBeInTheDocument();
      });
    });

    it('falls back to swapping legacy profiles when no other accounts are queued', async () => {
      const nextProfile = profileSummary({
        profileId: 'legacy-next',
        profileName: 'Legacy Next',
        profileEmail: 'legacy@example.com',
      });
      const signedOutProfile = profileSummary({
        profileId: 'legacy-signed-out',
        profileName: 'Legacy Signed Out',
        isAuthenticated: false,
      });
      mockProfiles(nextProfile, signedOutProfile);
      render(<UsageIndicator />);

      await openPopover();
      expect(screen.getByText('Other Accounts')).toBeInTheDocument();
      const nextRow = await accountRow('legacy@example.com');
      const signedOutRow = await accountRow('Legacy Signed Out');
      expect(nextRow.getByText('Next')).toBeInTheDocument();
      expect(signedOutRow.getByText('Not authenticated')).toBeInTheDocument();
      expect(signedOutRow.queryByRole('button', { name: 'Swap' })).not.toBeInTheDocument();

      fireEvent.click(nextRow.getByRole('button', { name: 'Swap' }));
      expect(window.electronAPI.setActiveClaudeProfile).toHaveBeenCalledWith(nextProfile.profileId);
      expect(commonStoreMock.setQueueOrder).not.toHaveBeenCalled();
    });

    it('opens on hover, stays open after pinning, and closes from the active-account footer', async () => {
      vi.useFakeTimers();
      try {
        await act(async () => { render(<UsageIndicator />); });
        const trigger = screen.getByRole('button', { name: usageStatusLabel });
        expect(screen.queryByText('Usage Breakdown')).not.toBeInTheDocument();

        fireEvent.mouseEnter(trigger);
        act(() => { vi.advanceTimersByTime(150); });
        expect(screen.getByText('Usage Breakdown')).toBeInTheDocument();

        fireEvent.click(trigger);
        fireEvent.mouseLeave(trigger);
        act(() => { vi.advanceTimersByTime(300); });
        expect(screen.getByText('Usage Breakdown')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /Active Account/ }));
        expect(screen.queryByText('Usage Breakdown')).not.toBeInTheDocument();
        act(() => { vi.runOnlyPendingTimers(); });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('when cross-provider mode is enabled', () => {
    beforeEach(() => {
      vi.mocked(useSettingsStore).mockReturnValue(createStoreMock({
        customMixedProfileActive: true,
        customMixedPhaseConfig: {
          spec: { provider: 'anthropic' },
          planning: { provider: 'openai' },
          coding: { provider: 'anthropic' },
          qa: { provider: 'openai' },
        },
      }) as any);
    });

    it('shows provider rows inside usage breakdown', async () => {
      render(<UsageIndicator />);

      const usageTrigger = screen.getByRole('button', { name: 'common:usage.usageStatusAriaLabel' });
      fireEvent.mouseEnter(usageTrigger);

      expect(await screen.findByText('Cross-Provider Usage', {}, { timeout: 12000 }))
        .toBeInTheDocument();
      expect(screen.getAllByText('Anthropic').length).toBeGreaterThanOrEqual(2);
      expect(screen.getAllByText('OpenAI').length).toBeGreaterThanOrEqual(2);
      expect(screen.getAllByText('70%').length).toBeGreaterThan(0);
      expect(screen.getAllByText('80%').length).toBeGreaterThan(0);
    });

    it('does not show swap buttons on individual cross-provider rows and toggles mode via main button', async () => {
      render(<UsageIndicator />);

      const usageTrigger = screen.getByRole('button', { name: 'common:usage.usageStatusAriaLabel' });
      fireEvent.click(usageTrigger);
      await screen.findByText('Cross-Provider Usage');

      // The swap buttons in the cross-provider section should only be the main toggle,
      // not on individual provider rows
      const swapButtons = screen.getAllByRole('button', { name: 'Swap' });
      const crossProviderToggle = swapButtons.find((button) => {
        const rowText = button.closest('div')?.textContent ?? '';
        return rowText.includes('Cross-Provider');
      });

      expect(crossProviderToggle).toBeTruthy();
      fireEvent.click(crossProviderToggle as HTMLElement);

      await waitFor(() => {
        expect(vi.mocked(saveSettings)).toHaveBeenCalledWith({ customMixedProfileActive: false });
      });
    });

    it('shows cross-provider rows under Other Accounts when regular usage breakdown is shown', async () => {
      vi.mocked(useSettingsStore).mockReturnValue(createStoreMock({
        providerAccounts: crossProviderMonitoredAccounts,
        globalPriorityOrder: ['account-anthropic-active', 'account-openai-other'],
        customMixedProfileActive: true,
        customMixedPhaseConfig: {
          spec: { provider: 'anthropic' },
          planning: { provider: 'openai' },
          coding: { provider: 'anthropic' },
          qa: { provider: 'openai' },
        },
      }) as any);

      (window as any).electronAPI.requestUsageUpdate = vi.fn().mockResolvedValue({
        success: true,
        data: {
          profileId: 'account-anthropic-active',
          profileName: 'Anthropic OAuth',
          profileEmail: 'anthropic@example.com',
          sessionPercent: 42,
          weeklyPercent: 33,
          sessionResetTimestamp: '2026-03-04T12:00:00.000Z',
          weeklyResetTimestamp: '2026-03-11T12:00:00.000Z',
          fetchedAt: new Date(),
          needsReauthentication: false,
        },
      });

      (window as any).electronAPI.requestAllProfilesUsage = vi.fn().mockResolvedValue({
        success: true,
        data: {
          allProfiles: [
            {
              profileId: 'account-openai-other',
              profileName: 'OpenAI OAuth',
              sessionPercent: 54,
              weeklyPercent: 48,
              isAuthenticated: true,
              isRateLimited: false,
              availabilityScore: 46,
              isActive: false,
            },
          ],
          activeProfile: {
            profileId: 'account-anthropic-active',
            profileName: 'Anthropic OAuth',
            profileEmail: 'anthropic@example.com',
            sessionPercent: 42,
            weeklyPercent: 33,
            isActive: true,
          },
        },
      });

      render(<UsageIndicator />);

      const usageTrigger = await screen.findByRole('button', { name: 'common:usage.usageStatusAriaLabel' });
      fireEvent.mouseEnter(usageTrigger);

      expect(await screen.findByText('Cross-Provider Usage', {}, { timeout: 12000 })).toBeInTheDocument();

      const otherAccountsHeader = screen.getByText('Other Accounts');
      const crossProviderUsageHeading = screen.getByText('Cross-Provider Usage');
      expect(
        otherAccountsHeader.compareDocumentPosition(crossProviderUsageHeading) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeGreaterThan(0);

      const openAiAccount = screen.getByText('OpenAI OAuth');
      expect(
        openAiAccount.compareDocumentPosition(crossProviderUsageHeading) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeGreaterThan(0);
    });

    it('does not show cross-provider usage when it is not configured with distinct providers', async () => {
      vi.mocked(useSettingsStore).mockReturnValue(createStoreMock({
        customMixedProfileActive: true,
        customMixedPhaseConfig: {
          spec: { provider: 'anthropic' },
          planning: { provider: 'anthropic' },
          coding: { provider: 'anthropic' },
          qa: { provider: 'anthropic' },
        },
      }) as any);

      render(<UsageIndicator />);

      const usageTrigger = screen.getByRole('button', { name: 'common:usage.usageStatusAriaLabel' });
      fireEvent.mouseEnter(usageTrigger);

      await waitFor(() => {
        expect(screen.queryByText('Cross-Provider Usage')).not.toBeInTheDocument();
      });
    });
  });

  describe('OpenRouter credit usage', () => {
    const openRouterAccounts: ProviderAccount[] = [
      {
        id: 'account-openrouter',
        provider: 'openrouter',
        name: 'OpenRouter Key',
        authType: 'api-key',
        billingModel: 'pay-per-use',
        apiKey: 'or-key',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    const mockCredit = (creditUsage: Record<string, unknown>) => {
      vi.mocked(useSettingsStore).mockReturnValue(createStoreMock({
        providerAccounts: openRouterAccounts,
        globalPriorityOrder: ['account-openrouter'],
      }) as any);
      (window as any).electronAPI.requestUsageUpdate = vi.fn().mockResolvedValue({
        success: true,
        data: {
          profileId: 'account-openrouter',
          profileName: 'OpenRouter Key',
          sessionPercent: 0,
          weeklyPercent: 0,
          sessionResetTimestamp: undefined,
          weeklyResetTimestamp: undefined,
          fetchedAt: new Date(),
          needsReauthentication: false,
          creditUsage,
        },
      });
      (window as any).electronAPI.requestAllProfilesUsage = vi.fn().mockResolvedValue({
        success: true,
        data: { allProfiles: [], activeProfile: null },
      });
    };

    it('shows percent and used/limit when a limit is set', async () => {
      mockCredit({ used: 2.5, limit: 10, remaining: 7.5, resetPeriod: null });
      render(<UsageIndicator />);

      const trigger = await screen.findByRole('button', { name: 'common:usage.usageStatusAriaLabel' });
      expect(await screen.findByText('25%')).toBeInTheDocument();
      fireEvent.mouseEnter(trigger);

      expect(await screen.findByText('Credit')).toBeInTheDocument();
      expect(screen.getByText(/\$2\.50.*\$10\.00/)).toBeInTheDocument();
      expect(screen.getByText('$7.50')).toBeInTheDocument();
      expect(screen.getByTestId('credit-progress-bar')).toBeInTheDocument();
      expect(screen.queryByText('Unlimited')).not.toBeInTheDocument();
    });

    it('shows only the used amount when no limit is set', async () => {
      mockCredit({ used: 3.25, limit: null, remaining: null, resetPeriod: null });
      render(<UsageIndicator />);

      const trigger = await screen.findByRole('button', { name: 'common:usage.usageStatusAriaLabel' });
      expect(await screen.findByText('$3.25')).toBeInTheDocument();
      fireEvent.mouseEnter(trigger);

      expect(await screen.findByText('No limit set')).toBeInTheDocument();
      expect(screen.queryByText(/%/)).not.toBeInTheDocument();
      expect(screen.queryByTestId('credit-progress-bar')).not.toBeInTheDocument();
      expect(screen.queryByText('Unlimited')).not.toBeInTheDocument();
    });
  });
});
