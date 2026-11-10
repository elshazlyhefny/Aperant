/**
 * @vitest-environment jsdom
 *
 * zeenha fork: sidebar indicator for a pending authentication failure.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) =>
      opts?.profile ? `${key}:${opts.profile}` : key,
    i18n: { language: 'en' },
  }),
}));

import { AuthFailureIndicator } from '../AuthFailureIndicator';
import { TooltipProvider } from '../ui/tooltip';
import { useAuthFailureStore } from '../../stores/auth-failure-store';

const info = {
  profileId: 'p1',
  profileName: 'Work Account',
  failureType: 'expired' as const,
  message: 'expired',
  detectedAt: new Date(),
};

describe('AuthFailureIndicator', () => {
  beforeEach(() => {
    act(() => useAuthFailureStore.getState().clearAuthFailure());
  });
  afterEach(() => {
    cleanup();
    act(() => useAuthFailureStore.getState().clearAuthFailure());
  });

  it('renders nothing when no failure is pending', () => {
    const { container } = render(<AuthFailureIndicator />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a button named with the profile when pending', () => {
    act(() => useAuthFailureStore.getState().showAuthFailureModal(info));
    render(<AuthFailureIndicator />);
    expect(screen.getByRole('button', { name: /Work Account/ })).toBeInTheDocument();
  });

  it('clicking reopens the modal', () => {
    act(() => {
      useAuthFailureStore.getState().showAuthFailureModal(info);
      useAuthFailureStore.getState().hideAuthFailureModal();
    });
    expect(useAuthFailureStore.getState().isModalOpen).toBe(false);
    render(<AuthFailureIndicator />);
    fireEvent.click(screen.getByRole('button', { name: /Work Account/ }));
    expect(useAuthFailureStore.getState().isModalOpen).toBe(true);
  });

  it('disappears after clearAuthFailure()', () => {
    act(() => useAuthFailureStore.getState().showAuthFailureModal(info));
    const { container } = render(<AuthFailureIndicator />);
    expect(screen.getByRole('button')).toBeInTheDocument();
    act(() => useAuthFailureStore.getState().clearAuthFailure());
    expect(container).toBeEmptyDOMElement();
  });

  it('collapsed variant has an accessible name', () => {
    act(() => useAuthFailureStore.getState().showAuthFailureModal(info));
    render(
      <TooltipProvider>
        <AuthFailureIndicator isCollapsed />
      </TooltipProvider>
    );
    expect(screen.getByRole('button', { name: /Work Account/ })).toBeInTheDocument();
  });
});
