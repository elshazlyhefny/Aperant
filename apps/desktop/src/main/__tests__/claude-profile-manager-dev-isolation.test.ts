import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  app: { isPackaged: false, getPath: () => '/dev-data' },
}));
vi.mock('electron', () => electron);

import { ClaudeProfileManager } from '../claude-profile-manager';

describe('ClaudeProfileManager default profile', () => {
  it('stays inside a dev instance data folder', () => {
    electron.app.isPackaged = false;

    expect(new ClaudeProfileManager().getActiveProfile().configDir).toBe(
      join('/dev-data', 'claude-profiles', 'primary'),
    );
  });

  it('uses the shared profiles folder in a packaged app', () => {
    electron.app.isPackaged = true;

    expect(new ClaudeProfileManager().getActiveProfile().configDir).toBe(
      join(homedir(), '.claude-profiles', 'primary'),
    );
  });
});
