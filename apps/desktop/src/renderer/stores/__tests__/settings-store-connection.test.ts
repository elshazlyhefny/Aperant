/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for translated toasts emitted by settings-store testConnection
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../hooks/use-toast', () => ({
  toast: vi.fn(),
}));

import { toast } from '../../hooks/use-toast';
import i18n from '../../../shared/i18n';
import { useSettingsStore } from '../settings-store';

const KEY = 'settings:apiProfiles.testConnection.toast';

describe('settings-store testConnection toasts', () => {
  const mockTestConnection = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      testConnection: mockTestConnection,
    };
  });

  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('toasts translated success title and description on success', async () => {
    mockTestConnection.mockResolvedValue({
      success: true,
      data: { success: true, message: 'ok' },
    });

    await useSettingsStore.getState().testConnection('https://api.example.com', 'key-1234');

    expect(toast).toHaveBeenCalledWith({
      title: i18n.t(`${KEY}.successTitle`),
      description: i18n.t(`${KEY}.successDescription`),
    });
  });

  it('toasts destructive failure with result.error as description on IPC error', async () => {
    mockTestConnection.mockResolvedValue({ success: false, error: 'IPC exploded' });

    await useSettingsStore.getState().testConnection('https://api.example.com', 'key-1234');

    expect(toast).toHaveBeenCalledWith({
      variant: 'destructive',
      title: i18n.t(`${KEY}.failureTitle`),
      description: 'IPC exploded',
    });
  });

  it('toasts translated title with error.message when testConnection throws', async () => {
    mockTestConnection.mockRejectedValue(new Error('network down'));

    await useSettingsStore.getState().testConnection('https://api.example.com', 'key-1234');

    expect(toast).toHaveBeenCalledWith({
      variant: 'destructive',
      title: i18n.t(`${KEY}.failureTitle`),
      description: 'network down',
    });
  });

  it('falls back to translated failureFallback when error is empty', async () => {
    mockTestConnection.mockResolvedValue({ success: false, error: '' });

    const result = await useSettingsStore.getState().testConnection('https://api.example.com', 'key-1234');

    const fallback = i18n.t(`${KEY}.failureFallback`);
    expect(fallback).toBeTruthy();
    expect(result?.message).toBe(fallback);
    expect(toast).toHaveBeenCalledWith({
      variant: 'destructive',
      title: i18n.t(`${KEY}.failureTitle`),
      description: fallback,
    });
  });

  it('resolves different non-empty strings for en and fr', async () => {
    const en = i18n.t(`${KEY}.failureTitle`);
    await i18n.changeLanguage('fr');
    const fr = i18n.t(`${KEY}.failureTitle`);

    expect(en).toBeTruthy();
    expect(fr).toBeTruthy();
    expect(fr).not.toBe(en);
  });
});
