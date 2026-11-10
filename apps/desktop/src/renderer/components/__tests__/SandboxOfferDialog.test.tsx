/**
 * @vitest-environment jsdom
 */
/**
 * zeenha fork: the sandbox offer shown after a project is added.
 * Translation keys are returned as-is so the test does not depend on locale files.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { SandboxOfferDialog } from '../SandboxOfferDialog';
import type { Project, SandboxAvailability } from '../../../shared/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const project = { id: 'p1', name: 'Demo', path: '/tmp/demo' } as Project;
const availability: SandboxAvailability = { state: 'available', tool: 'bwrap', installHint: null };

function renderIt(avail: SandboxAvailability = availability) {
  const onEnable = vi.fn();
  const onSkip = vi.fn();
  render(
    <SandboxOfferDialog open project={project} availability={avail} onEnable={onEnable} onSkip={onSkip} />
  );
  return { onEnable, onSkip };
}

describe('SandboxOfferDialog', () => {
  it('explains both modes and the fail-closed behaviour', () => {
    renderIt();
    expect(screen.getByText('sandboxOffer.homeHidden.description')).toBeInTheDocument();
    expect(screen.getByText('sandboxOffer.homeHiddenNoNetwork.description')).toBeInTheDocument();
    expect(screen.getByText('sandboxOffer.failClosed')).toBeInTheDocument();
  });

  it('enables home-hidden', () => {
    const { onEnable, onSkip } = renderIt();
    fireEvent.click(screen.getByRole('button', { name: 'sandboxOffer.homeHidden.label' }));
    expect(onEnable).toHaveBeenCalledWith('home-hidden');
    expect(onSkip).not.toHaveBeenCalled();
  });

  it('enables home-hidden-no-network', () => {
    const { onEnable } = renderIt();
    fireEvent.click(screen.getByRole('button', { name: 'sandboxOffer.homeHiddenNoNetwork.label' }));
    expect(onEnable).toHaveBeenCalledWith('home-hidden-no-network');
  });

  it('does not offer the no-network mode where the platform refuses it', () => {
    renderIt({ state: 'available', tool: 'powershell', installHint: null, unsupportedModes: ['home-hidden-no-network'] });
    expect(screen.queryByRole('button', { name: 'sandboxOffer.homeHiddenNoNetwork.label' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'sandboxOffer.homeHidden.label' })).toBeInTheDocument();
  });

  it('skips with Not now', () => {
    const { onEnable, onSkip } = renderIt();
    fireEvent.click(screen.getByRole('button', { name: 'sandboxOffer.skip' }));
    expect(onSkip).toHaveBeenCalled();
    expect(onEnable).not.toHaveBeenCalled();
  });
});
