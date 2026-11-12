import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { openInTerminal } from '../tool-detection/launch';
import { launchTerminal } from '../tool-detection/terminal-launch';
import { SPAWN_WAIT_MS } from '../tool-detection/terminal-launch/spawn';

vi.mock('electron', () => ({
  shell: { openPath: vi.fn() },
  app: { getPath: () => '/tmp', isPackaged: false, on: vi.fn() },
}));

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
  existsSync: vi.fn(),
  os: { current: 'linux' },
}));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFile: mocks.execFile, spawn: mocks.spawn };
});
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: mocks.existsSync };
});
vi.mock('../../../platform', () => ({ getCurrentOS: () => mocks.os.current }));

/** Make execFile succeed. */
function stubExecFile() {
  mocks.execFile.mockImplementation((_cmd: string, _args: string[], cb: Function) => {
    cb(null, { stdout: '', stderr: '' });
  });
}

/** Spawn stub for detached launchers (darwin/linux): fails with ENOENT for `failing` commands. */
function stubSpawn(failing: string[] = []) {
  mocks.spawn.mockImplementation((cmd: string) => {
    const child = {
      unref: vi.fn(),
      once: (event: string, cb: (err?: Error) => void) => {
        if (event === 'error' && failing.includes(cmd)) queueMicrotask(() => cb(new Error(`${cmd} not found`)));
        if (event === 'spawn' && !failing.includes(cmd)) queueMicrotask(() => cb());
        return child;
      },
      on: vi.fn(),
    };
    return child;
  });
}

/** Spawn stub for Windows launchers: captures the 'error' listener so tests can emit it. */
const winChild = { handlers: {} as Record<string, (err: Error) => void> };
function stubWinSpawn() {
  winChild.handlers = {};
  mocks.spawn.mockImplementation(() => {
    const child = {
      unref: vi.fn(),
      once: vi.fn(),
      on: (event: string, cb: (err: Error) => void) => {
        winChild.handlers[event] = cb;
        return child;
      },
      removeListener: vi.fn(),
    };
    return child;
  });
}

const spawnCall = () => mocks.spawn.mock.calls[0] as [string, string[], Record<string, unknown>];
const osascriptScript = () => (mocks.execFile.mock.calls[0][1] as string[])[1];

/** Run a Windows launch, letting the SPAWN_WAIT_MS timer elapse. */
async function launchWin(opts: Parameters<typeof launchTerminal>[0]) {
  const p = launchTerminal(opts);
  await vi.advanceTimersByTimeAsync(SPAWN_WAIT_MS);
  return p;
}

beforeEach(() => {
  mocks.execFile.mockReset();
  mocks.spawn.mockReset();
  mocks.existsSync.mockReset();
  mocks.existsSync.mockReturnValue(false);
  stubExecFile();
  stubSpawn();
  mocks.os.current = 'linux';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('launchTerminal on macOS', () => {
  beforeEach(() => {
    mocks.os.current = 'darwin';
  });

  it('iterm2 uses a running-check script (single window) for commands', async () => {
    await launchTerminal({ terminal: 'iterm2', command: 'echo hi' });
    expect(mocks.execFile.mock.calls[0][0]).toBe('osascript');
    const script = osascriptScript();
    expect(script).toContain('if application "iTerm" is running then');
    expect(script).toContain('else');
    expect(script).toContain('write text "echo hi"');
  });

  it('iterm2 uses the same script for cwd launches', async () => {
    await launchTerminal({ terminal: 'iterm2', cwd: '/work/tree' });
    expect(osascriptScript()).toContain('if application "iTerm" is running then');
    expect(osascriptScript()).toContain(`write text "cd '/work/tree'"`);
  });

  it('openInTerminal(..., iterm2) shares the running-check script', async () => {
    const result = await openInTerminal('/work/tree', 'iterm2');
    expect(result).toEqual({ success: true });
    expect(osascriptScript()).toContain('if application "iTerm" is running then');
  });

  it.each([
    ['warp', 'Warp', '0.5'],
    ['ghostty', 'Ghostty', '0.3'],
    ['hyper', 'Hyper', '0.3'],
    ['tabby', 'Tabby', '0.3'],
  ])('%s types the command via System Events', async (terminal, app, delay) => {
    await launchTerminal({ terminal, command: 'npm i', cwd: '/p' });
    const script = osascriptScript();
    expect(script).toContain(`tell application "${app}"`);
    expect(script).toContain(`delay ${delay}`);
    expect(script).toContain(`keystroke "cd '/p' && npm i"`);
    expect(script).toContain('keystroke return');
  });

  it.each([
    ['kitty', 'kitty', ['--', 'bash', '-c', 'echo hi']],
    ['wezterm', 'wezterm', ['start', '--', 'bash', '-c', 'echo hi']],
    ['alacritty', 'open', ['-a', 'Alacritty', '--args', '-e', 'bash', '-c', 'echo hi']],
  ])('%s spawns the expected argv for a command', async (terminal, cmd, args) => {
    await launchTerminal({ terminal, command: 'echo hi' });
    const [c, a, opts] = spawnCall();
    expect(c).toBe(cmd);
    expect(a).toEqual(args);
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });
  });

  it('Terminal.app runs "do script" before "activate"', async () => {
    await launchTerminal({ terminal: 'terminal', command: 'echo hi' });
    const script = osascriptScript();
    expect(script).toContain('do script "echo hi"');
    expect(script.indexOf('do script')).toBeLessThan(script.indexOf('activate'));
  });

  it('unknown terminals fall back to Terminal.app', async () => {
    await launchTerminal({ terminal: 'nonexistent', command: 'echo hi' });
    expect(osascriptScript()).toContain('tell application "Terminal"');
  });

  it('escapes quotes and backslashes for AppleScript', async () => {
    await launchTerminal({ terminal: 'terminal', command: 'echo "a" `b` $c \\d' });
    expect(osascriptScript()).toContain('do script "echo \\"a\\" `b` $c \\\\d"');
  });

  it('escapes single quotes in cwd for the shell line', async () => {
    await launchTerminal({ terminal: 'terminal', cwd: "/tmp/it's", command: 'ls' });
    expect(osascriptScript()).toContain(`cd '/tmp/it'\\\\''s' && ls`);
  });
});

describe('launchTerminal on Windows', () => {
  beforeEach(() => {
    mocks.os.current = 'win32';
    vi.useFakeTimers();
    stubWinSpawn();
  });

  it('spawns detached with stdio ignore and windowsHide false, resolving after SPAWN_WAIT_MS', async () => {
    let resolved = false;
    const p = launchTerminal({ terminal: 'powershell', command: 'echo hi' }).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(SPAWN_WAIT_MS - 1);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(resolved).toBe(true);
    expect(spawnCall()[2]).toEqual({ detached: true, stdio: 'ignore', windowsHide: false });
  });

  it('wraps spawn errors as "Failed to open terminal"', async () => {
    const p = launchTerminal({ terminal: 'powershell', command: 'echo hi' });
    const assertion = expect(p).rejects.toThrow('Failed to open terminal: boom');
    winChild.handlers.error(new Error('boom'));
    await assertion;
  });

  it.each([
    ['windowsterminal', 'wt', ['new-tab', 'powershell', '-NoExit', '-Command', 'echo hi']],
    ['powershell', 'powershell', ['-NoExit', '-Command', 'echo hi']],
    ['system', 'powershell', ['-NoExit', '-Command', 'echo hi']],
    ['unknown', 'powershell', ['-NoExit', '-Command', 'echo hi']],
    ['alacritty', 'alacritty', ['-e', 'powershell', '-NoExit', '-Command', 'echo hi']],
    ['wezterm', 'wezterm', ['start', '--', 'powershell', '-NoExit', '-Command', 'echo hi']],
  ])('%s runs the command via argv', async (terminal, cmd, args) => {
    await launchWin({ terminal, command: 'echo hi' });
    expect(spawnCall()[0]).toBe(cmd);
    expect(spawnCall()[1]).toEqual(args);
  });

  it('cmd wraps PowerShell with /k', async () => {
    await launchWin({ terminal: 'cmd', command: 'echo hi' });
    expect(spawnCall()[1]).toEqual(['/k', 'powershell', '-NoExit', '-Command', 'echo hi']);
  });

  it('cwd launches prepend Set-Location (escaped) to the PowerShell command', async () => {
    await launchWin({ terminal: 'powershell', command: 'echo hi', cwd: "C:\\it's" });
    expect(spawnCall()[1][2]).toBe("Set-Location -LiteralPath 'C:\\it''s'`; echo hi");
  });

  it('gitbash runs through git-bash.exe when found', async () => {
    mocks.existsSync.mockImplementation((p: string) => p === 'C:\\Program Files\\Git\\git-bash.exe');
    await launchWin({ terminal: 'gitbash', command: 'echo hi' });
    expect(spawnCall()[0]).toBe('C:\\Program Files\\Git\\git-bash.exe');
    expect(spawnCall()[1]).toEqual(['-c', 'echo hi']);
  });

  it('gitbash rejects with "Git Bash not found" when missing', async () => {
    const p = launchTerminal({ terminal: 'gitbash', command: 'echo hi' });
    await expect(p).rejects.toThrow('Failed to open terminal: Git Bash not found');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each([
    ['conemu', 'C:\\Program Files\\ConEmu\\ConEmu64.exe', ['-run', 'powershell -NoExit -Command echo hi']],
    ['cmder', 'C:\\cmder\\Cmder.exe', ['/SINGLE', '/START', '', '/TASK', 'powershell -NoExit -Command echo hi']],
    ['cygwin', 'C:\\cygwin64\\bin\\mintty.exe', ['-e', '/bin/bash', '-lc', 'echo hi']],
    ['msys2', 'C:\\msys64\\msys2_shell.cmd', ['-mingw64', '-c', 'echo hi']],
  ])('%s uses its executable when found', async (terminal, exe, args) => {
    mocks.existsSync.mockImplementation((p: string) => p === exe);
    await launchWin({ terminal, command: 'echo hi' });
    expect(spawnCall()[0]).toBe(exe);
    expect(spawnCall()[1]).toEqual(args);
  });

  it.each(['conemu', 'cmder', 'hyper', 'tabby', 'cygwin', 'msys2'])(
    '%s falls back to PowerShell when not installed',
    async (terminal) => {
      vi.spyOn(console, 'warn').mockReturnValue(undefined);
      await launchWin({ terminal, command: 'echo hi' });
      expect(spawnCall()[0]).toBe('powershell');
      expect(spawnCall()[1]).toEqual(['-NoExit', '-Command', 'echo hi']);
    },
  );

  it.each(['hyper', 'tabby'])('%s opens without args when found', async (terminal) => {
    mocks.existsSync.mockImplementation((p: string) => p.endsWith(`${terminal === 'hyper' ? 'Hyper' : 'Tabby'}.exe`));
    await launchWin({ terminal, command: 'echo hi' });
    expect(spawnCall()[1]).toEqual([]);
  });

  it('escapes backticks, quotes and $ for PowerShell', async () => {
    await launchWin({ terminal: 'powershell', command: 'echo "a" `b` $c' });
    expect(spawnCall()[1][2]).toBe('echo `"a`" ``b`` `$c');
  });

  it('escapes backticks, quotes and $ for Git Bash', async () => {
    mocks.existsSync.mockImplementation((p: string) => p === 'C:\\Program Files\\Git\\git-bash.exe');
    await launchWin({ terminal: 'gitbash', command: 'echo "a" `b` $c' });
    expect(spawnCall()[1][1]).toBe('echo \\"a\\" \\`b\\` \\$c');
  });
});

describe('launchTerminal on Linux', () => {
  it.each([
    ['gnometerminal', 'gnome-terminal', ['--', 'bash', '-c', 'echo hi; exec bash']],
    ['konsole', 'konsole', ['-e', 'bash', '-c', 'echo hi; exec bash']],
    ['xfce4terminal', 'xfce4-terminal', ['-e', 'bash -c "echo hi; exec bash"']],
    ['lxterminal', 'lxterminal', ['-e', 'bash -c "echo hi; exec bash"']],
    ['mate-terminal', 'mate-terminal', ['-e', 'bash -c "echo hi; exec bash"']],
    ['tilix', 'tilix', ['-e', 'bash', '-c', 'echo hi; exec bash']],
    ['terminator', 'terminator', ['-e', 'bash -c "echo hi; exec bash"']],
    ['guake', 'guake', ['-e', 'echo hi; exec bash']],
    ['yakuake', 'yakuake', ['-e', 'echo hi; exec bash']],
    ['kitty', 'kitty', ['--', 'bash', '-c', 'echo hi; exec bash']],
    ['alacritty', 'alacritty', ['-e', 'bash', '-c', 'echo hi; exec bash']],
    ['wezterm', 'wezterm', ['start', '--', 'bash', '-c', 'echo hi; exec bash']],
    ['hyper', 'hyper', []],
    ['tabby', 'tabby', []],
    ['xterm', 'xterm', ['-e', 'bash', '-c', 'echo hi; exec bash']],
    ['urxvt', 'urxvt', ['-e', 'bash', '-c', 'echo hi; exec bash']],
    ['st', 'st', ['-e', 'bash', '-c', 'echo hi; exec bash']],
    ['foot', 'foot', ['bash', '-c', 'echo hi; exec bash']],
  ])('%s runs a command with the exec bash suffix', async (terminal, cmd, args) => {
    await launchTerminal({ terminal, command: 'echo hi' });
    const [c, a, opts] = spawnCall();
    expect(c).toBe(cmd);
    expect(a).toEqual(args);
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });
  });

  it('prepends cd for a cwd + command launch', async () => {
    await launchTerminal({ terminal: 'konsole', cwd: '/w', command: 'ls' });
    expect(spawnCall()[1]).toEqual(['-e', 'bash', '-c', "cd '/w' && ls; exec bash"]);
  });

  it('auto-detects in order, skipping terminals that fail to spawn', async () => {
    stubSpawn(['gnome-terminal', 'konsole', 'xfce4-terminal']);
    await launchTerminal({ terminal: 'system', command: 'echo hi' });
    expect(mocks.spawn.mock.calls.map((c) => c[0])).toEqual(['gnome-terminal', 'konsole', 'xfce4-terminal', 'tilix']);
  });

  it('auto-detect order is gnome-terminal first', async () => {
    await launchTerminal({ terminal: undefined, command: 'echo hi' });
    expect(spawnCall()[0]).toBe('gnome-terminal');
    expect(spawnCall()[1]).toEqual(['--', 'bash', '-c', 'echo hi; exec bash']);
  });

  it('throws "No supported terminal emulator found" when nothing spawns', async () => {
    stubSpawn(['gnome-terminal', 'konsole', 'xfce4-terminal', 'tilix', 'terminator', 'kitty', 'alacritty', 'xterm']);
    await expect(launchTerminal({ terminal: 'system', command: 'echo hi' })).rejects.toThrow(
      'No supported terminal emulator found',
    );
  });

  it('keeps the injected cwd quote escaped in the bash line', async () => {
    await launchTerminal({ terminal: 'konsole', cwd: "/t'; touch x; '", command: 'ls' });
    expect(spawnCall()[1][3]).toBe("cd '/t'\\''; touch x; '\\''' && ls; exec bash");
  });
});
