/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../shared/i18n';
import { JiraWritebackSettings } from './JiraWritebackSettings';
import { DEFAULT_APP_SETTINGS } from '../../../shared/constants/config';
import type { AppSettings } from '../../../shared/types';
import en from '../../../shared/i18n/locales/en/settings.json';
import fr from '../../../shared/i18n/locales/fr/settings.json';

function makeSettings(jiraWriteback?: AppSettings['jiraWriteback']): AppSettings {
  return { ...(DEFAULT_APP_SETTINGS as unknown as AppSettings), jiraWriteback };
}

function flatKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? flatKeys(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]
  );
}

describe('JiraWritebackSettings', () => {
  const onSettingsChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders with undefined settings using defaults', () => {
    render(<JiraWritebackSettings settings={makeSettings(undefined)} onSettingsChange={onSettingsChange} />);
    expect(screen.getAllByRole('switch')).toHaveLength(3);
    expect(screen.getByRole('textbox')).toHaveValue('In Review');
  });

  it('toggling enabled calls onSettingsChange with the right patch', () => {
    render(<JiraWritebackSettings settings={makeSettings(undefined)} onSettingsChange={onSettingsChange} />);
    fireEvent.click(screen.getByRole('switch', { name: /enable jira write-back/i }));
    const next = onSettingsChange.mock.calls[0][0] as AppSettings;
    expect(next.jiraWriteback).toEqual({
      enabled: true,
      comment: true,
      transitionOnReview: false,
      transitionStatusName: 'In Review'
    });
  });

  it('disables the status name input until the transition toggle is on', () => {
    const { rerender } = render(
      <JiraWritebackSettings settings={makeSettings(undefined)} onSettingsChange={onSettingsChange} />
    );
    expect(screen.getByRole('textbox')).toBeDisabled();
    rerender(
      <JiraWritebackSettings
        settings={makeSettings({ enabled: true, comment: true, transitionOnReview: true, transitionStatusName: 'Done' })}
        onSettingsChange={onSettingsChange}
      />
    );
    expect(screen.getByRole('textbox')).toBeEnabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'QA' } });
    const next = onSettingsChange.mock.calls[0][0] as AppSettings;
    expect(next.jiraWriteback?.transitionStatusName).toBe('QA');
  });

  it('has identical notifications.jiraWriteback.* keys in en and fr', () => {
    const enKeys = flatKeys(en.notifications.jiraWriteback).sort();
    const frKeys = flatKeys(fr.notifications.jiraWriteback).sort();
    expect(enKeys.length).toBeGreaterThan(0);
    expect(frKeys).toEqual(enKeys);
  });
});
