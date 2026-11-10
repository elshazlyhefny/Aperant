import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { wrapForSandbox } from '../sandbox';
import {
  ensureLauncherFile,
  findWindowsTool,
  SANDBOX_SID,
  type WindowsLauncherPayload,
} from '../sandbox-windows';

const SHELL = 'C:\\Git\\bin\\bash.exe';
const HOME = 'C:\\Users\\u';
const launcherDir = mkdtempSync(path.join(os.tmpdir(), 'aperant-sbx-unit-'));
const base = {
  cwd: 'C:\\work\\wt',
  projectDir: 'C:\\work\\main',
  writablePaths: ['C:\\work\\extra'],
  homeDir: HOME,
  platformName: 'win32' as const,
  find: (n: string) => `C:\\bin\\${n}`,
  launcherDir,
};

afterAll(() => {
  rmSync(launcherDir, { recursive: true, force: true });
});

function run(overrides: Record<string, unknown> = {}, args: string[] = ['-c', 'ls'], shell = SHELL) {
  return wrapForSandbox(shell, args, { ...base, mode: 'home-hidden', ...overrides } as never);
}

function decode(r: ReturnType<typeof run>): { command: string; script: string; payload: WindowsLauncherPayload } {
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
  const command = r.args[r.args.indexOf('-Command') + 1];
  const file = command.match(/ReadAllText\('([^']+)'\)/);
  const b64 = command.match(/\)\)\) '([A-Za-z0-9+/=]+)'$/);
  if (!file || !b64) throw new Error(`unexpected bootstrap: ${command}`);
  return {
    command,
    script: readFileSync(file[1], 'utf8'),
    payload: JSON.parse(Buffer.from(b64[1], 'base64').toString('utf8')),
  };
}

describe('Windows sandbox launcher', () => {
  it('runs PowerShell with a short -Command bootstrap', () => {
    const r = run();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file).toMatch(/powershell\.exe$/);
    expect(r.args.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
    expect(r.args).not.toContain('-EncodedCommand');
    expect(decode(r).command.length).toBeLessThan(1000);
  });

  it('keeps a long command well inside the Windows command-line limit', () => {
    const long = `echo ${'x'.repeat(20_000)}`;
    const r = run({}, ['-c', long]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.args.join(' ').length).toBeLessThan(32_000);
    expect(decode(r).payload.args[1]).toBe(long);
  });

  it('builds a restricted token and a kill-on-close Job object, not an AppContainer', () => {
    const { script } = decode(run());
    expect(script).toContain('CreateRestrictedToken');
    expect(script).toContain('DISABLE_MAX_PRIVILEGE');
    expect(script).toContain('CreateProcessAsUserW');
    expect(script).toMatch(/JOB_LIMIT_FLAGS = 0x2000 \| 0x400;/);
    expect(script).toContain('AssignProcessToJobObject');
    expect(script).not.toMatch(/AppContainer|SECURITY_CAPABILITIES/);
    // the user SID is never put on the restricting list
    expect(script).not.toMatch(/restrict\.Add\([^)]*userSid/);
  });

  it('grants the sandbox SID on cwd, projectDir and writablePaths but never the home directory', () => {
    const { payload } = decode(run());
    expect(payload.sid).toBe(SANDBOX_SID);
    expect(payload.rwPaths).not.toContain(HOME);
    expect(payload.rwPaths).toEqual(['C:\\work\\wt', 'C:\\work\\main', 'C:\\work\\extra']);
    expect(payload.readPaths).toEqual([`${HOME}\\.gitconfig`, `${HOME}\\.config\\git`]);
  });

  it('refuses to make the home directory writable', () => {
    expect(run({ writablePaths: [HOME] }).ok).toBe(false);
    expect(run({ writablePaths: [`${HOME}\\`] }).ok).toBe(false);
  });

  it('refuses the no-network mode, which Windows cannot enforce', () => {
    const r = run({ mode: 'home-hidden-no-network' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not supported on Windows/);
  });

  it('rejects control characters and relative paths', () => {
    expect(run({ cwd: 'C:\\work\\w\u0000t' }).ok).toBe(false);
    expect(run({ cwd: 'C:\\work\\w\nt' }).ok).toBe(false);
    expect(run({ projectDir: 'work\\main' }).ok).toBe(false);
    expect(run({ writablePaths: ['..\\x'] }).ok).toBe(false);
    expect(run({}, ['-c', 'ls'], 'bash.exe').ok).toBe(false);
    expect(run({}, ['a\u0000b']).ok).toBe(false);
  });

  it('carries shell and args only in the payload, never in the command text or script', () => {
    const evil = `"; calc; ' & calc`;
    const { command, script, payload } = decode(run({}, ['-c', evil]));
    expect(payload.shell).toBe(SHELL);
    expect(payload.args).toEqual(['-c', evil]);
    expect(command).not.toContain(evil);
    expect(command).not.toContain(SHELL);
    expect(script).not.toContain(evil);
  });
});

describe('ensureLauncherFile', () => {
  it('rewrites a tampered launcher file', () => {
    const file = ensureLauncherFile(launcherDir);
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, 'Write-Output pwned');
    expect(ensureLauncherFile(launcherDir)).toBe(file);
    expect(readFileSync(file, 'utf8')).toBe(original);
  });
});

describe('findWindowsTool', () => {
  it('checks an absolute path directly instead of searching PATH', () => {
    expect(findWindowsTool('C:\\no-such-dir\\powershell.exe')).toBeNull();
  });
});
