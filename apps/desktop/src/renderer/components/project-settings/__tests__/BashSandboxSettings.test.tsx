/**
 * @vitest-environment jsdom
 */
/**
 * zeenha fork: the Security page shows whether the Bash sandbox can run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import i18n from '../../../../shared/i18n';
import { BashSandboxSettings } from '../BashSandboxSettings';
import type { BashSandboxMode, ProjectSettings, SandboxAvailability } from '../../../../shared/types';

function mockAvailability(data: SandboxAvailability) {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getSandboxAvailability: vi.fn().mockResolvedValue({ success: true, data }),
  };
}

function renderIt(mode?: BashSandboxMode) {
  const settings = (mode ? { bashSandbox: mode } : {}) as ProjectSettings;
  return render(<BashSandboxSettings settings={settings} setSettings={vi.fn()} />);
}

const available: SandboxAvailability = { state: 'available', tool: 'bwrap', installHint: null };
const missingLinux: SandboxAvailability = { state: 'tool-missing', tool: 'bwrap', installHint: 'bubblewrap' };
const missingMac: SandboxAvailability = { state: 'tool-missing', tool: 'sandbox-exec', installHint: null };
const unsupported: SandboxAvailability = { state: 'unsupported', tool: null, installHint: null };
const windows: SandboxAvailability = {
  state: 'available', tool: 'powershell', installHint: null, unsupportedModes: ['home-hidden-no-network'],
};

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('BashSandboxSettings', () => {
  it('shows active when the tool exists and a mode is on', async () => {
    mockAvailability(available);
    renderIt('home-hidden');
    expect(await screen.findByText('Sandbox active')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows available but off, treating an absent value as off', async () => {
    mockAvailability(available);
    renderIt();
    expect(await screen.findByText('Available, off')).toBeInTheDocument();
  });

  it('shows install guidance when bubblewrap is missing, and warns for a stored mode', async () => {
    mockAvailability(missingLinux);
    renderIt('home-hidden');
    expect(await screen.findByText('Sandbox tool missing')).toBeInTheDocument();
    expect(screen.getByText(/apt install bubblewrap/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/refused/);
  });

  it('does not warn while the mode is off', async () => {
    mockAvailability(missingMac);
    renderIt('off');
    expect(await screen.findByText('Sandbox tool missing')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows unsupported platforms and warns when a mode is stored', async () => {
    mockAvailability(unsupported);
    renderIt('home-hidden-no-network');
    expect(await screen.findByText('Not supported on this platform')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('marks a mode Windows cannot enforce as refused and explains the Windows model', async () => {
    mockAvailability(windows);
    renderIt('home-hidden-no-network');
    expect(await screen.findByText('Mode not supported here')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/refused/);
    expect(screen.getByText(/restricted token/)).toBeInTheDocument();
  });

  it('keeps home-hidden active on Windows', async () => {
    mockAvailability(windows);
    renderIt('home-hidden');
    expect(await screen.findByText('Sandbox active')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('explains both modes', async () => {
    mockAvailability(available);
    renderIt();
    await screen.findByText('Available, off');
    expect(screen.getByText(/Home directory hidden:/)).toBeInTheDocument();
    expect(screen.getByText(/Home directory hidden and no network:/)).toBeInTheDocument();
  });

  it('is translated into French', async () => {
    await i18n.changeLanguage('fr');
    mockAvailability(available);
    renderIt('home-hidden');
    expect(await screen.findByText('Bac à sable actif')).toBeInTheDocument();
  });
});
