/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../shared/i18n';
import { WebhookSettings } from './WebhookSettings';
import { DEFAULT_APP_SETTINGS } from '../../../shared/constants/config';
import type { RendererAppSettings } from '../../../shared/types';
import en from '../../../shared/i18n/locales/en/settings.json';
import fr from '../../../shared/i18n/locales/fr/settings.json';

const VALID_URL = 'https://hooks.slack.com/services/T000/B000/XXXX';

// Radix Select does not open reliably in jsdom; a native select keeps the wiring testable.
vi.mock('../ui/select', () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: React.ReactNode }) => (
    <select aria-label="format" value={value} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

const TEAMS_URL = 'https://prod-1.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=x';

function makeSettings(webhook?: RendererAppSettings['webhook']): RendererAppSettings {
  return { ...(DEFAULT_APP_SETTINGS as unknown as RendererAppSettings), webhook };
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
    expect(screen.getAllByRole('switch')).toHaveLength(5);
  });

  it('toggling an event calls onSettingsChange with the right shape', () => {
    render(<WebhookSettings settings={makeSettings(undefined)} onSettingsChange={onSettingsChange} />);
    fireEvent.click(screen.getByRole('switch', { name: /task failed/i }));
    const next = onSettingsChange.mock.calls[0][0] as RendererAppSettings;
    expect(next.webhook).toEqual({
      enabled: false,
      url: '',
      secret: '',
      events: { reviewReady: true, failed: false, blocked: true, prOpened: false }
    });
  });

  it('PR opened switch is off by default and enables prOpened when clicked', () => {
    render(<WebhookSettings settings={makeSettings(undefined)} onSettingsChange={onSettingsChange} />);
    const toggle = screen.getByRole('switch', { name: /pr opened/i });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    const next = onSettingsChange.mock.calls[0][0] as RendererAppSettings;
    expect(next.webhook?.events).toEqual({ reviewReady: true, failed: true, blocked: true, prOpened: true });
  });

  it('shows a message and disables test for an invalid URL', () => {
    render(
      <WebhookSettings
        settings={makeSettings({ enabled: true, url: 'http://example.com/x', events: { reviewReady: true, failed: true, blocked: true, prOpened: false } })}
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
        settings={makeSettings({ enabled: true, url: VALID_URL, events: { reviewReady: true, failed: true, blocked: true, prOpened: false } })}
        onSettingsChange={onSettingsChange}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /send test message/i }));
    expect(sendTestWebhook).toHaveBeenCalledWith(VALID_URL, 'auto', '');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/test message sent/i));
    expect(screen.getByRole('status')).not.toHaveTextContent(VALID_URL);
  });

  it('shows failure when the test fails', async () => {
    sendTestWebhook.mockResolvedValue({ success: false, error: 'nope' });
    render(
      <WebhookSettings
        settings={makeSettings({ enabled: true, url: VALID_URL, events: { reviewReady: true, failed: true, blocked: true, prOpened: false } })}
        onSettingsChange={onSettingsChange}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /send test message/i }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/could not send/i));
  });

  it('choosing Teams and Discord updates settings.webhook.format', () => {
    render(<WebhookSettings settings={makeSettings(undefined)} onSettingsChange={onSettingsChange} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'teams' } });
    expect((onSettingsChange.mock.calls[0][0] as RendererAppSettings).webhook?.format).toBe('teams');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'discord' } });
    expect((onSettingsChange.mock.calls[1][0] as RendererAppSettings).webhook?.format).toBe('discord');
  });

  it('sends the chosen format with the test message', async () => {
    sendTestWebhook.mockResolvedValue({ success: true, data: { success: true } });
    render(
      <WebhookSettings
        settings={makeSettings({ enabled: true, url: VALID_URL, format: 'discord', events: { reviewReady: true, failed: true, blocked: true, prOpened: false } })}
        onSettingsChange={onSettingsChange}
      />
    );
    expect(screen.getByRole('combobox')).toHaveValue('discord');
    fireEvent.click(screen.getByRole('button', { name: /send test message/i }));
    expect(sendTestWebhook).toHaveBeenCalledWith(VALID_URL, 'discord', '');
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
  });

  it('shows the detected format hint on auto for a Teams workflow URL', () => {
    render(
      <WebhookSettings
        settings={makeSettings({ enabled: true, url: TEAMS_URL, events: { reviewReady: true, failed: true, blocked: true, prOpened: false } })}
        onSettingsChange={onSettingsChange}
      />
    );
    expect(screen.getByText(/detected format: microsoft teams/i)).toBeInTheDocument();
  });

  it('changing the format clears the test result', async () => {
    sendTestWebhook.mockResolvedValue({ success: true, data: { success: true } });
    render(
      <WebhookSettings
        settings={makeSettings({ enabled: true, url: VALID_URL, events: { reviewReady: true, failed: true, blocked: true, prOpened: false } })}
        onSettingsChange={onSettingsChange}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /send test message/i }));
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'teams' } });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  describe('signing secret', () => {
    const events = { reviewReady: true, failed: true, blocked: true, prOpened: false };

    it('is a password input by default and the toggle reveals it', () => {
      render(
        <WebhookSettings
          settings={makeSettings({ enabled: true, url: VALID_URL, secret: 'topsecret', events })}
          onSettingsChange={onSettingsChange}
        />
      );
      const input = screen.getByLabelText(/signing secret/i);
      expect(input).toHaveAttribute('type', 'password');
      fireEvent.click(screen.getByRole('button', { name: /show secret/i }));
      expect(input).toHaveAttribute('type', 'text');
      fireEvent.click(screen.getByRole('button', { name: /hide secret/i }));
      expect(input).toHaveAttribute('type', 'password');
    });

    it('typing calls onSettingsChange with webhook.secret', () => {
      render(<WebhookSettings settings={makeSettings(undefined)} onSettingsChange={onSettingsChange} />);
      fireEvent.change(screen.getByLabelText(/signing secret/i), { target: { value: 'abc' } });
      const next = onSettingsChange.mock.calls[0][0] as RendererAppSettings;
      expect(next.webhook?.secret).toBe('abc');
    });

    it('send test passes the secret', async () => {
      sendTestWebhook.mockResolvedValue({ success: true, data: { success: true } });
      render(
        <WebhookSettings
          settings={makeSettings({ enabled: true, url: VALID_URL, secret: 'topsecret', events })}
          onSettingsChange={onSettingsChange}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /send test message/i }));
      expect(sendTestWebhook).toHaveBeenCalledWith(VALID_URL, 'auto', 'topsecret');
      await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    });

    it('shows an alert for an over-long secret or one with line breaks', () => {
      const { unmount } = render(
        <WebhookSettings
          settings={makeSettings({ enabled: true, url: VALID_URL, secret: 'a'.repeat(257), events })}
          onSettingsChange={onSettingsChange}
        />
      );
      expect(screen.getByRole('alert')).toHaveTextContent(/256 characters/i);
      expect(screen.getByRole('button', { name: /send test message/i })).toBeDisabled();
      unmount();
      render(
        <WebhookSettings
          settings={makeSettings({ enabled: true, url: VALID_URL, secret: 'a\nb', events })}
          onSettingsChange={onSettingsChange}
        />
      );
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });

  it('has identical notifications.webhook.* keys in en and fr', () => {
    const enKeys = flatKeys(en.notifications.webhook).sort();
    const frKeys = flatKeys(fr.notifications.webhook).sort();
    expect(enKeys.length).toBeGreaterThan(0);
    expect(frKeys).toEqual(enKeys);
  });
});
