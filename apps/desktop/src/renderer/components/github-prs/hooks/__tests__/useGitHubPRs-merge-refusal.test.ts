/**
 * @vitest-environment jsdom
 *
 * zeenha fork: with PR-only landing the main process refuses an in-app PR
 * merge and answers a bare `false`. The Merge button used to spin and stop
 * with no word; the hook now says why, and never asks the main process.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PR_ONLY_LANDING_MESSAGE } from '../../../../../shared/utils/landing-policy';
import { useProjectStore } from '../../../../stores/project-store';
import { useGitHubPRs } from '../useGitHubPRs';

const mergePR = vi.fn();

/** Every other electronAPI call answers harmlessly. */
function api(overrides: Record<string, unknown>): unknown {
  return new Proxy(overrides, {
    get: (target, key) =>
      key in target ? target[key as string] : vi.fn(() => (String(key).startsWith('on') ? () => undefined : Promise.resolve({ success: true, data: [] }))),
  });
}

beforeEach(() => {
  mergePR.mockReset();
  (window as unknown as { electronAPI: unknown }).electronAPI = api({ github: api({ mergePR }) });
});
afterEach(() => useProjectStore.setState({ projects: [] }));

function withProject(settings: Record<string, unknown>) {
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'p', path: '/p', settings } as never] });
}

describe('useGitHubPRs().mergePR under PR-only landing', () => {
  it('refuses with the PR-only message and does not ask the main process', async () => {
    withProject({});
    const { result } = renderHook(() => useGitHubPRs('p1', { isActive: false }));

    let merged: boolean | undefined;
    await act(async () => {
      merged = await result.current.mergePR(7);
    });

    expect(merged).toBe(false);
    expect(mergePR).not.toHaveBeenCalled();
    expect(result.current.error).toBe(PR_ONLY_LANDING_MESSAGE);
  });

  it('merges when the project switched PR-only landing off, and says so when it did not', async () => {
    withProject({ prOnlyLanding: false });
    mergePR.mockResolvedValue(false);
    const { result } = renderHook(() => useGitHubPRs('p1', { isActive: false }));

    await act(async () => {
      await result.current.mergePR(7);
    });

    expect(mergePR).toHaveBeenCalledWith('p1', 7, 'squash');
    expect(result.current.error).toBe('The pull request was not merged.');
  });
});
