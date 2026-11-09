import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../pty-manager', () => ({
  getActiveProfileEnv: vi.fn(() => ({})),
  spawnPtyProcess: vi.fn(() => ({ pty: { pid: 1 }, shellType: 'bash' })),
  setupPtyHandlers: vi.fn(),
}));
vi.mock('../session-handler', () => ({
  clearPendingDelete: vi.fn(),
  persistSessionAsync: vi.fn(),
  getSavedSessions: vi.fn(() => []),
  removePersistedSession: vi.fn(),
  releaseSessionId: vi.fn(),
}));
vi.mock('../../claude-code-settings', async () => {
  const actual = await vi.importActual<typeof import('../../claude-code-settings/env-drop-notice')>(
    '../../claude-code-settings/env-drop-notice'
  );
  return {
    getClaudeCodeEnvWithReport: vi.fn(),
    formatDroppedEnvNotice: actual.formatDroppedEnvNotice,
  };
});
vi.mock('../../ipc-handlers/utils', () => ({ safeSendToRenderer: vi.fn() }));
vi.mock('../../../shared/utils/debug-logger', () => ({ debugLog: vi.fn(), debugError: vi.fn() }));

import { createTerminal } from '../terminal-lifecycle';
import * as PtyManager from '../pty-manager';
import { getClaudeCodeEnvWithReport } from '../../claude-code-settings';
import { safeSendToRenderer } from '../../ipc-handlers/utils';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { TerminalProcess } from '../types';

describe('createTerminal env handling', () => {
  const getWindow = () => null;
  let terminals: Map<string, TerminalProcess>;

  beforeEach(() => {
    vi.clearAllMocks();
    terminals = new Map();
  });

  it('never passes dropped ANTHROPIC_BASE_URL to the PTY and shows a notice', async () => {
    vi.mocked(getClaudeCodeEnvWithReport).mockReturnValue({
      env: { SAFE_VAR: 'x' },
      dropped: [{ key: 'ANTHROPIC_BASE_URL', reason: 'project-policy', level: 'projectShared' }],
    });
    const res = await createTerminal({ id: 't1', cwd: '/tmp', projectPath: '/p' }, terminals, getWindow, vi.fn());
    expect(res.success).toBe(true);
    const env = vi.mocked(PtyManager.spawnPtyProcess).mock.calls[0][3] as Record<string, string>;
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.SAFE_VAR).toBe('x');
    expect(safeSendToRenderer).toHaveBeenCalledWith(
      getWindow, IPC_CHANNELS.TERMINAL_OUTPUT, 't1', expect.stringContaining('ANTHROPIC_BASE_URL')
    );
    expect(terminals.get('t1')?.outputBuffer).toContain('ANTHROPIC_BASE_URL');
  });

  it('profile env still overrides settings env', async () => {
    vi.mocked(getClaudeCodeEnvWithReport).mockReturnValue({ env: { CLAUDE_CONFIG_DIR: '/settings' }, dropped: [] });
    vi.mocked(PtyManager.getActiveProfileEnv).mockReturnValue({ CLAUDE_CONFIG_DIR: '/profile' });
    await createTerminal({ id: 't2', cwd: '/tmp', projectPath: '/p' }, terminals, getWindow, vi.fn());
    const env = vi.mocked(PtyManager.spawnPtyProcess).mock.calls[0][3] as Record<string, string>;
    expect(env.CLAUDE_CONFIG_DIR).toBe('/profile');
  });

  it('sends no notice when nothing was dropped', async () => {
    vi.mocked(getClaudeCodeEnvWithReport).mockReturnValue({ env: {}, dropped: [] });
    await createTerminal({ id: 't3', cwd: '/tmp', projectPath: '/p' }, terminals, getWindow, vi.fn());
    expect(safeSendToRenderer).not.toHaveBeenCalled();
    expect(terminals.get('t3')?.outputBuffer).toBe('');
  });
});
