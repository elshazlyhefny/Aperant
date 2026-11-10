import { create } from 'zustand';
import type { AuthFailureInfo } from '../../shared/types';

interface AuthFailureState {
  // Auth failure modal state
  isModalOpen: boolean;
  authFailureInfo: AuthFailureInfo | null;

  /** True while an auth failure is unresolved; the sidebar AuthFailureIndicator uses it. */
  hasPendingAuthFailure: boolean;

  // Actions
  showAuthFailureModal: (info: AuthFailureInfo) => void;
  hideAuthFailureModal: () => void;
  reopenAuthFailureModal: () => void;
  clearAuthFailure: () => void;
}

export const useAuthFailureStore = create<AuthFailureState>((set, get) => ({
  isModalOpen: false,
  authFailureInfo: null,
  hasPendingAuthFailure: false,

  showAuthFailureModal: (info: AuthFailureInfo) => {
    set({
      isModalOpen: true,
      authFailureInfo: info,
      hasPendingAuthFailure: true,
    });
  },

  hideAuthFailureModal: () => {
    // Keep the failure info when closing so user can see it again
    set({ isModalOpen: false });
  },

  reopenAuthFailureModal: () => {
    if (get().authFailureInfo) {
      set({ isModalOpen: true });
    }
  },

  clearAuthFailure: () => {
    set({
      isModalOpen: false,
      authFailureInfo: null,
      hasPendingAuthFailure: false,
    });
  },
}));
