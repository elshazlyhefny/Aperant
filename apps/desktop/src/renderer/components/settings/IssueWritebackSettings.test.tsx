/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../shared/i18n';
import { IssueWritebackSettings } from './IssueWritebackSettings';
import { DEFAULT_APP_SETTINGS } from '../../../shared/constants/config';
import type { AppSettings } from '../../../shared/types';
import en from '../../../shared/i18n/locales/en/settings.json';
import fr from '../../../shared/i18n/locales/fr/settings.json';

function makeSettings(issueWriteback?: AppSettings['issueWriteback']): AppSettings {
  return { ...(DEFAULT_APP_SETTINGS as unknown as AppSettings), issueWriteback };
}

function flatKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? flatKeys(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]
  );
}

describe('IssueWritebackSettings', () => {
  const onSettingsChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders three switches, all off by default', () => {
    render(<IssueWritebackSettings settings={makeSettings(undefined)} onSettingsChange={onSettingsChange} />);
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(3);
    for (const s of switches) {
      expect(s).not.toBeChecked();
    }
  });

  it.each(['github', 'gitlab', 'linear'] as const)(
    'toggling %s emits the right shape without altering the others',
    (key) => {
      const { container } = render(
        <IssueWritebackSettings settings={makeSettings(undefined)} onSettingsChange={onSettingsChange} />
      );
      fireEvent.click(container.querySelector(`#issue-writeback-${key}`) as HTMLElement);
      const next = onSettingsChange.mock.calls[0][0] as AppSettings;
      expect(next.issueWriteback).toEqual({ github: false, gitlab: false, linear: false, [key]: true });
    }
  );

  it('preserves other enabled providers when toggling one', () => {
    const { container } = render(
      <IssueWritebackSettings
        settings={makeSettings({ github: true, gitlab: false, linear: true })}
        onSettingsChange={onSettingsChange}
      />
    );
    fireEvent.click(container.querySelector('#issue-writeback-gitlab') as HTMLElement);
    const next = onSettingsChange.mock.calls[0][0] as AppSettings;
    expect(next.issueWriteback).toEqual({ github: true, gitlab: true, linear: true });
  });

  it('has identical notifications.issueWriteback.* keys in en and fr', () => {
    const enKeys = flatKeys(en.notifications.issueWriteback).sort();
    const frKeys = flatKeys(fr.notifications.issueWriteback).sort();
    expect(enKeys.length).toBeGreaterThan(0);
    expect(frKeys).toEqual(enKeys);
  });
});
