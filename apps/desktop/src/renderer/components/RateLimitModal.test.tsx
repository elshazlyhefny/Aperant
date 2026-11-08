/**
 * @vitest-environment jsdom
 */
/**
 * Tests for RateLimitModal "add account" flow: a toast with a Settings action
 * replaces the native window.alert.
 */

import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RateLimitModal } from './RateLimitModal';

const mockToast = vi.fn();
const mockHideRateLimitModal = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('../hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('./ui/toast', () => ({
  ToastAction: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    altText: string;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock('../stores/rate-limit-store', () => ({
  useRateLimitStore: () => ({
    isModalOpen: true,
    rateLimitInfo: null,
    hideRateLimitModal: mockHideRateLimitModal,
    clearPendingRateLimit: vi.fn(),
  }),
}));

vi.mock('../stores/claude-profile-store', () => ({
  useClaudeProfileStore: () => ({
    profiles: [],
    activeProfileId: null,
    isSwitching: false,
  }),
  loadClaudeProfiles: vi.fn(),
  switchTerminalToProfile: vi.fn(),
}));

async function addProfile(name: string) {
  render(<RateLimitModal />);
  fireEvent.change(screen.getByPlaceholderText('rateLimit.accountNamePlaceholder'), {
    target: { value: name },
  });
  fireEvent.click(screen.getByRole('button', { name: /buttons\.add/ }));
}

describe('RateLimitModal add profile', () => {
  const saveClaudeProfile = vi.fn();
  let alertSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      saveClaudeProfile,
      getAutoSwitchSettings: vi.fn().mockResolvedValue({ success: true, data: { autoSwitchOnRateLimit: false } }),
      updateAutoSwitchSettings: vi.fn(),
    };
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('shows a toast with an action instead of window.alert', async () => {
    saveClaudeProfile.mockResolvedValue({ success: true, data: { id: 'p1', name: 'Work' } });
    await addProfile('Work');

    await waitFor(() => expect(mockToast).toHaveBeenCalledTimes(1));
    const toastArg = mockToast.mock.calls[0][0];
    expect(toastArg.action).toBeTruthy();
    expect(toastArg.variant).toBeUndefined();
    expect(alertSpy).not.toHaveBeenCalled();
    expect(mockHideRateLimitModal).toHaveBeenCalled();
  });

  it('action dispatches open-app-settings with accounts detail', async () => {
    saveClaudeProfile.mockResolvedValue({ success: true, data: { id: 'p1', name: 'Work' } });
    await addProfile('Work');
    await waitFor(() => expect(mockToast).toHaveBeenCalled());

    const listener = vi.fn();
    window.addEventListener('open-app-settings', listener);
    try {
      const { container } = render(mockToast.mock.calls[0][0].action as ReactElement);
      fireEvent.click(container.querySelector('button') as HTMLButtonElement);
      expect(listener).toHaveBeenCalledTimes(1);
      expect((listener.mock.calls[0][0] as CustomEvent).detail).toBe('accounts');
    } finally {
      window.removeEventListener('open-app-settings', listener);
    }
  });

  it('shows a destructive toast when saving the profile throws', async () => {
    saveClaudeProfile.mockRejectedValue(new Error('boom'));
    await addProfile('Work');

    await waitFor(() => expect(mockToast).toHaveBeenCalledTimes(1));
    expect(mockToast.mock.calls[0][0].variant).toBe('destructive');
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
