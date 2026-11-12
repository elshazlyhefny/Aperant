/**
 * @vitest-environment jsdom
 */
/**
 * zeenha fork: the Security page lets the user pick the WebFetch provider.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import i18n from '../../../../shared/i18n';
import { WebFetchSettings } from '../WebFetchSettings';
import type { ProjectSettings } from '../../../../shared/types';

// Radix Select does not open reliably in jsdom; a native select keeps the wiring testable.
vi.mock('../../ui/select', () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: React.ReactNode }) => (
    <select aria-label="provider" value={value} onChange={(e) => onValueChange(e.target.value)}>
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

function renderIt(partial: Partial<ProjectSettings> = {}, setSettings = vi.fn()) {
  render(<WebFetchSettings settings={partial as ProjectSettings} setSettings={setSettings} />);
  return setSettings;
}

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('WebFetchSettings', () => {
  it('defaults to Jina and shows the Jina note', () => {
    renderIt();
    expect(screen.getByRole('combobox')).toHaveValue('jina');
    expect(screen.getByText(/receives every URL the agent fetches/)).toBeInTheDocument();
    expect(screen.getByText(/internal wiki links and presigned URLs/)).toBeInTheDocument();
  });

  it('selecting direct sets webFetchProvider', () => {
    const setSettings = renderIt();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'direct' } });
    expect(setSettings).toHaveBeenCalledTimes(1);
    const updater = setSettings.mock.calls[0][0] as (p: ProjectSettings) => ProjectSettings;
    expect(updater({} as ProjectSettings).webFetchProvider).toBe('direct');
  });

  it('shows the disabled note only under no-network', () => {
    const { unmount } = render(
      <WebFetchSettings settings={{} as ProjectSettings} setSettings={vi.fn()} />
    );
    expect(screen.queryByText(/turned off/)).not.toBeInTheDocument();
    unmount();
    renderIt({ bashSandbox: 'home-hidden-no-network' });
    expect(screen.getByText(/WebFetch and WebSearch are turned off/)).toBeInTheDocument();
  });
});
