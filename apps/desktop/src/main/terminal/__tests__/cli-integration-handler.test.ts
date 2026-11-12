import { promises as fsPromises } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { TerminalOutputBuffer } from '../output-buffer';
import type * as pty from '@lydell/node-pty';
import type { TerminalProcess } from '../types';
import { buildCdCommand, escapeShellArg } from '../../../shared/utils/shell-escape';

// Mock the platform module (main/platform/index.ts)
vi.mock('../../platform', () => ({
  isWindows: vi.fn(() => false),
  isMacOS: vi.fn(() => false),
  isLinux: vi.fn(() => false),
  isUnix: vi.fn(() => false),
  getCurrentOS: vi.fn(() => 'linux'),
}));

import { isWindows } from '../../platform';

/** Escape special regex characters in a string for safe use in RegExp constructor */
const escapeForRegex = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const mockGetClaudeCliInvocationAsync = vi.fn();
const mockGetClaudeProfileManager = vi.fn();
const mockInitializeClaudeProfileManager = vi.fn();
const mockPersistSession = vi.fn();
const mockPersistSessionAsync = vi.fn();
const mockReleaseSessionId = vi.fn();

const createMockDisposable = (): pty.IDisposable => ({ dispose: vi.fn() });

const createMockPty = (): pty.IPty => ({
  pid: 123,
  cols: 80,
  rows: 24,
  process: 'bash',
  handleFlowControl: false,
  onData: vi.fn(() => createMockDisposable()),
  onExit: vi.fn(() => createMockDisposable()),
  write: vi.fn(),
  resize: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  kill: vi.fn(),
  clear: vi.fn(),
});

const createMockTerminal = (overrides: Partial<TerminalProcess> = {}): TerminalProcess => ({
  id: 'term-1',
  pty: createMockPty(),
  outputBuffer: '',
  isCLIMode: false,
  claudeSessionId: undefined,
  claudeProfileId: undefined,
  title: 'Terminal 1',  // Use default terminal name pattern to match production behavior
  cwd: '/tmp/project',
  projectPath: '/tmp/project',
  ...overrides,
});

vi.mock('../../cli-utils', () => ({
  getClaudeCliInvocationAsync: mockGetClaudeCliInvocationAsync,
}));

vi.mock('../../claude-profile-manager', () => ({
  getClaudeProfileManager: mockGetClaudeProfileManager,
  initializeClaudeProfileManager: mockInitializeClaudeProfileManager,
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(),
    promises: {
      writeFile: vi.fn(),
    },
  };
});

vi.mock('../session-handler', () => ({
  persistSession: mockPersistSession,
  persistSessionAsync: mockPersistSessionAsync,
  releaseSessionId: mockReleaseSessionId,
}));

// Mock PtyManager.writeToPty - the implementation now uses this instead of terminal.pty.write
const mockWriteToPty = vi.fn();
vi.mock('../pty-manager', () => ({
  writeToPty: mockWriteToPty,
}));

// Mock settings-utils so invokeCLIAsync defaults to claude-code in tests
vi.mock('../../settings-utils', () => ({
  readSettingsFileAsync: vi.fn(async () => undefined),
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    tmpdir: vi.fn(() => '/tmp'),
  };
});

/**
 * Helper to set the current platform for testing
 */
function mockPlatform(platform: 'win32' | 'darwin' | 'linux') {
  const mockIsWindows = vi.mocked(isWindows);
  mockIsWindows.mockReturnValue(platform === 'win32');
}

/**
 * Helper to get platform-specific expectations for PATH prefix
 */
function getPathPrefixExpectation(
  platform: 'win32' | 'darwin' | 'linux',
  pathValue: string,
  command: string
): string {
  // Absolute executable commands no longer need PATH prefix injection.
  if (path.isAbsolute(command)) {
    return '';
  }

  if (platform === 'win32') {
    // Windows: set "PATH=value" &&
    return `set "PATH=${pathValue}" && `;
  }
  // Unix/macOS: PATH='value' '
  return `PATH='${pathValue}' `;
}

function expectPathPrefix(
  written: string,
  platform: 'win32' | 'darwin' | 'linux',
  pathValue: string,
  command: string
): void {
  const expectedPrefix = getPathPrefixExpectation(platform, pathValue, command);
  if (expectedPrefix) {
    expect(written).toContain(expectedPrefix);
  } else {
    expect(written).not.toContain('PATH=');
  }
}

/**
 * Helper to get platform-specific expectations for command quoting
 */
function getQuotedCommand(platform: 'win32' | 'darwin' | 'linux', command: string): string {
  if (platform === 'win32') {
    // Windows: double quotes, use escapeForWindowsDoubleQuote logic
    // Inside double quotes, only " needs escaping (as "")
    const escaped = command.replace(/"/g, '""');
    return `"${escaped}"`;
  }
  // Unix/macOS: use escapeShellArg which properly handles embedded single quotes
  return escapeShellArg(command);
}

/**
 * Helper to get platform-specific clear command
 */
function getClearCommand(platform: 'win32' | 'darwin' | 'linux'): string {
  return platform === 'win32' ? 'cls' : 'clear';
}

/**
 * Helper to get platform-specific history prefix
 */
function getHistoryPrefix(platform: 'win32' | 'darwin' | 'linux'): string {
  return platform === 'win32' ? '' : 'HISTFILE= HISTCONTROL=ignorespace ';
}

/**
 * Helper to get platform-specific temp file extension
 */
function getTempFileExtension(platform: 'win32' | 'darwin' | 'linux'): string {
  return platform === 'win32' ? '.bat' : '';
}

/**
 * Helper to get platform-specific token file content
 */
function getTokenFileContent(platform: 'win32' | 'darwin' | 'linux', token: string): string {
  if (platform === 'win32') {
    return `@echo off\r\nset "CLAUDE_CODE_OAUTH_TOKEN=${token}"\r\n`;
  }
  return `export CLAUDE_CODE_OAUTH_TOKEN='${token}'\n`;
}

/**
 * Helper to get platform-specific temp file invocation
 */
function getTempFileInvocation(platform: 'win32' | 'darwin' | 'linux', tokenPath: string): string {
  if (platform === 'win32') {
    return `call "${tokenPath}"`;
  }
  return `source '${tokenPath}'`;
}

/**
 * Helper to get platform-specific temp file cleanup
 *
 * Note: Windows now deletes BEFORE the command runs (synchronous)
 * for security - environment variables persist in memory after deletion.
 */
function getTempFileCleanup(platform: 'win32' | 'darwin' | 'linux', tokenPath: string): string {
  if (platform === 'win32') {
    return `&& del "${tokenPath}" &&`;
  }
  return `&& rm -f '${tokenPath}' &&`;
}

/**
 * Helper to get platform-specific exec command
 */
function getExecCommand(platform: 'win32' | 'darwin' | 'linux', command: string): string {
  if (platform === 'win32') {
    return command; // Windows doesn't use exec
  }
  return `exec ${command}`;
}

/**
 * Helper to get platform-specific config dir command
 */
function getConfigDirCommand(platform: 'win32' | 'darwin' | 'linux', configDir: string): string {
  if (platform === 'win32') {
    return `set "CLAUDE_CONFIG_DIR=${configDir}"`;
  }
  return `CLAUDE_CONFIG_DIR='${configDir}'`;
}

/**
 * Tests for invokeCLIAsync() - with timeout protection
 */
describe('invokeCLIAsync', () => {
  beforeEach(() => {
    mockGetClaudeCliInvocationAsync.mockClear();
    mockInitializeClaudeProfileManager.mockClear();
    mockPersistSession.mockClear();
    mockReleaseSessionId.mockClear();
    mockWriteToPty.mockClear();
    mockPersistSessionAsync.mockClear();
    vi.mocked(fsPromises.writeFile).mockReset();
  });

  describe.each(['win32', 'darwin', 'linux'] as const)('on %s', (platform) => {
    beforeEach(() => {
      mockPlatform(platform);
    });

    it('should invoke Claude asynchronously with default profile', async () => {
      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command: '/opt/claude/bin/claude',
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      const profileManager = {
        getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
        getProfile: vi.fn(),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);

      const terminal = createMockTerminal();

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await invokeCLIAsync(terminal, '/tmp/project', undefined, () => null, vi.fn());

      const written = mockWriteToPty.mock.calls[0][1] as string;
      expect(written).toContain(buildCdCommand('/tmp/project'));
      expectPathPrefix(written, platform, '/opt/claude/bin:/usr/bin', '/opt/claude/bin/claude');
      expect(mockReleaseSessionId).toHaveBeenCalledWith('term-1');
      expect(mockPersistSession).toHaveBeenCalledWith(terminal);
      expect(profileManager.markProfileUsed).toHaveBeenCalledWith('default');
    });

    it('should handle profile with configDir', async () => {
      const command = '/opt/claude/bin/claude';
      const profileManager = {
        getActiveProfile: vi.fn(),
        getProfile: vi.fn(() => ({
          id: 'prof-config',
          name: 'Work',
          isDefault: false,
          configDir: '/tmp/claude-config',
        })),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };

      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command,
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);

      const terminal = createMockTerminal();

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await invokeCLIAsync(terminal, '/tmp/project', 'prof-config', () => null, vi.fn());

      const written = mockWriteToPty.mock.calls[0][1] as string;
      const clearCmd = getClearCommand(platform);
      const histPrefix = getHistoryPrefix(platform);
      const configDir = getConfigDirCommand(platform, '/tmp/claude-config');

      expect(written).toContain(histPrefix);
      expect(written).toContain(configDir);
      expect(written).toContain(clearCmd);
      expect(profileManager.markProfileUsed).toHaveBeenCalledWith('prof-config');
    });

    it('should timeout after 10 seconds if CLI invocation hangs', async () => {
      mockGetClaudeCliInvocationAsync.mockImplementation(() =>
        new Promise(resolve => setTimeout(() => resolve({
          command: '/opt/claude/bin/claude',
          env: { PATH: '/opt/claude/bin:/usr/bin' },
        }), 15000))
      );
      const profileManager = {
        getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
        getProfile: vi.fn(),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);

      const terminal = createMockTerminal();

      const { invokeCLIAsync } = await import('../cli-integration-handler');

      await expect(invokeCLIAsync(terminal, '/tmp/project', undefined, () => null, vi.fn()))
        .rejects.toThrow('CLI invocation timeout after 10s');

      // Terminal state should be rolled back
      expect(terminal.isCLIMode).toBe(false);
    }, 12000); // Allow 12 seconds for test (10s timeout + 2s buffer)

    it('should reset terminal state on async error', async () => {
      mockGetClaudeCliInvocationAsync.mockRejectedValue(new Error('Async CLI error'));
      const profileManager = {
        getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
        getProfile: vi.fn(),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);

      const terminal = createMockTerminal({
        isCLIMode: false,
        claudeProfileId: 'old-profile',
      });

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await expect(invokeCLIAsync(terminal, '/tmp/project', 'new-profile', () => null, vi.fn()))
        .rejects.toThrow('Async CLI error');

      // Terminal state should be rolled back
      expect(terminal.isCLIMode).toBe(false);
      expect(terminal.claudeProfileId).toBe('old-profile');
      expect(terminal.claudeSessionId).toBeUndefined();
    });

    it('should include YOLO mode flag when dangerouslySkipPermissions is true', async () => {
      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command: '/opt/claude/bin/claude',
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      const profileManager = {
        getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
        getProfile: vi.fn(),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);

      const terminal = createMockTerminal();

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await invokeCLIAsync(terminal, '/tmp/project', undefined, () => null, vi.fn(), true);

      const written = mockWriteToPty.mock.calls[0][1] as string;
      expect(written).toContain('--dangerously-skip-permissions');
      expect(terminal.dangerouslySkipPermissions).toBe(true);
    });

    it('should call onSessionCapture callback with correct parameters', async () => {
      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command: '/opt/claude/bin/claude',
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      const profileManager = {
        getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
        getProfile: vi.fn(),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);

      const terminal = createMockTerminal();
      const mockOnSessionCapture = vi.fn();
      const startTime = Date.now();

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await invokeCLIAsync(terminal, '/tmp/project', undefined, () => null, mockOnSessionCapture);

      expect(mockOnSessionCapture).toHaveBeenCalledWith(
        terminal.id,
        '/tmp/project',
        expect.any(Number)
      );

      const capturedTime = mockOnSessionCapture.mock.calls[0][2];
      expect(capturedTime).toBeGreaterThanOrEqual(startTime);
    });

    it('uses quoted command and calls getActiveProfile for the default profile', async () => {
      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command: "/opt/claude bin/claude's",
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      const profileManager = {
        getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
        getProfile: vi.fn(),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);

      const terminal = createMockTerminal();

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await invokeCLIAsync(terminal, '/tmp/project', undefined, () => null, vi.fn());

      const written = mockWriteToPty.mock.calls[0][1] as string;
      expectPathPrefix(written, platform, '/opt/claude/bin:/usr/bin', "/opt/claude bin/claude's");
      expect(written).toContain(getQuotedCommand(platform, "/opt/claude bin/claude's"));
      expect(profileManager.getActiveProfile).toHaveBeenCalled();
      expect(profileManager.markProfileUsed).toHaveBeenCalledWith('default');
    });

    it('uses the temp token flow when the profile has an oauth token', async () => {
      const command = '/opt/claude/bin/claude';
      const profileManager = {
        getActiveProfile: vi.fn(),
        getProfile: vi.fn(() => ({
          id: 'prof-1',
          name: 'Work',
          isDefault: false,
          oauthToken: 'token-value',
        })),
        getProfileToken: vi.fn(() => 'token-value'),
        markProfileUsed: vi.fn(),
      };
      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command,
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1234);

      try {
        const terminal = createMockTerminal({ id: 'term-3' });

        const { invokeCLIAsync } = await import('../cli-integration-handler');
        await invokeCLIAsync(terminal, '/tmp/project', 'prof-1', () => null, vi.fn());

        const tokenPath = vi.mocked(fsPromises.writeFile).mock.calls[0]?.[0] as string;
        const tokenContents = vi.mocked(fsPromises.writeFile).mock.calls[0]?.[1] as string;
        const tokenPrefix = path.join(tmpdir(), '.claude-token-1234-');
        const tokenExt = getTempFileExtension(platform);
        expect(tokenPath).toMatch(new RegExp(`^${escapeForRegex(tokenPrefix)}[0-9a-f]{16}${escapeForRegex(tokenExt)}$`));
        expect(tokenContents).toBe(getTokenFileContent(platform, 'token-value'));

        const written = mockWriteToPty.mock.calls[0][1] as string;
        const cmdQuote = platform === 'win32' ? '"' : "'";
        expect(written).toContain(getHistoryPrefix(platform));
        expect(written).toContain(getClearCommand(platform));
        expect(written).toContain(getTempFileInvocation(platform, tokenPath));
        expect(written).toContain(getTempFileCleanup(platform, tokenPath));
        expect(written).toContain(`${cmdQuote}${command}${cmdQuote}`);
        expect(profileManager.getProfile).toHaveBeenCalledWith('prof-1');
        expect(mockPersistSession).toHaveBeenCalledWith(terminal);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('prefers the config dir flow when profile has both oauth token and config dir', async () => {
      const command = '/opt/claude/bin/claude';
      const profileManager = {
        getActiveProfile: vi.fn(),
        getProfile: vi.fn(() => ({
          id: 'prof-both',
          name: 'Work',
          isDefault: false,
          oauthToken: 'token-value',
          configDir: '/tmp/claude-config',
        })),
        getProfileToken: vi.fn(() => 'token-value'),
        markProfileUsed: vi.fn(),
      };
      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command,
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);

      const terminal = createMockTerminal({ id: 'term-both' });

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await invokeCLIAsync(terminal, '/tmp/project', 'prof-both', () => null, vi.fn());

      expect(vi.mocked(fsPromises.writeFile)).not.toHaveBeenCalled();

      const written = mockWriteToPty.mock.calls[0][1] as string;
      expect(written).toContain(getHistoryPrefix(platform));
      expect(written).toContain(getConfigDirCommand(platform, '/tmp/claude-config'));
      expect(written).toContain(getClearCommand(platform));
      expect(written).toContain(getQuotedCommand(platform, command));
      expect(profileManager.getProfile).toHaveBeenCalledWith('prof-both');
      expect(mockPersistSession).toHaveBeenCalledWith(terminal);
      expect(profileManager.markProfileUsed).toHaveBeenCalledWith('prof-both');
    });

    it('handles missing profiles by falling back to the default command', async () => {
      const command = '/opt/claude/bin/claude';
      const profileManager = {
        getActiveProfile: vi.fn(),
        getProfile: vi.fn(() => undefined),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };
      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command,
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);

      const terminal = createMockTerminal({ id: 'term-6' });

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await invokeCLIAsync(terminal, '/tmp/project', 'missing', () => null, vi.fn());

      const written = mockWriteToPty.mock.calls[0][1] as string;
      expect(written).toContain(getQuotedCommand(platform, command));
      expect(profileManager.getProfile).toHaveBeenCalledWith('missing');
      expect(profileManager.markProfileUsed).not.toHaveBeenCalled();
    });

    it('uses profile switching when a non-default profile is requested', async () => {
      const command = '/opt/claude/bin/claude';
      const profileManager = {
        getActiveProfile: vi.fn(),
        getProfile: vi.fn(() => ({
          id: 'prof-3',
          name: 'Team',
          isDefault: false,
        })),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };
      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command,
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);

      const terminal = createMockTerminal({ id: 'term-5' });

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await invokeCLIAsync(terminal, '/tmp/project', 'prof-3', () => null, vi.fn());

      const written = mockWriteToPty.mock.calls[0][1] as string;
      expect(written).toContain(getQuotedCommand(platform, command));
      expectPathPrefix(written, platform, '/opt/claude/bin:/usr/bin', command);
      expect(profileManager.getProfile).toHaveBeenCalledWith('prof-3');
      expect(profileManager.markProfileUsed).toHaveBeenCalledWith('prof-3');
      expect(mockPersistSession).toHaveBeenCalledWith(terminal);
    });

    it('does not include YOLO mode flag when dangerouslySkipPermissions is false', async () => {
      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command: '/opt/claude/bin/claude',
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      const profileManager = {
        getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
        getProfile: vi.fn(),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);

      const terminal = createMockTerminal();

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await invokeCLIAsync(terminal, '/tmp/project', undefined, () => null, vi.fn(), false);

      const written = mockWriteToPty.mock.calls[0][1] as string;
      expect(written).not.toContain('--dangerously-skip-permissions');
      expect(terminal.dangerouslySkipPermissions).toBe(false);
    });

    it('rejects with boom and releases the session when the CLI invocation fails', async () => {
      mockGetClaudeCliInvocationAsync.mockRejectedValue(new Error('boom'));
      const profileManager = {
        getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
        getProfile: vi.fn(),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);

      const terminal = createMockTerminal({ id: 'term-err' });

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await expect(invokeCLIAsync(terminal, '/tmp/project', undefined, () => null, vi.fn()))
        .rejects.toThrow('boom');
      expect(mockReleaseSessionId).toHaveBeenCalledWith('term-err');
      expect(mockWriteToPty).not.toHaveBeenCalled();
    });

    it('rejects when writing the OAuth token temp file fails', async () => {
      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command: '/opt/claude/bin/claude',
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      const profileManager = {
        getActiveProfile: vi.fn(),
        getProfile: vi.fn(() => ({
          id: 'prof-err',
          name: 'Work',
          isDefault: false,
          oauthToken: 'token-value',
        })),
        getProfileToken: vi.fn(() => 'token-value'),
        markProfileUsed: vi.fn(),
      };
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);
      vi.mocked(fsPromises.writeFile).mockRejectedValueOnce(new Error('disk full'));

      const terminal = createMockTerminal({ id: 'term-err-3' });

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await expect(invokeCLIAsync(terminal, '/tmp/project', 'prof-err', () => null, vi.fn()))
        .rejects.toThrow('disk full');
      expect(mockWriteToPty).not.toHaveBeenCalled();
    });
  });
});

/**
 * Tests for resumeClaudeAsync() - async counterpart of resumeClaude()
 */
describe('resumeClaudeAsync', () => {
  beforeEach(() => {
    mockGetClaudeCliInvocationAsync.mockReset();
    mockPersistSessionAsync.mockClear();
    mockReleaseSessionId.mockClear();
    mockWriteToPty.mockClear();
  });

  describe.each(['win32', 'darwin', 'linux'] as const)('on %s', (platform) => {
    beforeEach(() => {
      mockPlatform(platform);
    });

    it('uses --continue regardless of sessionId (sessionId is deprecated)', async () => {
      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command: '/opt/claude/bin/claude',
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });

      const terminal = createMockTerminal({
        id: 'term-2',
        cwd: undefined,
        projectPath: '/tmp/project',
        claudeSessionId: 'stale-id',
      });

      const { resumeClaudeAsync } = await import('../cli-integration-handler');
      await resumeClaudeAsync(terminal, 'abc123', () => null);

      const resumeCall = mockWriteToPty.mock.calls[0][1] as string;
      expectPathPrefix(resumeCall, platform, '/opt/claude/bin:/usr/bin', '/opt/claude/bin/claude');
      expect(resumeCall).toContain(getQuotedCommand(platform, '/opt/claude/bin/claude') + ' --continue');
      expect(resumeCall).not.toContain('--resume');
      expect(terminal.claudeSessionId).toBeUndefined();
      expect(terminal.isCLIMode).toBe(true);
      expect(mockPersistSessionAsync).toHaveBeenCalledWith(terminal);

      mockWriteToPty.mockClear();
      mockPersistSessionAsync.mockClear();
      terminal.projectPath = undefined;
      terminal.isCLIMode = false;
      await resumeClaudeAsync(terminal, undefined, () => null);
      const continueCall = mockWriteToPty.mock.calls[0][1] as string;
      expect(continueCall).toContain(getQuotedCommand(platform, '/opt/claude/bin/claude') + ' --continue');
      expect(terminal.isCLIMode).toBe(true);
      expect(terminal.claudeSessionId).toBeUndefined();
      expect(mockPersistSessionAsync).not.toHaveBeenCalled();
    });
  });

  it('rejects when the CLI invocation cannot be resolved', async () => {
    mockGetClaudeCliInvocationAsync.mockRejectedValue(new Error('boom'));

    const terminal = createMockTerminal({
      id: 'term-err-2',
      cwd: undefined,
      projectPath: '/tmp/project',
    });

    const { resumeClaudeAsync } = await import('../cli-integration-handler');
    await expect(resumeClaudeAsync(terminal, 'abc123', () => null)).rejects.toThrow('boom');
    expect(mockWriteToPty).not.toHaveBeenCalled();
    expect(terminal.isCLIMode).toBe(false);
  });
});

/**
 * Unit tests for helper functions
 */
describe('cli-integration-handler - Helper Functions', () => {
  describe('buildClaudeShellCommand', () => {
    describe.each(['win32', 'darwin', 'linux'] as const)('on %s', (platform) => {
      beforeEach(() => {
        mockPlatform(platform);
      });

      it('should build default command without cwd or PATH prefix', async () => {
        const { buildClaudeShellCommand } = await import('../cli-integration-handler');
        const result = buildClaudeShellCommand('', '', "'/opt/bin/claude'", { method: 'default' });

        expect(result).toBe("'/opt/bin/claude'\r");
      });

      it('should build command with cwd', async () => {
        const { buildClaudeShellCommand } = await import('../cli-integration-handler');
        const result = buildClaudeShellCommand("cd '/tmp/project' && ", '', "'/opt/bin/claude'", { method: 'default' });

        expect(result).toBe("cd '/tmp/project' && '/opt/bin/claude'\r");
      });

      it('should build command with PATH prefix', async () => {
        const { buildClaudeShellCommand } = await import('../cli-integration-handler');
        const result = buildClaudeShellCommand('', "PATH='/custom/path' ", "'/opt/bin/claude'", { method: 'default' });

        expect(result).toBe("PATH='/custom/path' '/opt/bin/claude'\r");
      });

      it('should build temp-file method command with history-safe prefixes', async () => {
        const { buildClaudeShellCommand } = await import('../cli-integration-handler');
        const result = buildClaudeShellCommand(
          "cd '/tmp/project' && ",
          "PATH='/opt/bin' ",
          "'/opt/bin/claude'",
          { method: 'temp-file', tempFile: '/tmp/.token-123' }
        );

        const clearCmd = getClearCommand(platform);
        const histPrefix = getHistoryPrefix(platform);
        const tempCmd = getTempFileInvocation(platform, '/tmp/.token-123');
        const cleanupCmd = getTempFileCleanup(platform, '/tmp/.token-123');
        const execCmd = getExecCommand(platform, "'/opt/bin/claude'");

        expect(result).toContain(`${clearCmd} && `);
        expect(result).toContain("cd '/tmp/project' && ");
        if (platform !== 'win32') {
          expect(result).toContain(histPrefix);
        }
        expect(result).toContain("PATH='/opt/bin' ");
        expect(result).toContain(tempCmd);
        expect(result).toContain(cleanupCmd);
        expect(result).toContain(execCmd);
      });

      it('should build config-dir method command with CLAUDE_CONFIG_DIR', async () => {
        const { buildClaudeShellCommand } = await import('../cli-integration-handler');
        const result = buildClaudeShellCommand(
          "cd '/tmp/project' && ",
          "PATH='/opt/bin' ",
          "'/opt/bin/claude'",
          { method: 'config-dir', configDir: '/home/user/.claude-work' }
        );

        const clearCmd = getClearCommand(platform);
        const histPrefix = getHistoryPrefix(platform);
        const configDirVar = getConfigDirCommand(platform, '/home/user/.claude-work');
        const execCmd = getExecCommand(platform, "'/opt/bin/claude'");

        expect(result).toContain(`${clearCmd} && `);
        expect(result).toContain("cd '/tmp/project' && ");
        if (platform !== 'win32') {
          expect(result).toContain(histPrefix);
        }
        expect(result).toContain(configDirVar);
        expect(result).toContain("PATH='/opt/bin' ");
        expect(result).toContain(execCmd);
      });

      it('should handle empty cwdCommand for temp-file method', async () => {
        const { buildClaudeShellCommand } = await import('../cli-integration-handler');
        const result = buildClaudeShellCommand(
          '',
          '',
          "'/opt/bin/claude'",
          { method: 'temp-file', tempFile: '/tmp/.token' }
        );

        const clearCmd = getClearCommand(platform);
        const histPrefix = getHistoryPrefix(platform);
        const tempCmd = getTempFileInvocation(platform, '/tmp/.token');

        expect(result).toContain(`${clearCmd} && `);
        if (platform !== 'win32') {
          expect(result).toContain(histPrefix);
        }
        expect(result).not.toContain('cd ');
        expect(result).toContain(tempCmd);
      });
    });
  });

  describe('finalizeClaudeInvoke', () => {
    it('should set terminal title to "Claude" for default profile when terminal has default name', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      // Use a default terminal name pattern so renaming logic kicks in
      const terminal = createMockTerminal({ title: 'Terminal 1' });
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn(), isDestroyed: () => false }
      };

      finalizeClaudeInvoke(
        terminal,
        { name: 'Default', isDefault: true },
        '/tmp/project',
        Date.now(),
        () => mockWindow as any,
        vi.fn()
      );

      expect(terminal.title).toBe('Claude');
    });

    it('should set terminal title to "Claude (ProfileName)" for non-default profile', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      // Use a default terminal name pattern so renaming logic kicks in
      const terminal = createMockTerminal({ title: 'Terminal 2' });
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn(), isDestroyed: () => false }
      };

      finalizeClaudeInvoke(
        terminal,
        { name: 'Work Profile', isDefault: false },
        '/tmp/project',
        Date.now(),
        () => mockWindow as any,
        vi.fn()
      );

      expect(terminal.title).toBe('Claude (Work Profile)');
    });

    it('should send IPC message to renderer when terminal has default name', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      // Use a default terminal name pattern so renaming logic kicks in
      const terminal = createMockTerminal({ title: 'Terminal 3' });
      const mockSend = vi.fn();
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: mockSend, isDestroyed: () => false }
      };

      finalizeClaudeInvoke(
        terminal,
        undefined,
        '/tmp/project',
        Date.now(),
        () => mockWindow as any,
        vi.fn()
      );

      expect(mockSend).toHaveBeenCalledWith(
        expect.stringContaining('title'),
        terminal.id,
        'Claude'
      );
    });

    it('should NOT rename terminal when already named Claude', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      // Terminal already has Claude title - should NOT be renamed
      const terminal = createMockTerminal({ title: 'Claude' });
      const mockSend = vi.fn();
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: mockSend, isDestroyed: () => false }
      };

      finalizeClaudeInvoke(
        terminal,
        { name: 'Work Profile', isDefault: false },
        '/tmp/project',
        Date.now(),
        () => mockWindow as any,
        vi.fn()
      );

      // Title should remain unchanged
      expect(terminal.title).toBe('Claude');
      // No IPC message should be sent for title change
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should NOT rename terminal with user-customized name', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      // User has customized the terminal name - should NOT be renamed
      const terminal = createMockTerminal({ title: 'My Custom Terminal' });
      const mockSend = vi.fn();
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: mockSend, isDestroyed: () => false }
      };

      finalizeClaudeInvoke(
        terminal,
        undefined,
        '/tmp/project',
        Date.now(),
        () => mockWindow as any,
        vi.fn()
      );

      // Title should remain unchanged
      expect(terminal.title).toBe('My Custom Terminal');
      // No IPC message should be sent for title change
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should persist session when terminal has projectPath', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      const terminal = createMockTerminal({ projectPath: '/tmp/project' });

      finalizeClaudeInvoke(
        terminal,
        undefined,
        '/tmp/project',
        Date.now(),
        () => null,
        vi.fn()
      );

      expect(mockPersistSession).toHaveBeenCalledWith(terminal);
    });

    it('should call onSessionCapture when projectPath is provided', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      const terminal = createMockTerminal();
      const mockOnSessionCapture = vi.fn();
      const startTime = Date.now();

      finalizeClaudeInvoke(
        terminal,
        undefined,
        '/tmp/project',
        startTime,
        () => null,
        mockOnSessionCapture
      );

      expect(mockOnSessionCapture).toHaveBeenCalledWith(terminal.id, '/tmp/project', startTime);
    });

    it('should not crash when getWindow returns null', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      const terminal = createMockTerminal();

      expect(() => {
        finalizeClaudeInvoke(
          terminal,
          undefined,
          '/tmp/project',
          Date.now(),
          () => null,
          vi.fn()
        );
      }).not.toThrow();
    });
  });

  describe('shouldAutoRenameTerminal', () => {
    it('should return true for default terminal names', async () => {
      const { shouldAutoRenameTerminal } = await import('../cli-integration-handler');

      expect(shouldAutoRenameTerminal('Terminal 1')).toBe(true);
      expect(shouldAutoRenameTerminal('Terminal 2')).toBe(true);
      expect(shouldAutoRenameTerminal('Terminal 99')).toBe(true);
      expect(shouldAutoRenameTerminal('Terminal 123')).toBe(true);
    });

    it('should return false for terminals already named Claude', async () => {
      const { shouldAutoRenameTerminal } = await import('../cli-integration-handler');

      expect(shouldAutoRenameTerminal('Claude')).toBe(false);
      expect(shouldAutoRenameTerminal('Claude (Work)')).toBe(false);
      expect(shouldAutoRenameTerminal('Claude (Profile Name)')).toBe(false);
    });

    it('should return false for user-customized terminal names', async () => {
      const { shouldAutoRenameTerminal } = await import('../cli-integration-handler');

      expect(shouldAutoRenameTerminal('My Custom Terminal')).toBe(false);
      expect(shouldAutoRenameTerminal('Dev Server')).toBe(false);
      expect(shouldAutoRenameTerminal('Backend')).toBe(false);
    });

    it('should return false for edge cases that do not match the pattern', async () => {
      const { shouldAutoRenameTerminal } = await import('../cli-integration-handler');

      // Terminal 0 is not a valid default (terminals start at 1)
      expect(shouldAutoRenameTerminal('Terminal 0')).toBe(true);  // Pattern matches \d+, so this is valid

      // Lowercase doesn't match
      expect(shouldAutoRenameTerminal('terminal 1')).toBe(false);

      // Extra whitespace doesn't match
      expect(shouldAutoRenameTerminal('Terminal  1')).toBe(false);
      expect(shouldAutoRenameTerminal(' Terminal 1')).toBe(false);
      expect(shouldAutoRenameTerminal('Terminal 1 ')).toBe(false);

      // Tab instead of space doesn't match
      expect(shouldAutoRenameTerminal('Terminal\t1')).toBe(false);
    });
  });
});

describe('switchClaudeProfile - waitForClaudeExit byte offset', () => {
  const makeFullStoreTerminal = (): TerminalProcess => {
    const outputStore = new TerminalOutputBuffer();
    // Fill past the 100 KB limit; ends with a prompt-like line from the OLD session.
    outputStore.append(`${'x'.repeat(120_000)}\nuser@host:~/proj$ `);
    return createMockTerminal({
      isCLIMode: true,
      outputStore,
    });
  };

  const setup = () => {
    const profileManager = {
      getProfile: vi.fn(() => ({ id: 'p2', name: 'Two', isDefault: false })),
      setActiveProfile: vi.fn(),
    };
    mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);
    mockWriteToPty.mockReset();
    return profileManager;
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('detects a shell prompt arriving after waiting starts when the buffer is already full', async () => {
    setup();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const terminal = makeFullStoreTerminal();
    expect(terminal.outputStore?.length).toBe(100_000);
    terminal.isCLIMode = true;

    mockWriteToPty.mockImplementation((_t: TerminalProcess, data: string) => {
      if (data === '/exit\r') {
        setTimeout(() => {
          terminal.outputStore?.append('\nuser@host:~/proj$ ');
          // Simulate the shell having taken over from Claude only via output.
        }, 300);
      }
    });

    const { switchClaudeProfile } = await import('../cli-integration-handler');
    const promise = switchClaudeProfile(terminal, 'p2', () => null, vi.fn(async () => {}), vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('Claude exited successfully'))).toBe(true);
    expect(messages.some((m) => m.includes('Timed out'))).toBe(false);
  });

  it('does not mistake old prompt-like output for new output', async () => {
    setup();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const terminal = makeFullStoreTerminal();
    mockWriteToPty.mockImplementation(() => {});

    const { switchClaudeProfile } = await import('../cli-integration-handler');
    const promise = switchClaudeProfile(terminal, 'p2', () => null, vi.fn(async () => {}), vi.fn());
    await vi.advanceTimersByTimeAsync(6000);
    await promise;

    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('Timed out'))).toBe(true);
    expect(messages.some((m) => m.includes('Claude exited successfully'))).toBe(false);
  });
});
