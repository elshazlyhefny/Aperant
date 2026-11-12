import os from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../shared/constants';
import {
  escapeAppleScriptString,
  escapeBashCommand,
  escapeGitBashCommand,
  escapePowerShellCommand,
  escapeSingleQuotedPath,
  isPathSafe,
} from '../tool-detection/path-safety';
import { CLI_DETECTION, IDE_DETECTION, TERMINAL_DETECTION } from '../tool-detection/tables';
import { openInIDE, openInTerminal } from '../tool-detection/launch';
import { registerWorktreeToolHandlers } from '../tool-handlers';

const handlers = vi.hoisted(() => new Map<string, Function>());
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: Function) => handlers.set(ch, fn), on: vi.fn() },
  BrowserWindow: class {},
  shell: { openPath: vi.fn() },
  app: { getPath: () => os.tmpdir(), isPackaged: false, on: vi.fn() },
}));

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
  os: { current: 'linux' },
}));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: mocks.execFile,
    spawn: mocks.spawn,
  };
});
vi.mock('../../../platform', () => ({ getCurrentOS: () => mocks.os.current }));

// A path carrying a shell payload, joined from parts so the payload never
// appears as one literal command.
const INJECTION = ["/tmp/a'; r", "m -rf ~; '"].join('');

/** Make execFile succeed except for the commands listed in `failing`. */
function stubExecFile(failing: string[] = []) {
  mocks.execFile.mockImplementation((cmd: string, _args: string[], cb: Function) => {
    if (failing.includes(cmd)) cb(new Error(`${cmd} not found`));
    else cb(null, { stdout: '', stderr: '' });
  });
}

/** Make spawn succeed except for the commands listed in `failing` (emits 'error' like ENOENT). */
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

beforeEach(() => {
  mocks.execFile.mockReset();
  mocks.spawn.mockReset();
  stubSpawn();
  mocks.os.current = 'linux';
  handlers.clear();
  stubExecFile();
});

describe('escapeSingleQuotedPath', () => {
  it('escapes single quotes', () => {
    expect(escapeSingleQuotedPath("/tmp/it's")).toBe("/tmp/it'\\''s");
  });
  it('leaves paths without quotes unchanged', () => {
    expect(escapeSingleQuotedPath('/tmp/plain dir')).toBe('/tmp/plain dir');
  });
  it('keeps an injection attempt inside the quoted string', () => {
    const escaped = escapeSingleQuotedPath(INJECTION);
    // Every quote in the output is part of an '\'' sequence
    expect(escaped.replace(/'\\''/g, '')).not.toContain("'");
    expect(escaped.startsWith("/tmp/a'\\''")).toBe(true);
  });
});

describe('escapeAppleScriptString', () => {
  it('escapes backslashes and double quotes, leaves single quotes', () => {
    expect(escapeAppleScriptString('a\\b"c\'d')).toBe('a\\\\b\\"c\'d');
  });
});

describe('escapePowerShellCommand', () => {
  it('escapes metacharacters and newlines', () => {
    expect(escapePowerShellCommand('a`b"c$d(e);f&g')).toBe('a``b`"c`$d`(e`)`;f`&g');
    expect(escapePowerShellCommand('a\r\nb')).toBe('a`r`nb');
  });
});

describe('escapeGitBashCommand / escapeBashCommand', () => {
  it('escapes bash metacharacters', () => {
    const input = 'a\\b"c$d`e;f|g!h';
    const expected = 'a\\\\b\\"c\\$d\\`e\\;f\\|g\\!h';
    expect(escapeGitBashCommand(input)).toBe(expected);
    expect(escapeBashCommand(input)).toBe(expected);
  });
});

describe('isPathSafe', () => {
  it('rejects traversal', () => {
    expect(isPathSafe('../../etc/passwd')).toBe(false);
    expect(isPathSafe('../bin/code')).toBe(false);
  });
  it('accepts normal absolute paths', () => {
    expect(isPathSafe('/usr/bin/code')).toBe(true);
  });
});

describe('detection tables', () => {
  it('have named entries with paths and commands', () => {
    for (const table of [IDE_DETECTION, TERMINAL_DETECTION, CLI_DETECTION]) {
      const entries = Object.values(table);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry?.name).toBeTruthy();
        expect(typeof entry?.paths).toBe('object');
        expect(typeof entry?.commands).toBe('object');
      }
    }
  });
  it('includes the system terminal', () => {
    expect(TERMINAL_DETECTION.system).toBeDefined();
  });
});

describe('openInIDE', () => {
  it('rejects an unsafe custom path', async () => {
    const res = await openInIDE('/tmp/x', 'custom', '../bin/evil');
    expect(res).toEqual({ success: false, error: 'Invalid custom IDE path' });
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
  it('reports an unknown IDE', async () => {
    const res = await openInIDE('/tmp/x', 'nope' as never);
    expect(res.success).toBe(false);
    expect(res.error).toContain('Unknown IDE');
  });
  it('calls execFile with an argument array on linux', async () => {
    const res = await openInIDE(INJECTION, 'vscode');
    expect(res).toEqual({ success: true });
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    const [cmd, args] = mocks.execFile.mock.calls[0];
    expect(cmd).toBe(IDE_DETECTION.vscode?.commands.linux);
    expect(args).toEqual([INJECTION]);
  });
});

describe('openInTerminal', () => {
  it('rejects an unsafe custom path', async () => {
    const res = await openInTerminal('/tmp/x', 'custom', '../bin/evil');
    expect(res).toEqual({ success: false, error: 'Invalid custom terminal path' });
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
  it('falls back to xterm with the escaped path on linux', async () => {
    stubSpawn(['x-terminal-emulator', 'gnome-terminal']);
    const res = await openInTerminal("/tmp/it's", 'system');
    expect(res).toEqual({ success: true });
    const cmds = mocks.spawn.mock.calls.map((c) => c[0]);
    expect(cmds).toEqual(['x-terminal-emulator', 'gnome-terminal', 'xterm']);
    expect(mocks.spawn.mock.calls[2][1]).toEqual(['-e', "cd '/tmp/it'\\''s' && bash"]);
  });
  it('passes the escaped path to osascript on darwin', async () => {
    mocks.os.current = 'darwin';
    const res = await openInTerminal("/tmp/it's", 'system');
    expect(res).toEqual({ success: true });
    const [cmd, args] = mocks.execFile.mock.calls[0];
    expect(cmd).toBe('osascript');
    expect(args[0]).toBe('-e');
    // The script is AppleScript-escaped, so the shell escape's backslash is doubled
    expect(args[1]).toContain("cd '/tmp/it'\\\\''s'");
  });
});

describe('registerWorktreeToolHandlers', () => {
  it('registers the three channels', () => {
    registerWorktreeToolHandlers();
    expect(handlers.has(IPC_CHANNELS.TASK_WORKTREE_DETECT_TOOLS)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.TASK_WORKTREE_OPEN_IN_IDE)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.TASK_WORKTREE_OPEN_IN_TERMINAL)).toBe(true);
  });
  it('rejects a missing worktree path', async () => {
    registerWorktreeToolHandlers();
    const missing = `/definitely/not/here-${Date.now()}`;
    const ide = handlers.get(IPC_CHANNELS.TASK_WORKTREE_OPEN_IN_IDE)!;
    const term = handlers.get(IPC_CHANNELS.TASK_WORKTREE_OPEN_IN_TERMINAL)!;
    expect(await ide({}, missing, 'vscode')).toEqual({ success: false, error: 'Worktree path does not exist' });
    expect(await term({}, missing, 'system')).toEqual({ success: false, error: 'Worktree path does not exist' });
  });
});
