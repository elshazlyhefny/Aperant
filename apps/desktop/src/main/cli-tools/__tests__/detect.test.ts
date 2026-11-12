/**
 * Unit tests for the generic detectors and the version probe
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readdirSync, promises as fsPromises } from 'fs';
import { execFileSync } from 'child_process';
import { detectSync, detectAsync, validateTool, validateToolAsync, validateClaudeAsync } from '../detect';
import { planVersionCommand } from '../run-version';
import { TOOL_SPECS } from '../specs';
import type { DetectionContext } from '../types';
import { getAugmentedEnv, getAugmentedEnvAsync, findExecutable, findExecutableAsync } from '../../env-utils';
import { isSecurePath } from '../../utils/windows-paths';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: vi.fn() } }));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  promises: { readdir: vi.fn() },
}));

vi.mock('child_process', () => {
  const sharedSyncMock = vi.fn();
  const mockExecFile = vi.fn();
  // promisify(execFile) resolves { stdout } from the same mock as execFileSync
  (mockExecFile as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] =
    vi.fn(async (...callArgs: unknown[]) => {
      const stdout = (sharedSyncMock as unknown as (...a: unknown[]) => unknown)(...callArgs);
      return { stdout: stdout === undefined ? '' : String(stdout), stderr: '' };
    });
  return { execFileSync: sharedSyncMock, execFile: mockExecFile };
});

vi.mock('../../env-utils', () => ({
  findExecutable: vi.fn(() => null),
  findExecutableAsync: vi.fn(() => Promise.resolve(null)),
  getAugmentedEnv: vi.fn(() => ({ PATH: '' })),
  getAugmentedEnvAsync: vi.fn(() => Promise.resolve({ PATH: '' })),
  shouldUseShell: vi.fn((command: string) => {
    if (process.platform !== 'win32') return false;
    const t = command.trim();
    const u = t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
    return /\.(cmd|bat)$/i.test(u);
  }),
  existsAsync: vi.fn(async (p: string) => {
    const fsMock = await import('fs');
    return Boolean(fsMock.existsSync(p));
  }),
}));

vi.mock('../../utils/homebrew-python', () => ({
  getHomebrewPythonPaths: vi.fn(() => ['/opt/homebrew/bin/python3']),
}));

vi.mock('../../utils/windows-paths', () => ({
  findWindowsExecutableViaWhere: vi.fn(() => null),
  findWindowsExecutableViaWhereAsync: vi.fn(() => Promise.resolve(null)),
  isSecurePath: vi.fn(() => true),
  getWindowsExecutablePaths: vi.fn(() => []),
  getWindowsExecutablePathsAsync: vi.fn(() => Promise.resolve([])),
  WINDOWS_GIT_PATHS: {},
  WINDOWS_GLAB_PATHS: {},
}));

const setPlatform = (value: NodeJS.Platform) =>
  Object.defineProperty(process, 'platform', { value, writable: true });

const ctxFor = (os: DetectionContext['os']): DetectionContext => ({
  os,
  homeDir: '/mock/home',
  isPackaged: false,
  resourcesPath: '/res',
});

/** Make only the listed paths exist and answer --version with the given output per executable */
function mockWorld(existing: string[], output: string | ((file: string) => string)) {
  vi.mocked(existsSync).mockImplementation((p) => existing.includes(String(p)));
  vi.mocked(execFileSync).mockImplementation(((file: string) =>
    typeof output === 'function' ? output(file) : output) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  setPlatform('linux');
  vi.mocked(findExecutable).mockReturnValue(null);
  vi.mocked(findExecutableAsync).mockResolvedValue(null);
  vi.mocked(isSecurePath).mockReturnValue(true);
});

describe('detect - candidate order', () => {
  it('first valid candidate wins (homebrew before system path)', async () => {
    setPlatform('darwin');
    mockWorld(['/opt/homebrew/bin/git', '/usr/local/bin/git'], 'git version 2.40.0\n');
    vi.mocked(findExecutable).mockReturnValue('/usr/bin/git');
    vi.mocked(findExecutableAsync).mockResolvedValue('/usr/bin/git');
    const ctx = ctxFor('darwin');
    const sync = detectSync(TOOL_SPECS.git, undefined, ctx);
    expect(sync).toMatchObject({ found: true, path: '/opt/homebrew/bin/git', source: 'homebrew', version: '2.40.0' });
    expect(await detectAsync(TOOL_SPECS.git, undefined, ctx)).toEqual(sync);
  });

  it('skips invalid candidates and uses the next one', async () => {
    setPlatform('darwin');
    mockWorld(['/opt/homebrew/bin/gh', '/usr/local/bin/gh'], (file) => {
      if (file === '/opt/homebrew/bin/gh') throw new Error('broken');
      return 'gh version 2.30.0 (2023)\n';
    });
    const ctx = ctxFor('darwin');
    const sync = detectSync(TOOL_SPECS.gh, undefined, ctx);
    expect(sync).toMatchObject({ found: true, path: '/usr/local/bin/gh', version: '2.30.0' });
    expect(await detectAsync(TOOL_SPECS.gh, undefined, ctx)).toEqual(sync);
  });

  it('returns the not-found result when nothing resolves', async () => {
    mockWorld([], '');
    const ctx = ctxFor('linux');
    const expected = { found: false, source: 'fallback', message: TOOL_SPECS.glab.notFound };
    expect(detectSync(TOOL_SPECS.glab, undefined, ctx)).toEqual(expected);
    expect(await detectAsync(TOOL_SPECS.glab, undefined, ctx)).toEqual(expected);
  });

  it('prefers the user-configured path and warns when invalid', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockWorld(['/usr/local/bin/gh'], (file) => {
      if (file === '/custom/gh') throw new Error('nope');
      return 'gh version 2.1.0\n';
    });
    vi.mocked(findExecutable).mockReturnValue('/usr/local/bin/gh');
    vi.mocked(findExecutableAsync).mockResolvedValue('/usr/local/bin/gh');
    const ctx = ctxFor('linux');
    const sync = detectSync(TOOL_SPECS.gh, '/custom/gh', ctx);
    expect(sync).toMatchObject({ found: true, path: '/usr/local/bin/gh', source: 'system-path' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('User-configured path invalid'));
    expect(await detectAsync(TOOL_SPECS.gh, '/custom/gh', ctx)).toEqual(sync);
    warn.mockRestore();
  });

  it('ignores a wrong-platform user path with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockWorld([], '');
    detectSync(TOOL_SPECS.git, 'C:\\Git\\git.exe', ctxFor('linux'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('different platform'));
    expect(execFileSync).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rejects an insecure Claude user path on win32 without executing it', async () => {
    setPlatform('win32');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(isSecurePath).mockReturnValue(false);
    mockWorld([], '');
    const ctx = ctxFor('win32');
    detectSync(TOOL_SPECS.claude, 'C:\\evil&calc\\claude.exe', ctx);
    await detectAsync(TOOL_SPECS.claude, 'C:\\evil&calc\\claude.exe', ctx);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed security validation'));
    expect(execFileSync).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('scans NVM versions newest first (sync and async agree)', async () => {
    const dir = '/mock/home/.nvm/versions/node';
    const dirent = (name: string) => ({ name, isDirectory: () => true }) as never;
    vi.mocked(readdirSync).mockReturnValue([dirent('v18.0.0'), dirent('v20.0.0')] as never);
    vi.mocked(fsPromises.readdir).mockResolvedValue([dirent('v18.0.0'), dirent('v20.0.0')] as never);
    mockWorld([dir, `${dir}/v18.0.0/bin/claude`, `${dir}/v20.0.0/bin/claude`], 'claude 1.2.3\n');
    const ctx = ctxFor('linux');
    const sync = detectSync(TOOL_SPECS.claude, undefined, ctx);
    expect(sync).toMatchObject({ found: true, path: `${dir}/v20.0.0/bin/claude`, source: 'nvm' });
    expect(await detectAsync(TOOL_SPECS.claude, undefined, ctx)).toEqual(sync);
  });

  it('warns when the NVM directory cannot be read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(readdirSync).mockImplementation(() => {
      throw new Error('EACCES');
    });
    mockWorld(['/mock/home/.nvm/versions/node'], '');
    detectSync(TOOL_SPECS.claude, undefined, ctxFor('linux'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[Claude CLI] Unable to read NVM directory'));
    warn.mockRestore();
  });
});

describe('validate', () => {
  it('rejects Python older than 3.10', async () => {
    mockWorld([], 'Python 3.9.7\n');
    const expected = { valid: false, version: '3.9.7', message: 'Python 3.9.7 is too old. Requires 3.10.0+' };
    expect(validateTool(TOOL_SPECS.python, '/usr/bin/python3')).toEqual(expected);
    expect(await validateToolAsync(TOOL_SPECS.python, '/usr/bin/python3')).toEqual(expected);
  });

  it('accepts Python 3.10+ and reports unparsable output', () => {
    mockWorld([], 'Python 3.12.1\n');
    expect(validateTool(TOOL_SPECS.python, 'python3')).toEqual({
      valid: true, version: '3.12.1', message: 'Python 3.12.1 meets requirements',
    });
    mockWorld([], 'garbage');
    expect(validateTool(TOOL_SPECS.python, 'python3')).toEqual({
      valid: false, message: 'Unable to detect Python version',
    });
  });

  it('splits "py -3" only for Python', () => {
    mockWorld([], 'Python 3.11.0\n');
    validateTool(TOOL_SPECS.python, 'py -3');
    expect(vi.mocked(execFileSync).mock.calls[0].slice(0, 2)).toEqual(['py', ['-3', '--version']]);
  });

  it('strips surrounding quotes', () => {
    mockWorld([], 'git version 2.0.0\n');
    expect(validateTool(TOOL_SPECS.git, '"/opt/my git/git"').valid).toBe(true);
    expect(vi.mocked(execFileSync).mock.calls[0][0]).toBe('/opt/my git/git');
  });

  it('reports exec failures with the error message', async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('boom');
    });
    const expected = { valid: false, message: 'Failed to validate Git: boom' };
    expect(validateTool(TOOL_SPECS.git, 'git')).toEqual(expected);
    expect(await validateToolAsync(TOOL_SPECS.git, 'git')).toEqual(expected);
  });

  it('builds the env from getAugmentedEnv(Async) with the CLI directory', async () => {
    mockWorld([], 'claude 1.0.0\n');
    validateTool(TOOL_SPECS.claude, '/opt/bin/claude');
    expect(getAugmentedEnv).toHaveBeenCalledWith(['/opt/bin']);
    await validateClaudeAsync('/opt/bin/claude');
    expect(getAugmentedEnvAsync).toHaveBeenCalledWith(['/opt/bin']);
    validateTool(TOOL_SPECS.claude, 'claude');
    expect(getAugmentedEnv).toHaveBeenLastCalledWith([]);
  });
});

describe('planVersionCommand', () => {
  it('uses execFile without a shell on non-Windows', () => {
    const plan = planVersionCommand('/usr/bin/git', ['--version']);
    expect(plan).toMatchObject({ file: '/usr/bin/git', args: ['--version'], cmdDir: '/usr/bin' });
    expect(plan.options).toMatchObject({ shell: false, encoding: 'utf-8', timeout: 5000, windowsHide: true });
  });

  it('routes win32 .cmd through cmd.exe with verbatim arguments', async () => {
    setPlatform('win32');
    const plan = planVersionCommand('"C:\\Users\\a b\\npm\\claude.cmd"', ['--version']);
    expect(plan.file.toLowerCase()).toContain('cmd.exe');
    expect(plan.args).toEqual(['/d', '/s', '/c', '""C:\\Users\\a b\\npm\\claude.cmd" --version"']);
    expect(plan.options.windowsVerbatimArguments).toBe(true);

    mockWorld([], 'claude 1.0.0\n');
    expect(validateTool(TOOL_SPECS.claude, 'C:\\npm\\claude.cmd').valid).toBe(true);
    expect(vi.mocked(execFileSync).mock.calls[0][2]).toMatchObject({ windowsVerbatimArguments: true });
  });

  it('rejects an insecure win32 .cmd path without executing', async () => {
    setPlatform('win32');
    vi.mocked(isSecurePath).mockReturnValue(false);
    const expected = {
      valid: false,
      message: 'Failed to validate Claude CLI: Claude CLI path failed security validation: C:\\x&y\\claude.cmd',
    };
    expect(validateTool(TOOL_SPECS.claude, 'C:\\x&y\\claude.cmd')).toEqual(expected);
    expect(await validateToolAsync(TOOL_SPECS.claude, 'C:\\x&y\\claude.cmd')).toEqual(expected);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
