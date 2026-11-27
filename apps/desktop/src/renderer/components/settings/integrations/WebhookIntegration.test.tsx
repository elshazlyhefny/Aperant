/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../../shared/i18n';
import { WebhookIntegration } from './WebhookIntegration';
import type { ProjectEnvConfig } from '../../../../shared/types';
import en from '../../../../shared/i18n/locales/en/settings.json';
import fr from '../../../../shared/i18n/locales/fr/settings.json';

const VALID_URL = 'https://hooks.slack.com/services/T000/B000/XXXX';

// Radix Select does not open reliably in jsdom; a native select keeps the wiring testable.
vi.mock('../../ui/select', () => ({
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
  const approveProjectWebhook = vi.fn();
  const generateProjectWebhookSecret = vi.fn();
  const setProjectWebhookUnsigned = vi.fn();
  const sendProjectTestWebhook = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      sendTestWebhook,
      approveProjectWebhook,
      generateProjectWebhookSecret,
      setProjectWebhookUnsigned,
      sendProjectTestWebhook
    };
  });

  const approval = (status: 'approved' | 'unapproved' | 'refused', url = VALID_URL) =>
    ({ status, hash: 'hash123', url });

  const createdAt = '2026-11-27T12:00:00.000Z';
  const signingKeys = en.projectSections.webhook.signing;
  const signingView = (status: NonNullable<ProjectEnvConfig['webhookSigning']>['status'], patch: Partial<ProjectEnvConfig> = {}) => (
    <WebhookIntegration
      projectId="p1"
      envConfig={makeConfig({
        webhookUrl: VALID_URL,
        webhookApproval: approval('approved'),
        webhookSigning: { status, createdAt: status === 'signed' ? createdAt : undefined },
        ...patch
      })}
      updateEnvConfig={updateEnvConfig}
    />
  );

  it('unapproved: shows the full unmasked URL, Approve button, and disables test', () => {
    render(
      <WebhookIntegration
        projectId="p1"
        envConfig={makeConfig({ webhookUrl: VALID_URL, webhookApproval: approval('unapproved') })}
        updateEnvConfig={updateEnvConfig}
      />
    );
    expect(screen.getByText(VALID_URL)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve url/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send test message/i })).toBeDisabled();
  });

  it('Approve calls the API with projectId and hash and patches status', async () => {
    approveProjectWebhook.mockResolvedValue({ success: true });
    render(
      <WebhookIntegration
        projectId="p1"
        envConfig={makeConfig({ webhookUrl: VALID_URL, webhookApproval: approval('unapproved') })}
        updateEnvConfig={updateEnvConfig}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /approve url/i }));
    expect(approveProjectWebhook).toHaveBeenCalledWith('p1', 'hash123');
    await waitFor(() =>
      expect(updateEnvConfig).toHaveBeenCalledWith({
        webhookApproval: { status: 'approved', hash: 'hash123', url: VALID_URL }
      })
    );
  });

  it('Approve failure shows the returned error', async () => {
    approveProjectWebhook.mockResolvedValue({ success: false, error: 'changed' });
    render(
      <WebhookIntegration
        projectId="p1"
        envConfig={makeConfig({ webhookUrl: VALID_URL, webhookApproval: approval('unapproved') })}
        updateEnvConfig={updateEnvConfig}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /approve url/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/changed/));
    expect(updateEnvConfig).not.toHaveBeenCalled();
  });

  it('refused loopback shows an alert and disables test', () => {
    const url = 'http://localhost:8080/hook';
    render(
      <WebhookIntegration
        projectId="p1"
        envConfig={makeConfig({ webhookUrl: url, webhookApproval: approval('refused', url) })}
        updateEnvConfig={updateEnvConfig}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/refused/i);
    expect(screen.getByRole('button', { name: /send test message/i })).toBeDisabled();
  });

  it('renders nothing when envConfig is null', () => {
    const { container } = render(<WebhookIntegration projectId="p1" envConfig={null} updateEnvConfig={updateEnvConfig} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('masks the URL and toggles visibility', () => {
    render(<WebhookIntegration projectId="p1" envConfig={makeConfig({ webhookUrl: VALID_URL })} updateEnvConfig={updateEnvConfig} />);
    const input = screen.getByLabelText(/project webhook url/i);
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: /show url/i }));
    expect(input).toHaveAttribute('type', 'url');
  });

  it('shows an error and disables test for an invalid URL', () => {
    render(<WebhookIntegration projectId="p1" envConfig={makeConfig({ webhookUrl: 'http://localhost:8080/x' })} updateEnvConfig={updateEnvConfig} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText(/project webhook url/i)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: /send test message/i })).toBeDisabled();
  });

  it('tests a URL without a saved approval unsigned and shows success', async () => {
    sendTestWebhook.mockResolvedValue({ success: true, data: { success: true } });
    render(<WebhookIntegration projectId="p1" envConfig={makeConfig({ webhookUrl: `  ${VALID_URL}  ` })} updateEnvConfig={updateEnvConfig} />);
    fireEvent.click(screen.getByRole('button', { name: /send test message/i }));
    expect(sendTestWebhook).toHaveBeenCalledWith(VALID_URL, 'auto', '');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/test message sent/i));
  });

  it('shows failure when the test fails', async () => {
    sendTestWebhook.mockResolvedValue({ success: false, error: 'nope' });
    render(<WebhookIntegration projectId="p1" envConfig={makeConfig({ webhookUrl: VALID_URL })} updateEnvConfig={updateEnvConfig} />);
    fireEvent.click(screen.getByRole('button', { name: /send test message/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not send/i));
  });

  it('choosing Teams and Discord updates webhookFormat', () => {
    render(<WebhookIntegration projectId="p1" envConfig={makeConfig()} updateEnvConfig={updateEnvConfig} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'teams' } });
    expect(updateEnvConfig).toHaveBeenCalledWith({ webhookFormat: 'teams' });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'discord' } });
    expect(updateEnvConfig).toHaveBeenCalledWith({ webhookFormat: 'discord' });
  });

  it('sends the chosen format with the test message', async () => {
    sendTestWebhook.mockResolvedValue({ success: true, data: { success: true } });
    render(<WebhookIntegration projectId="p1" envConfig={makeConfig({ webhookUrl: VALID_URL, webhookFormat: 'teams' })} updateEnvConfig={updateEnvConfig} />);
    expect(screen.getByRole('combobox')).toHaveValue('teams');
    fireEvent.click(screen.getByRole('button', { name: /send test message/i }));
    expect(sendTestWebhook).toHaveBeenCalledWith(VALID_URL, 'teams', '');
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
  });

  it('shows the detected format hint on auto for a Teams workflow URL', () => {
    render(<WebhookIntegration projectId="p1" envConfig={makeConfig({ webhookUrl: TEAMS_URL })} updateEnvConfig={updateEnvConfig} />);
    expect(screen.getByText(/detected format: microsoft teams/i)).toBeInTheDocument();
  });

  it('changing the format clears the test result', async () => {
    sendTestWebhook.mockResolvedValue({ success: true, data: { success: true } });
    render(<WebhookIntegration projectId="p1" envConfig={makeConfig({ webhookUrl: VALID_URL })} updateEnvConfig={updateEnvConfig} />);
    fireEvent.click(screen.getByRole('button', { name: /send test message/i }));
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'teams' } });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('toggling an event merges webhookEvents over the defaults', () => {
    render(<WebhookIntegration projectId="p1" envConfig={makeConfig()} updateEnvConfig={updateEnvConfig} />);
    fireEvent.click(screen.getByRole('switch', { name: /pr opened/i }));
    expect(updateEnvConfig).toHaveBeenCalledWith({
      webhookEvents: { reviewReady: true, failed: true, blocked: true, prOpened: true }
    });
  });

  it('toggling enable calls updateEnvConfig', () => {
    render(<WebhookIntegration projectId="p1" envConfig={makeConfig({ webhookEnabled: false })} updateEnvConfig={updateEnvConfig} />);
    fireEvent.click(screen.getByRole('switch', { name: /project webhook$/i }));
    expect(updateEnvConfig).toHaveBeenCalledWith({ webhookEnabled: true });
  });

  it.each(['unapproved', 'refused'] as const)('hides signing controls for a %s URL', (status) => {
    render(signingView('choice_required', { webhookApproval: approval(status) }));
    expect(screen.queryByText(signingKeys.choiceRequired)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: signingKeys.generate })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: signingKeys.sendUnsigned })).not.toBeInTheDocument();
  });

  it('prompts for a signing choice when migrating a previously signed project', () => {
    render(signingView('choice_required'));
    expect(screen.getByText(signingKeys.choiceRequired)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: signingKeys.generate })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: signingKeys.sendUnsigned })).toBeInTheDocument();
  });

  it('shows a recovery action when the project secret cannot be decrypted', () => {
    render(signingView('secret_unavailable'));
    expect(screen.getByRole('alert')).toHaveTextContent(signingKeys.secretUnavailable);
    expect(screen.getByRole('button', { name: signingKeys.generateNew })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: signingKeys.sendUnsigned })).not.toBeInTheDocument();
  });

  it('shows signed status, creation date, and rotation controls without revealing a stored secret', () => {
    render(signingView('signed'));
    expect(screen.getByText(signingKeys.signed)).toBeInTheDocument();
    const date = new Date(createdAt).toLocaleDateString('en');
    expect(screen.getByText(signingKeys.createdAt.replace('{{date}}', date))).toBeInTheDocument();
    expect(screen.getByText(signingKeys.rotationNote)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: signingKeys.rotate })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: signingKeys.stopSigning })).toBeInTheDocument();
    expect(screen.queryByLabelText(signingKeys.secretLabel)).not.toBeInTheDocument();
  });

  it('shows unsigned status and offers to generate a secret', () => {
    render(signingView('unsigned'));
    expect(screen.getByText(signingKeys.unsigned)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: signingKeys.generate })).toBeInTheDocument();
  });

  it('generates a secret for the approved hash, stores only metadata, and clears the reveal on URL change', async () => {
    const secret = 'test-only-project-secret';
    generateProjectWebhookSecret.mockResolvedValue({ success: true, data: { secret, createdAt } });
    const { rerender, unmount } = render(signingView('choice_required'));
    fireEvent.click(screen.getByRole('button', { name: signingKeys.generate }));
    expect(generateProjectWebhookSecret).toHaveBeenCalledWith('p1', 'hash123');
    const secretInput = await screen.findByLabelText(signingKeys.secretLabel);
    expect(secretInput).toHaveValue(secret);
    expect(secretInput).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: signingKeys.copySecret })).toBeInTheDocument();
    expect(screen.getByText(signingKeys.revealNote)).toBeInTheDocument();
    expect(updateEnvConfig).toHaveBeenCalledWith({ webhookSigning: { status: 'signed', createdAt } });

    rerender(signingView('signed'));
    expect(screen.getByLabelText(signingKeys.secretLabel)).toHaveValue(secret);
    rerender(signingView('signed', { webhookUrl: TEAMS_URL }));
    expect(screen.queryByLabelText(signingKeys.secretLabel)).not.toBeInTheDocument();
    rerender(signingView('signed'));
    expect(screen.queryByLabelText(signingKeys.secretLabel)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: signingKeys.rotate }));
    expect(await screen.findByLabelText(signingKeys.secretLabel)).toHaveValue(secret);
    unmount();
    render(signingView('signed'));
    expect(screen.queryByLabelText(signingKeys.secretLabel)).not.toBeInTheDocument();
  });

  it('ignores a late generation result after the approved URL has been edited', async () => {
    let finishGeneration!: (result: { success: true; data: { secret: string; createdAt: string } }) => void;
    generateProjectWebhookSecret.mockReturnValue(new Promise((resolve) => { finishGeneration = resolve; }));
    const { rerender } = render(signingView('unsigned'));
    fireEvent.click(screen.getByRole('button', { name: signingKeys.generate }));
    rerender(signingView('unsigned', { webhookUrl: TEAMS_URL }));
    await act(async () => finishGeneration({ success: true, data: { secret: 'test-only-secret', createdAt } }));
    expect(updateEnvConfig).not.toHaveBeenCalled();
    rerender(signingView('signed'));
    expect(screen.queryByLabelText(signingKeys.secretLabel)).not.toBeInTheDocument();
  });

  it.each([
    ['choice_required', signingKeys.sendUnsigned],
    ['signed', signingKeys.stopSigning]
  ] as const)('opts out of signing from %s using the approved hash', async (status, label) => {
    setProjectWebhookUnsigned.mockResolvedValue({ success: true });
    render(signingView(status));
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(setProjectWebhookUnsigned).toHaveBeenCalledWith('p1', 'hash123');
    await waitFor(() => expect(updateEnvConfig).toHaveBeenCalledWith({ webhookSigning: { status: 'unsigned' } }));
  });

  it('reports a signing update failure without changing signing metadata', async () => {
    generateProjectWebhookSecret.mockResolvedValue({ success: false, error: 'secret_unavailable' });
    render(signingView('unsigned'));
    fireEvent.click(screen.getByRole('button', { name: signingKeys.generate }));
    expect(await screen.findByRole('alert')).toHaveTextContent(signingKeys.generateFailed);
    expect(updateEnvConfig).not.toHaveBeenCalled();
  });

  it('tests an approved URL through the project-specific endpoint', async () => {
    sendProjectTestWebhook.mockResolvedValue({ success: true });
    render(signingView('signed', { webhookFormat: 'discord' }));
    fireEvent.click(screen.getByRole('button', { name: /send test message/i }));
    expect(sendProjectTestWebhook).toHaveBeenCalledWith('p1', 'hash123', 'discord');
    expect(sendTestWebhook).not.toHaveBeenCalled();
    expect(await screen.findByText(/test message sent/i)).toBeInTheDocument();
  });

  it('warns about key replacement and sends the edited URL test unsigned', async () => {
    sendTestWebhook.mockResolvedValue({ success: true });
    render(signingView('signed', { webhookUrl: TEAMS_URL, webhookFormat: 'teams' }));
    expect(screen.getByText(signingKeys.changedUrlNote)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: signingKeys.rotate })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /send test message/i }));
    expect(sendTestWebhook).toHaveBeenCalledWith(TEAMS_URL, 'teams', '');
    expect(sendProjectTestWebhook).not.toHaveBeenCalled();
    expect(await screen.findByText(/test message sent/i)).toBeInTheDocument();
  });

  it.each([
    ['signing_choice_required', signingKeys.testChoiceRequired],
    ['secret_unavailable', signingKeys.testSecretUnavailable]
  ])('reports a specific test failure for %s without falling back to another send', async (error, message) => {
    sendProjectTestWebhook.mockResolvedValue({ success: false, error });
    render(signingView('signed'));
    fireEvent.click(screen.getByRole('button', { name: /send test message/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(sendTestWebhook).not.toHaveBeenCalled();
  });

  it('has identical projectSections.webhook keys in en and fr', () => {
    const enKeys = flatKeys(en.projectSections.webhook).sort();
    const frKeys = flatKeys(fr.projectSections.webhook).sort();
    expect(enKeys.length).toBeGreaterThan(0);
    expect(frKeys).toEqual(enKeys);
  });
});
