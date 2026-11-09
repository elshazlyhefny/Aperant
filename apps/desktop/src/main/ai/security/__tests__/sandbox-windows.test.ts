import { describe, expect, it } from 'vitest';
import { wrapForSandbox } from '../sandbox';
import type { WindowsLauncherPayload } from '../sandbox-windows';

const SHELL = 'C:\\Git\\bin\\bash.exe';
const HOME = 'C:\\Users\\u';
const base = {
  cwd: 'C:\\work\\wt',
  projectDir: 'C:\\work\\main',
  writablePaths: ['C:\\work\\extra'],
  homeDir: HOME,
  platformName: 'win32' as const,
  find: (n: string) => `C:\\bin\\${n}`,
};

function run(overrides: Record<string, unknown> = {}, args: string[] = ['-c', 'ls'], shell = SHELL) {
  return wrapForSandbox(shell, args, { ...base, mode: 'home-hidden', ...overrides } as never);
}

function decode(r: ReturnType<typeof run>): { script: string; payload: WindowsLauncherPayload } {
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
  const encoded = r.args[r.args.indexOf('-EncodedCommand') + 1];
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  const m = script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/);
  if (!m) throw new Error('payload not found');
  return { script, payload: JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) };
}

describe('Windows sandbox launcher', () => {
  it('never grants the home directory but grants cwd, projectDir and writablePaths', () => {
    const { payload } = decode(run());
    expect(payload.rwPaths).not.toContain(HOME);
    expect(payload.rwPaths).toEqual(expect.arrayContaining(['C:\\work\\wt', 'C:\\work\\main', 'C:\\work\\extra']));
  });

  it('refuses to make the home directory writable', () => {
    expect(run({ writablePaths: [HOME] }).ok).toBe(false);
  });

  it('has no network capabilities in no-network mode and some otherwise', () => {
    expect(decode(run({ mode: 'home-hidden-no-network' })).payload.capabilities).toEqual([]);
    expect(decode(run()).payload.capabilities.length).toBeGreaterThan(0);
  });

  it('rejects control characters and relative paths', () => {
    expect(run({ cwd: 'C:\\work\\w\u0000t' }).ok).toBe(false);
    expect(run({ cwd: 'C:\\work\\w\nt' }).ok).toBe(false);
    expect(run({ projectDir: 'work\\main' }).ok).toBe(false);
    expect(run({ writablePaths: ['..\\x'] }).ok).toBe(false);
    expect(run({}, ['-c', 'ls'], 'bash.exe').ok).toBe(false);
    expect(run({}, ['a\u0000b']).ok).toBe(false);
  });

  it('carries shell and args only in the payload, not in the script text', () => {
    const evil = '"; calc; "';
    const { script, payload } = decode(run({}, ['-c', evil]));
    expect(payload.shell).toBe(SHELL);
    expect(payload.args).toEqual(['-c', evil]);
    expect(script).not.toContain(evil);
    expect(script).not.toContain(SHELL);
  });
});
