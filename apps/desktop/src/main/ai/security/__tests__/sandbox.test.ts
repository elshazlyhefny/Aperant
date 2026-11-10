import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseSandboxMode, wrapForSandbox } from '../sandbox';

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

  it('builds a PowerShell launcher on win32 when powershell is found', () => {
    const r = wrapForSandbox('C:\\Git\\bash.exe', [], {
      ...base, cwd: 'C:\\work\\wt', projectDir: 'C:\\work\\main', writablePaths: [], homeDir: 'C:\\Users\\u',
      mode: 'home-hidden', platformName: 'win32', find: (n: string) => `C:\\bin\\${n}`,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file.endsWith('powershell.exe')).toBe(true);
    expect(r.args).toContain('-NoProfile');
    expect(r.args).toContain('-NonInteractive');
    expect(r.args).toContain('-Command');
  });

  it('refuses home-hidden-no-network on win32 even when powershell is found', () => {
    const r = wrapForSandbox('C:\\Git\\bash.exe', [], {
      ...base, cwd: 'C:\\work\\wt', projectDir: 'C:\\work\\main', writablePaths: [], homeDir: 'C:\\Users\\u',
      mode: 'home-hidden-no-network', platformName: 'win32', find: (n: string) => `C:\\bin\\${n}`,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/network/);
  });
});

describe('parseSandboxMode', () => {
  it('accepts valid modes and defaults to off', () => {
    expect(parseSandboxMode('home-hidden')).toBe('home-hidden');
    expect(parseSandboxMode('home-hidden-no-network')).toBe('home-hidden-no-network');
    for (const v of [undefined, null, 5, 'nope', {}, '']) expect(parseSandboxMode(v)).toBe('off');
  });
});
