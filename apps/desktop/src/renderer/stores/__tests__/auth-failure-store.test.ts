import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthFailureInfo } from '../../../shared/types';
import { useAuthFailureStore } from '../auth-failure-store';

const info: AuthFailureInfo = {
  profileId: 'profile-1',
  profileName: 'Work',
  failureType: 'expired',
  message: 'Token expired',
  detectedAt: new Date(),
};

describe('auth-failure-store', () => {
  beforeEach(() => {
    useAuthFailureStore.setState({
      isModalOpen: false,
      authFailureInfo: null,
      hasPendingAuthFailure: false,
    });
  });

  it('show sets pending and opens the modal', () => {
    useAuthFailureStore.getState().showAuthFailureModal(info);
    const state = useAuthFailureStore.getState();
    expect(state.isModalOpen).toBe(true);
    expect(state.hasPendingAuthFailure).toBe(true);
    expect(state.authFailureInfo).toEqual(info);
  });

  it('hide keeps the pending state', () => {
    useAuthFailureStore.getState().showAuthFailureModal(info);
    useAuthFailureStore.getState().hideAuthFailureModal();
    const state = useAuthFailureStore.getState();
    expect(state.isModalOpen).toBe(false);
    expect(state.hasPendingAuthFailure).toBe(true);
    expect(state.authFailureInfo).toEqual(info);
  });

  it('reopen reopens the modal when info exists', () => {
    useAuthFailureStore.getState().showAuthFailureModal(info);
    useAuthFailureStore.getState().hideAuthFailureModal();
    useAuthFailureStore.getState().reopenAuthFailureModal();
    expect(useAuthFailureStore.getState().isModalOpen).toBe(true);
  });

  it('reopen is a no-op when there is no info', () => {
    useAuthFailureStore.getState().reopenAuthFailureModal();
    expect(useAuthFailureStore.getState().isModalOpen).toBe(false);
  });

  it('clear resets everything', () => {
    useAuthFailureStore.getState().showAuthFailureModal(info);
    useAuthFailureStore.getState().clearAuthFailure();
    const state = useAuthFailureStore.getState();
    expect(state.isModalOpen).toBe(false);
    expect(state.authFailureInfo).toBeNull();
    expect(state.hasPendingAuthFailure).toBe(false);
  });
});
