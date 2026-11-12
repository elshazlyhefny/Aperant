import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { collectSecretEnvFiles, parseSandboxMode, wrapForSandbox } from '../sandbox';

// The Windows launcher writes its script file here instead of the shared temp dir.
const launcherDir = mkdtempSync(path.join(os.tmpdir(), 'aperant-sbx-test-'));
afterAll(() => rmSync(launcherDir, { recursive: true, force: true }));

const base = {
  cwd: '/work/wt',
  projectDir: '/work/main',
  writablePaths: ['/work/extra'],
  homeDir: '/home/u',
  launcherDir,
};
const found = (n: string) => `/usr/bin/${n}`;

describe('wrapForSandbox', () => {
  it('passes through when off', () => {
    expect(wrapForSandbox('/bin/bash', ['-c', 'ls'], { ...base, mode: 'off' })).toEqual({
      ok: true, file: '/bin/bash', args: ['-c', 'ls'],
    });
  });

  it('builds bwrap args on linux', () => {
    const r = wrapForSandbox('/bin/bash', ['-c', 'ls'], {
      ...base, mode: 'home-hidden', platformName: 'linux', find: found,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file).toBe('/usr/bin/bwrap');
    expect(r.args).toContain('--die-with-parent');
    expect(r.args).not.toContain('--unshare-net');
    const i = r.args.indexOf('--tmpfs');
    expect(r.args[i + 1]).toBe('/home/u');
    for (const p of ['/work/wt', '/work/main', '/work/extra']) {
      const idx = r.args.findIndex((a, k) => a === '--bind' && r.args[k + 1] === p);
      expect(idx).toBeGreaterThan(-1);
    }
    expect(r.args.slice(-4)).toEqual(['--', '/bin/bash', '-c', 'ls']);
  });

  it('adds --unshare-net only in no-network mode', () => {
    const r = wrapForSandbox('/bin/bash', [], {
      ...base, mode: 'home-hidden-no-network', platformName: 'linux', find: found,
    });
    expect(r.ok && r.args.includes('--unshare-net')).toBe(true);
  });

  it('builds a sandbox-exec profile on macOS', () => {
    const r = wrapForSandbox('/bin/zsh', ['-c', 'ls'], {
      ...base, mode: 'home-hidden', platformName: 'darwin', find: found,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file).toBe('/usr/bin/sandbox-exec');
    expect(r.args[0]).toBe('-p');
    expect(r.args[1]).toContain('(allow default)');
    expect(r.args[1]).toContain('(deny file-read* file-write* (subpath "/home/u"))');
    expect(r.args[1]).toContain('(subpath "/work/wt")');
    expect(r.args[1]).not.toContain('network*');
    expect(r.args.slice(2)).toEqual(['/bin/zsh', '-c', 'ls']);
  });

  it('denies network on macOS in no-network mode', () => {
    const r = wrapForSandbox('/bin/zsh', [], {
      ...base, mode: 'home-hidden-no-network', platformName: 'darwin', find: found,
    });
    expect(r.ok && r.args[1].includes('(deny network*)')).toBe(true);
  });

  it('rejects unsafe paths on macOS', () => {
    const r = wrapForSandbox('/bin/zsh', [], {
      ...base, cwd: '/work/"x', mode: 'home-hidden', platformName: 'darwin', find: found,
    });
    expect(r.ok).toBe(false);
  });

  it('fails closed when tool missing or on win32', () => {
    for (const platformName of ['linux', 'darwin'] as const) {
      const r = wrapForSandbox('sh', [], { ...base, mode: 'home-hidden', platformName, find: () => null });
      expect(r.ok).toBe(false);
    }
    const w = wrapForSandbox('sh', [], { ...base, mode: 'home-hidden', platformName: 'win32', find: () => null });
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.reason).toMatch(/Windows/);
  });

  it('builds a PowerShell launcher on win32 for restricted-rights when powershell is found', () => {
    const r = wrapForSandbox('C:\\Git\\bash.exe', [], {
      ...base, cwd: 'C:\\work\\wt', projectDir: 'C:\\work\\main', writablePaths: [], homeDir: 'C:\\Users\\u',
      mode: 'restricted-rights', platformName: 'win32', find: (n: string) => `C:\\bin\\${n}`,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file.endsWith('powershell.exe')).toBe(true);
    expect(r.args).toContain('-NoProfile');
    expect(r.args).toContain('-NonInteractive');
    expect(r.args).toContain('-Command');
  });

  it('refuses both home-hidden modes on win32 even when powershell is found', () => {
    for (const mode of ['home-hidden', 'home-hidden-no-network'] as const) {
      const r = wrapForSandbox('C:\\Git\\bash.exe', [], {
        ...base, cwd: 'C:\\work\\wt', projectDir: 'C:\\work\\main', writablePaths: [], homeDir: 'C:\\Users\\u',
        mode, platformName: 'win32', find: (n: string) => `C:\\bin\\${n}`,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/not supported on Windows/);
    }
  });

  it('refuses restricted-rights on linux and macOS even when the sandbox tool is found', () => {
    for (const platformName of ['linux', 'darwin'] as const) {
      const r = wrapForSandbox('/bin/bash', ['-c', 'ls'], { ...base, mode: 'restricted-rights', platformName, find: found });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/only available on Windows/);
    }
  });
});

describe('integration token file masking', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'aperant-sbx-env-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  function project(name: string, files: string[]): string {
    const root = path.join(tmp, name);
    mkdirSync(path.join(root, '.auto-claude'), { recursive: true });
    for (const f of files) writeFileSync(path.join(root, '.auto-claude', f), 'TOKEN=x');
    return root;
  }
  const opts = (dir: string, extra = {}) => ({
    ...base, cwd: dir, projectDir: dir, writablePaths: [] as string[], mode: 'home-hidden' as const, find: found, ...extra,
  });

  it('masks .env and .env.local with /dev/null after the project bind', () => {
    const root = project('a', ['.env', '.env.local', 'other.json']);
    const r = wrapForSandbox('/bin/bash', ['-c', 'ls'], opts(root, { platformName: 'linux' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bindIdx = r.args.findIndex((a, k) => a === '--bind' && r.args[k + 1] === root);
    for (const f of ['.env', '.env.local']) {
      const file = path.join(root, '.auto-claude', f);
      const i = r.args.findIndex((a, k) => a === '--ro-bind' && r.args[k + 1] === '/dev/null' && r.args[k + 2] === file);
      expect(i).toBeGreaterThan(bindIdx);
    }
    expect(r.args.some((a) => a.endsWith('other.json'))).toBe(false);
    expect(r.args.slice(-4)).toEqual(['--', '/bin/bash', '-c', 'ls']);
  });

  it('masks the main project file when running in a task worktree', () => {
    const main = project('b', ['.env']);
    const wt = path.join(main, '.auto-claude', 'worktrees', 'tasks', '001');
    mkdirSync(wt, { recursive: true });
    expect(collectSecretEnvFiles({ cwd: wt, projectDir: wt })).toEqual([path.join(main, '.auto-claude', '.env')]);
    const r = wrapForSandbox('/bin/bash', [], opts(wt, { platformName: 'linux' }));
    expect(r.ok && r.args.includes(path.join(main, '.auto-claude', '.env'))).toBe(true);
  });

  it('adds nothing when no .env exists', () => {
    const root = project('c', []);
    const r = wrapForSandbox('/bin/bash', [], opts(root, { platformName: 'linux' }));
    expect(r.ok && r.args.includes('/dev/null')).toBe(false);
  });

  it('denies the file on macOS after the allow line', () => {
    const root = project('d', ['.env']);
    const r = wrapForSandbox('/bin/zsh', [], opts(root, { platformName: 'darwin' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const profile = r.args[1];
    const deny = `(deny file-read* file-write* (literal "${path.join(root, '.auto-claude', '.env')}"))`;
    expect(profile).toContain(deny);
    expect(profile.indexOf(deny)).toBeGreaterThan(profile.indexOf('(allow file-read* file-write*'));
  });

  it('refuses unsafe characters on macOS', () => {
    const r = wrapForSandbox('/bin/zsh', [], opts('/work/"x', { platformName: 'darwin' }));
    expect(r.ok).toBe(false);
  });
});

describe('parseSandboxMode', () => {
  it('accepts valid modes and defaults to off', () => {
    expect(parseSandboxMode('home-hidden')).toBe('home-hidden');
    expect(parseSandboxMode('home-hidden-no-network')).toBe('home-hidden-no-network');
    expect(parseSandboxMode('restricted-rights')).toBe('restricted-rights');
    for (const v of [undefined, null, 5, 'nope', {}, '']) expect(parseSandboxMode(v)).toBe('off');
  });
});
