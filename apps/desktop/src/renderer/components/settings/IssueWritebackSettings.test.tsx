/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../shared/i18n';
import { IssueWritebackSettings } from './IssueWritebackSettings';
import { DEFAULT_APP_SETTINGS } from '../../../shared/constants/config';
import type { RendererAppSettings } from '../../../shared/types';
import en from '../../../shared/i18n/locales/en/settings.json';
import fr from '../../../shared/i18n/locales/fr/settings.json';

function makeSettings(issueWriteback?: RendererAppSettings['issueWriteback']): RendererAppSettings {
  return { ...(DEFAULT_APP_SETTINGS as unknown as RendererAppSettings), issueWriteback };
}

function flatKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? flatKeys(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]
  );
}

const DEFAULTS = {
  github: false,
  gitlab: false,
  linear: false,
  linearTransitionOnReview: false,
  linearTransitionStateName: 'In Review',
  azureboards: false,
  azureBoardsTransitionOnReview: false,
  azureBoardsTransitionStateName: 'Resolved'
};

describe('IssueWritebackSettings', () => {
  const onSettingsChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders six switches, all off by default', () => {
    render(<IssueWritebackSettings settings={makeSettings(undefined)} onSettingsChange={onSettingsChange} />);
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(6);
    for (const s of switches) {
      expect(s).not.toBeChecked();
    }
  });

  it.each(['github', 'gitlab', 'linear', 'azureboards'] as const)(
    'toggling %s emits the right shape without altering the others',
    (key) => {
      const { container } = render(
        <IssueWritebackSettings settings={makeSettings(undefined)} onSettingsChange={onSettingsChange} />
      );
      fireEvent.click(container.querySelector(`#issue-writeback-${key}`) as HTMLElement);
      const next = onSettingsChange.mock.calls[0][0] as RendererAppSettings;
      expect(next.issueWriteback).toEqual({ ...DEFAULTS, [key]: true });
    }
  );

  it('preserves other enabled providers when toggling one', () => {
    const { container } = render(
      <IssueWritebackSettings
        settings={makeSettings({ ...DEFAULTS, github: true, linear: true })}
        onSettingsChange={onSettingsChange}
      />
    );
    fireEvent.click(container.querySelector('#issue-writeback-gitlab') as HTMLElement);
    const next = onSettingsChange.mock.calls[0][0] as RendererAppSettings;
    expect(next.issueWriteback).toEqual({ ...DEFAULTS, github: true, gitlab: true, linear: true });
  });

  it('toggling the Linear transition switch emits linearTransitionOnReview: true', () => {
    const { container } = render(
      <IssueWritebackSettings settings={makeSettings(undefined)} onSettingsChange={onSettingsChange} />
    );
    fireEvent.click(container.querySelector('#issue-writeback-linearTransitionOnReview') as HTMLElement);
    const next = onSettingsChange.mock.calls[0][0] as RendererAppSettings;
    expect(next.issueWriteback).toEqual({ ...DEFAULTS, linearTransitionOnReview: true });
  });

  it('typing in the state name input emits the new name', () => {
    const { container } = render(
      <IssueWritebackSettings
        settings={makeSettings({ ...DEFAULTS, linearTransitionOnReview: true })}
        onSettingsChange={onSettingsChange}
      />
    );
    fireEvent.change(container.querySelector('#issue-writeback-linear-state-name') as HTMLElement, {
      target: { value: 'Done' }
    });
    const next = onSettingsChange.mock.calls[0][0] as RendererAppSettings;
    expect(next.issueWriteback).toEqual({
      ...DEFAULTS,
      linearTransitionOnReview: true,
      linearTransitionStateName: 'Done'
    });
  });

  it('disables the state name input while the transition toggle is off', () => {
    const { container, rerender } = render(
      <IssueWritebackSettings settings={makeSettings(undefined)} onSettingsChange={onSettingsChange} />
    );
    expect(container.querySelector('#issue-writeback-linear-state-name')).toBeDisabled();
    rerender(
      <IssueWritebackSettings
        settings={makeSettings({ ...DEFAULTS, linearTransitionOnReview: true })}
        onSettingsChange={onSettingsChange}
      />
    );
    expect(container.querySelector('#issue-writeback-linear-state-name')).not.toBeDisabled();
  });

  it('toggling the Azure Boards transition switch emits azureBoardsTransitionOnReview: true', () => {
    const { container } = render(
      <IssueWritebackSettings settings={makeSettings(undefined)} onSettingsChange={onSettingsChange} />
    );
    fireEvent.click(container.querySelector('#issue-writeback-azureBoardsTransitionOnReview') as HTMLElement);
    const next = onSettingsChange.mock.calls[0][0] as RendererAppSettings;
    expect(next.issueWriteback).toEqual({ ...DEFAULTS, azureBoardsTransitionOnReview: true });
  });

  it('typing in the Azure Boards state input emits the new name', () => {
    const { container } = render(
      <IssueWritebackSettings
        settings={makeSettings({ ...DEFAULTS, azureBoardsTransitionOnReview: true })}
        onSettingsChange={onSettingsChange}
      />
    );
    fireEvent.change(container.querySelector('#issue-writeback-azureboards-state-name') as HTMLElement, {
      target: { value: 'Closed' }
    });
    const next = onSettingsChange.mock.calls[0][0] as RendererAppSettings;
    expect(next.issueWriteback).toEqual({
      ...DEFAULTS,
      azureBoardsTransitionOnReview: true,
      azureBoardsTransitionStateName: 'Closed'
    });
  });

  it('disables the Azure Boards state input until its move switch is on, independent of Linear', () => {
    const { container, rerender } = render(
      <IssueWritebackSettings
        settings={makeSettings({ ...DEFAULTS, linearTransitionOnReview: true })}
        onSettingsChange={onSettingsChange}
      />
    );
    expect(container.querySelector('#issue-writeback-azureboards-state-name')).toBeDisabled();
    expect(container.querySelector('#issue-writeback-linear-state-name')).not.toBeDisabled();
    rerender(
      <IssueWritebackSettings
        settings={makeSettings({ ...DEFAULTS, azureBoardsTransitionOnReview: true })}
        onSettingsChange={onSettingsChange}
      />
    );
    expect(container.querySelector('#issue-writeback-azureboards-state-name')).not.toBeDisabled();
    expect(container.querySelector('#issue-writeback-linear-state-name')).toBeDisabled();
  });

  it('has identical notifications.issueWriteback.* keys in en and fr', () => {
    const enKeys = flatKeys(en.notifications.issueWriteback).sort();
    const frKeys = flatKeys(fr.notifications.issueWriteback).sort();
    expect(enKeys.length).toBeGreaterThan(0);
    expect(frKeys).toEqual(enKeys);
  });
});
