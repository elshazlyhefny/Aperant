import { EventEmitter } from 'node:events';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { bashTool } from '../bash';
import type { ToolContext } from '../../types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const mockIsWindows = vi.fn(() => false);
const mockFindExecutable = vi.fn(() => null);
const mockKillProcessGracefully = vi.fn();

vi.mock('../../../../platform/index', () => ({
  isWindows: () => mockIsWindows(),
  findExecutable: (_name: string, _additionalPaths?: string[]) => mockFindExecutable(),
  killProcessGracefully: (_childProcess: unknown, _options?: unknown) => mockKillProcessGracefully(),
}));

const mockBashSecurityHook = vi.fn(() => ({}));
vi.mock('../../../security/bash-validator', () => ({
  bashSecurityHook: (_input: unknown, _profile?: unknown) => mockBashSecurityHook(),
}));

const mockWrapForSandbox = vi.fn();
vi.mock('../../../security/sandbox', () => ({
  parseSandboxMode: (v: unknown) =>
    v === 'home-hidden' || v === 'home-hidden-no-network' ? v : 'off',
  wrapForSandbox: (...args: unknown[]) => mockWrapForSandbox(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseContext: ToolContext = {
  cwd: '/test/project',
  projectDir: '/test/project',
  specDir: '/test/specs/001',
  securityProfile: {
    baseCommands: new Set(),
    stackCommands: new Set(),
    scriptCommands: new Set(),
    customCommands: new Set(),
    customScripts: { shellScripts: [] },
    getAllAllowedCommands: () => new Set(),
  },
} as unknown as ToolContext;

/**
 * A fake child process: stdout/stderr streams plus exit events.
 */
function fakeChild(pid = 1234) {
  const child = Object.assign(new EventEmitter(), {
    pid,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  return child;
}

/**
 * Set up mockSpawn to return a child that writes the provided output, then exits.
 */
function setupSpawn(stdout: string, stderr: string, exitCode: number) {
  mockSpawn.mockImplementation(() => {
    const child = fakeChild();
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', exitCode);
    });
    return child;
  });
}

/**
 * Set up mockSpawn to return a child that never exits (background runs).
 */
function setupIdleSpawn() {
  mockSpawn.mockImplementation(() => fakeChild(5678));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Bash Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsWindows.mockReturnValue(false);
    mockBashSecurityHook.mockReturnValue({});
  });

  it('should have correct metadata', () => {
    expect(bashTool.metadata.name).toBe('Bash');
    expect(bashTool.metadata.permission).toBe('requires_approval');
  });

  it('should return stdout from successful command', async () => {
    setupSpawn('hello from bash\n', '', 0);

    const result = await bashTool.config.execute(
      { command: 'echo hello from bash' },
      baseContext,
    );

    expect(result).toContain('hello from bash');
  });

  it('should include stderr in output when present', async () => {
    setupSpawn('', 'some warning\n', 0);

    const result = await bashTool.config.execute(
      { command: 'cmd-with-stderr' },
      baseContext,
    );

    expect(result).toContain('STDERR:');
    expect(result).toContain('some warning');
  });

  it('should include exit code in output when non-zero', async () => {
    setupSpawn('', '', 1);

    const result = await bashTool.config.execute(
      { command: 'failing-command' },
      baseContext,
    );

    expect(result).toContain('Exit code: 1');
  });

  it('should return (no output) when stdout and stderr are empty and exit code is 0', async () => {
    setupSpawn('', '', 0);

    const result = await bashTool.config.execute(
      { command: 'silent-command' },
      baseContext,
    );

    expect(result).toBe('(no output)');
  });

  it('should truncate output exceeding MAX_OUTPUT_LENGTH', async () => {
    const longOutput = 'x'.repeat(31_000);
    setupSpawn(longOutput, '', 0);

    const result = await bashTool.config.execute(
      { command: 'long-output-cmd' },
      baseContext,
    );

    expect(result).toContain('[Output truncated');
    expect(result.length).toBeLessThan(longOutput.length);
  });

  it('should return error message when security hook rejects command', async () => {
    mockBashSecurityHook.mockReturnValue({
      hookSpecificOutput: {
        permissionDecisionReason: 'command is blocked for safety',
      },
    });

    const result = await bashTool.config.execute(
      { command: 'rm -rf /' },
      baseContext,
    );

    expect(result).toContain('Error: Command not allowed');
    expect(result).toContain('command is blocked for safety');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('should start command in background and return immediately', async () => {
    // In background mode the execute call is fire-and-forget, so mockSpawn
    // may or may not be called synchronously. The return value is what matters.
    setupIdleSpawn();

    const result = await bashTool.config.execute(
      { command: 'sleep 100', run_in_background: true },
      baseContext,
    );

    expect(result).toContain('Command started in background');
    expect(result).toContain('sleep 100');
  });

  it('should pass cwd from context to spawn', async () => {
    setupSpawn('output', '', 0);

    await bashTool.config.execute(
      { command: 'pwd' },
      baseContext,
    );

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ cwd: '/test/project' }),
    );
  });

  it('should cap timeout to MAX_TIMEOUT_MS (600000) and kill the command then', async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      child.kill.mockImplementation(() => child.emit('close', null));
      mockSpawn.mockReturnValue(child);

      const pending = bashTool.config.execute(
        { command: 'cmd', timeout: 9_000_000 },
        baseContext,
      );

      vi.advanceTimersByTime(599_999);
      expect(child.kill).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(await pending).toContain('Exit code: 1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('kills the command and reports failure when output exceeds 10MB', async () => {
    const child = fakeChild();
    child.kill.mockImplementation(() => child.emit('close', null));
    mockSpawn.mockReturnValue(child);

    const pending = bashTool.config.execute({ command: 'yes' }, baseContext);
    child.stdout.emit('data', Buffer.alloc(10 * 1024 * 1024 + 1, 'y'));

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(await pending).toContain('Exit code: 1');
  });

  it('reports failure when the shell cannot be started', async () => {
    const child = fakeChild();
    mockSpawn.mockReturnValue(child);

    const pending = bashTool.config.execute({ command: 'x' }, baseContext);
    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));

    expect(await pending).toBe('Exit code: 1');
  });

  it('runs each command in its own process group on non-Windows', async () => {
    mockIsWindows.mockReturnValue(false);
    setupSpawn('output', '', 0);

    await bashTool.config.execute({ command: 'echo hi' }, baseContext);

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ detached: true }),
    );
  });

  it('does not detach on Windows, where it would open a console window', async () => {
    mockIsWindows.mockReturnValue(true);
    mockFindExecutable.mockReturnValue(null);
    setupSpawn('output', '', 0);

    await bashTool.config.execute({ command: 'dir' }, baseContext);

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ detached: false }),
    );
  });

  it('should use /bin/bash as shell on non-Windows', async () => {
    mockIsWindows.mockReturnValue(false);
    setupSpawn('output', '', 0);

    await bashTool.config.execute(
      { command: 'echo hi' },
      baseContext,
    );

    expect(mockSpawn).toHaveBeenCalledWith(
      '/bin/bash',
      ['-c', 'echo hi'],
      expect.any(Object),
    );
  });

  it('should use cmd.exe args (/c) on Windows when bash not found', async () => {
    // The Windows branch uses /c rather than -c for cmd.exe.
    // We verify the logic by checking that bash uses -c on non-Windows (already tested
    // above) and that the findExecutable mock would select the right executable.
    // This test validates the cmd.exe ComSpec fallback resolution path.
    mockIsWindows.mockReturnValue(true);
    mockFindExecutable.mockReturnValue(null);

    const origComSpec = process.env.ComSpec;
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';

    setupSpawn('output', '', 0);

    await bashTool.config.execute(
      { command: 'dir' },
      baseContext,
    );

    // Verify that on Windows with no bash found, cmd.exe with /c flag is used
    const callArgs = mockSpawn.mock.calls[0];
    const shell = callArgs[0] as string;
    const args = callArgs[1] as string[];

    // The shell should be cmd.exe (via ComSpec) and arg should be /c
    expect(shell).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(args[0]).toBe('/c');
    expect(args[1]).toBe('dir');

    process.env.ComSpec = origComSpec;
  });

  describe('child environment scrubbing', () => {
    const saved = { ...process.env };

    beforeEach(() => {
      process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';
      process.env.GITHUB_TOKEN = 'gh-secret';
      process.env.MY_API_KEY = 'key-secret';
      process.env.PATH = process.env.PATH || '/usr/bin';
    });

    afterEach(() => {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, saved);
    });

    it('removes credential variables and keeps PATH', async () => {
      setupSpawn('ok', '', 0);
      await bashTool.config.execute({ command: 'env' }, baseContext);
      const opts = mockSpawn.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(opts.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(opts.env.GITHUB_TOKEN).toBeUndefined();
      expect(opts.env.MY_API_KEY).toBeUndefined();
      expect(opts.env.PATH).toBe(process.env.PATH);
    });

    it('keeps names listed in securityProfile.envPassthrough', async () => {
      setupSpawn('ok', '', 0);
      const ctx = {
        ...baseContext,
        securityProfile: { ...baseContext.securityProfile, envPassthrough: ['MY_API_KEY'] },
      } as unknown as ToolContext;
      await bashTool.config.execute({ command: 'env' }, ctx);
      const opts = mockSpawn.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(opts.env.MY_API_KEY).toBe('key-secret');
      expect(opts.env.GITHUB_TOKEN).toBeUndefined();
    });

    it('scrubs background runs too', async () => {
      setupIdleSpawn();
      await bashTool.config.execute({ command: 'sleep 1', run_in_background: true }, baseContext);
      const opts = mockSpawn.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(opts.env.GITHUB_TOKEN).toBeUndefined();
    });
  });

  describe('sandbox', () => {
    const sandboxCtx = {
      ...baseContext,
      securityProfile: { ...baseContext.securityProfile, bashSandbox: 'home-hidden' },
    } as unknown as ToolContext;

    it('runs the wrapped file and args when the sandbox is available', async () => {
      mockWrapForSandbox.mockReturnValue({ ok: true, file: '/usr/bin/bwrap', args: ['--x', '--', '/bin/bash', '-c', 'ls'] });
      setupSpawn('ok', '', 0);
      await bashTool.config.execute({ command: 'ls' }, sandboxCtx);
      expect(mockWrapForSandbox).toHaveBeenCalledWith(
        '/bin/bash',
        ['-c', 'ls'],
        expect.objectContaining({ mode: 'home-hidden', cwd: '/test/project', projectDir: '/test/project', writablePaths: ['/test/specs/001'] }),
      );
      expect(mockSpawn).toHaveBeenCalledWith(
        '/usr/bin/bwrap',
        ['--x', '--', '/bin/bash', '-c', 'ls'],
        expect.any(Object),
      );
    });

    it('refuses to run when the sandbox is unavailable', async () => {
      mockWrapForSandbox.mockReturnValue({ ok: false, reason: 'bwrap missing' });
      const result = await bashTool.config.execute({ command: 'ls' }, sandboxCtx);
      expect(result).toContain('Sandbox unavailable');
      expect(result).toContain('bwrap missing');
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('fails closed for background runs too', async () => {
      mockWrapForSandbox.mockReturnValue({ ok: false, reason: 'bwrap missing' });
      const result = await bashTool.config.execute({ command: 'ls', run_in_background: true }, sandboxCtx);
      expect(result).toContain('Sandbox unavailable');
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('fails closed on Windows when the sandbox is unavailable', async () => {
      mockIsWindows.mockReturnValue(true);
      mockFindExecutable.mockReturnValue('C:\\Program Files\\Git\\bin\\bash.exe' as never);
      mockWrapForSandbox.mockReturnValue({ ok: false, reason: 'PowerShell launcher missing' });
      const result = await bashTool.config.execute({ command: 'dir' }, sandboxCtx);
      expect(result).toContain('Error: Sandbox unavailable');
      expect(result).toContain('PowerShell launcher missing');
      expect(mockWrapForSandbox).toHaveBeenCalledWith(
        'C:\\Program Files\\Git\\bin\\bash.exe',
        ['-c', 'dir'],
        expect.objectContaining({ mode: 'home-hidden' }),
      );
      expect(mockSpawn).not.toHaveBeenCalled();
      mockFindExecutable.mockReturnValue(null);
    });

    it('does not call the wrapper when mode is off', async () => {
      setupSpawn('ok', '', 0);
      await bashTool.config.execute({ command: 'ls' }, baseContext);
      expect(mockWrapForSandbox).not.toHaveBeenCalled();
    });
  });
});
