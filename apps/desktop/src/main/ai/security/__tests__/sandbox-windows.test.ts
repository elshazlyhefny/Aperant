import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isWindows } from '../../../platform/index';
import { wrapForSandbox } from '../sandbox';
import {
  defaultLauncherDir,
  ensureLauncherFile,
  findWindowsTool,
  LAUNCHER_SHA256,
  type WindowsLauncherPayload,
} from '../sandbox-windows';

const SHELL = 'C:\\Git\\bin\\bash.exe';
const launcherDir = mkdtempSync(path.join(os.tmpdir(), 'aperant-sbx-unit-'));
const base = {
  cwd: 'C:\\work\\wt',
  projectDir: 'C:\\work\\main',
  writablePaths: ['C:\\work\\extra'],
  homeDir: 'C:\\Users\\u',
  platformName: 'win32' as const,
  find: (n: string) => `C:\\bin\\${n}`,
  launcherDir,
};

afterAll(() => {
  rmSync(launcherDir, { recursive: true, force: true });
});

function run(overrides: Record<string, unknown> = {}, args: string[] = ['-c', 'ls'], shell = SHELL) {
  return wrapForSandbox(shell, args, { ...base, mode: 'restricted-rights', ...overrides } as never);
}

function decode(r: ReturnType<typeof run>): { command: string; script: string; payload: WindowsLauncherPayload } {
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
  const command = r.args[r.args.indexOf('-Command') + 1];
  const file = command.match(/ReadAllText\('([^']+)'\)/);
  const b64 = command.match(/::Create\(\$t\)\) '([A-Za-z0-9+/=]+)'$/);
  if (!file || !b64) throw new Error(`unexpected bootstrap: ${command}`);
  return {
    command,
    script: readFileSync(file[1], 'utf8'),
    payload: JSON.parse(Buffer.from(b64[1], 'base64').toString('utf8')),
  };
}

describe('Windows restricted-rights launcher', () => {
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

  it('builds a restricted token without restricting SIDs and a kill-on-close Job object', () => {
    const { script } = decode(run());
    expect(script).toContain('CreateRestrictedToken(tok, DISABLE_MAX_PRIVILEGE');
    expect(script).toContain('0, IntPtr.Zero, 0, null, out rtok');
    expect(script).toContain('CreateProcessAsUserW');
    expect(script).toMatch(/JOB_LIMIT_FLAGS = 0x2000 \| 0x400;/);
    expect(script).toContain('JOB_UI_LIMITS = 0xFF');
    expect(script).toContain('AssignProcessToJobObject');
    expect(script).not.toMatch(/AppContainer|SECURITY_CAPABILITIES|SetAccessControl|icacls/);
  });

  it('carries only the shell, its arguments and the cwd', () => {
    const { payload } = decode(run());
    expect(payload).toEqual({ shell: SHELL, args: ['-c', 'ls'], cwd: 'C:\\work\\wt' });
  });

  it('refuses both home-hidden modes, which Windows cannot enforce for Git Bash', () => {
    for (const mode of ['home-hidden', 'home-hidden-no-network']) {
      const r = run({ mode });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/not supported on Windows/);
    }
  });

  it('fails closed when PowerShell cannot be found', () => {
    const r = run({ find: () => null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/powershell/i);
  });

  it('rejects control characters and relative paths', () => {
    expect(run({ cwd: 'C:\\work\\w\u0000t' }).ok).toBe(false);
    expect(run({ cwd: 'C:\\work\\w\nt' }).ok).toBe(false);
    expect(run({ cwd: 'work\\wt' }).ok).toBe(false);
    expect(run({ cwd: '\\\\server\\share' }).ok).toBe(false);
    expect(run({}, ['-c', 'ls'], 'bash.exe').ok).toBe(false);
    expect(run({}, ['a\u0000b']).ok).toBe(false);
  });

  it('carries shell and args only in the payload, never in the command text or script', () => {
    const evil = `"; calc; ' & calc`;
    const { command, script, payload } = decode(run({}, ['-c', evil]));
    expect(payload.args).toEqual(['-c', evil]);
    expect(command).not.toContain(evil);
    expect(command).not.toContain(SHELL);
    expect(script).not.toContain(evil);
  });

  it('makes the bootstrap verify the launcher hash before running it', () => {
    const { command, script } = decode(run());
    expect(createHash('sha256').update(script, 'utf8').digest('hex')).toBe(LAUNCHER_SHA256);
    expect(command).toContain(`if ($h -ne '${LAUNCHER_SHA256}')`);
    // the checked text is what runs: the file is read once
    expect(command.match(/ReadAllText/g)).toHaveLength(1);
    expect(command).toContain('[scriptblock]::Create($t)');
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

  it('leaves no temporary files behind and keeps the file owner-only where supported', () => {
    const file = ensureLauncherFile(launcherDir);
    expect(readdirSync(launcherDir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    if (!isWindows()) expect(statSync(file).mode & 0o077).toBe(0);
  });

  it('defaults to a per-user directory outside the shared temp directory', () => {
    expect(defaultLauncherDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })).toBe(
      path.join('C:\\Users\\u\\AppData\\Local', 'Aperant', 'bash-sandbox')
    );
  });
});

describe('findWindowsTool', () => {
  it('checks an absolute path directly instead of searching PATH', () => {
    expect(findWindowsTool('C:\\no-such-dir\\powershell.exe')).toBeNull();
  });
});
