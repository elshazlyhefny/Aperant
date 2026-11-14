/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../../shared/i18n';
import { WebhookIntegration } from './WebhookIntegration';
import type { ProjectEnvConfig } from '../../../../shared/types';
import en from '../../../../shared/i18n/locales/en/settings.json';
import fr from '../../../../shared/i18n/locales/fr/settings.json';

const VALID_URL = 'https://hooks.slack.com/services/T000/B000/XXXX';

function makeConfig(patch: Partial<ProjectEnvConfig> = {}): ProjectEnvConfig {
  return { webhookEnabled: true, webhookUrl: '', ...patch } as unknown as ProjectEnvConfig;
}

function flatKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? flatKeys(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]
  );
}

describe('WebhookIntegration', () => {
  const sendTestWebhook = vi.fn();
  const updateEnvConfig = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { electronAPI: unknown }).electronAPI = { sendTestWebhook };
  });

  it('renders nothing when envConfig is null', () => {
    const { container } = render(<WebhookIntegration envConfig={null} updateEnvConfig={updateEnvConfig} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('masks the URL and toggles visibility', () => {
    render(<WebhookIntegration envConfig={makeConfig({ webhookUrl: VALID_URL })} updateEnvConfig={updateEnvConfig} />);
    const input = screen.getByLabelText(/project webhook url/i);
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: /show url/i }));
    expect(input).toHaveAttribute('type', 'url');
  });

  it('shows an error and disables test for an invalid URL', () => {
    render(<WebhookIntegration envConfig={makeConfig({ webhookUrl: 'http://example.com/x' })} updateEnvConfig={updateEnvConfig} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText(/project webhook url/i)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: /send test message/i })).toBeDisabled();
  });

  it('sends the trimmed URL and shows success', async () => {
    sendTestWebhook.mockResolvedValue({ success: true, data: { success: true } });
    render(<WebhookIntegration envConfig={makeConfig({ webhookUrl: `  ${VALID_URL}  ` })} updateEnvConfig={updateEnvConfig} />);
    fireEvent.click(screen.getByRole('button', { name: /send test message/i }));
    expect(sendTestWebhook).toHaveBeenCalledWith(VALID_URL);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/test message sent/i));
  });

  it('shows failure when the test fails', async () => {
    sendTestWebhook.mockResolvedValue({ success: false, error: 'nope' });
    render(<WebhookIntegration envConfig={makeConfig({ webhookUrl: VALID_URL })} updateEnvConfig={updateEnvConfig} />);
    fireEvent.click(screen.getByRole('button', { name: /send test message/i }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/could not send/i));
  });

  it('toggling an event merges webhookEvents over the defaults', () => {
    render(<WebhookIntegration envConfig={makeConfig()} updateEnvConfig={updateEnvConfig} />);
    fireEvent.click(screen.getByRole('switch', { name: /pr opened/i }));
    expect(updateEnvConfig).toHaveBeenCalledWith({
      webhookEvents: { reviewReady: true, failed: true, blocked: true, prOpened: true }
    });
  });

  it('toggling enable calls updateEnvConfig', () => {
    render(<WebhookIntegration envConfig={makeConfig({ webhookEnabled: false })} updateEnvConfig={updateEnvConfig} />);
    fireEvent.click(screen.getByRole('switch', { name: /project webhook$/i }));
    expect(updateEnvConfig).toHaveBeenCalledWith({ webhookEnabled: true });
  });

  it('has identical projectSections.webhook keys in en and fr', () => {
    const enKeys = flatKeys(en.projectSections.webhook).sort();
    const frKeys = flatKeys(fr.projectSections.webhook).sort();
    expect(enKeys.length).toBeGreaterThan(0);
    expect(frKeys).toEqual(enKeys);
  });
});
