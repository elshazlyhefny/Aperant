/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../shared/i18n';
import { WebhookSettings } from './WebhookSettings';
import { DEFAULT_APP_SETTINGS } from '../../../shared/constants/config';
import type { AppSettings } from '../../../shared/types';
import en from '../../../shared/i18n/locales/en/settings.json';
import fr from '../../../shared/i18n/locales/fr/settings.json';

const VALID_URL = 'https://hooks.slack.com/services/T000/B000/XXXX';

function makeSettings(webhook?: AppSettings['webhook']): AppSettings {
  return { ...(DEFAULT_APP_SETTINGS as unknown as AppSettings), webhook };
}

function flatKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? flatKeys(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]
  );
}

describe('WebhookSettings', () => {
  const sendTestWebhook = vi.fn();
  const onSettingsChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { electronAPI: unknown }).electronAPI = { sendTestWebhook };
  });

  it('renders with undefined webhook settings', () => {
    render(<WebhookSettings settings={makeSettings(undefined)} onSettingsChange={onSettingsChange} />);
    expect(screen.getByLabelText(/webhook url/i)).toHaveValue('');
    expect(screen.getAllByRole('switch')).toHaveLength(4);
  });

  it('toggling an event calls onSettingsChange with the right shape', () => {
    render(<WebhookSettings settings={makeSettings(undefined)} onSettingsChange={onSettingsChange} />);
    fireEvent.click(screen.getByRole('switch', { name: /task failed/i }));
    const next = onSettingsChange.mock.calls[0][0] as AppSettings;
    expect(next.webhook).toEqual({
      enabled: false,
      url: '',
      events: { reviewReady: true, failed: false, blocked: true }
    });
  });

  it('shows a message and disables test for an invalid URL', () => {
    render(
      <WebhookSettings
        settings={makeSettings({ enabled: true, url: 'http://example.com/x', events: { reviewReady: true, failed: true, blocked: true } })}
        onSettingsChange={onSettingsChange}
      />
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send test message/i })).toBeDisabled();
  });

  it('sends a test message and shows success', async () => {
    sendTestWebhook.mockResolvedValue({ success: true, data: { success: true } });
    render(
      <WebhookSettings
        settings={makeSettings({ enabled: true, url: VALID_URL, events: { reviewReady: true, failed: true, blocked: true } })}
        onSettingsChange={onSettingsChange}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /send test message/i }));
    expect(sendTestWebhook).toHaveBeenCalledWith(VALID_URL);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/test message sent/i));
    expect(screen.getByRole('status')).not.toHaveTextContent(VALID_URL);
  });

  it('shows failure when the test fails', async () => {
    sendTestWebhook.mockResolvedValue({ success: false, error: 'nope' });
    render(
      <WebhookSettings
        settings={makeSettings({ enabled: true, url: VALID_URL, events: { reviewReady: true, failed: true, blocked: true } })}
        onSettingsChange={onSettingsChange}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /send test message/i }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/could not send/i));
  });

  it('has identical notifications.webhook.* keys in en and fr', () => {
    const enKeys = flatKeys(en.notifications.webhook).sort();
    const frKeys = flatKeys(fr.notifications.webhook).sort();
    expect(enKeys.length).toBeGreaterThan(0);
    expect(frKeys).toEqual(enKeys);
  });
});
