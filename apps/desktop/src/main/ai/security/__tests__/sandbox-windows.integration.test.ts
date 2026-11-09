// zeenha fork: runs the real Windows AppContainer launcher. Only meaningful on
// Windows, so it is skipped elsewhere (a test file may check the OS directly).
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SandboxMode, wrapForSandbox } from '../sandbox';

const BASH_CANDIDATES = [
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Git', 'bin', 'bash.exe'),
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Git', 'usr', 'bin', 'bash.exe'),
].filter((p): p is string => Boolean(p));

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

describe.skipIf(process.platform !== 'win32')('Windows sandbox (integration)', () => {
  let worktree: string;
  let canaryDir: string;
  let canary: string;
  let bash: string;

  beforeAll(() => {
    bash = BASH_CANDIDATES.find((p) => existsSync(p)) ?? '';
    worktree = mkdtempSync(path.join(os.tmpdir(), 'aperant-sbx-wt-'));
    canaryDir = path.join(os.homedir(), `aperant-sbx-canary-${process.pid}-${Date.now()}`);
    mkdirSync(canaryDir, { recursive: true });
    canary = path.join(canaryDir, 'canary.txt');
    writeFileSync(canary, 'SECRET-CANARY');
  });

  afterAll(() => {
    rmSync(canaryDir, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  function sandboxed(script: string, mode: SandboxMode = 'home-hidden'): Promise<RunResult> {
    const wrapped = wrapForSandbox(bash, ['-c', script], {
      mode,
      cwd: worktree,
      projectDir: worktree,
      writablePaths: [],
    });
    if (!wrapped.ok) throw new Error(wrapped.reason);
    return new Promise((resolve) => {
      execFile(wrapped.file, wrapped.args, { cwd: worktree, timeout: 60_000 }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }

  it('finds Git Bash', () => {
    expect(bash).not.toBe('');
  });

  it('cannot read a canary file under the home directory', async () => {
    const posix = canary.replace(/\\/g, '/');
    const r = await sandboxed(`cat "${posix}"`);
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toContain('SECRET-CANARY');
  });

  it('can write and read a file in the worktree', async () => {
    const r = await sandboxed('echo hello > probe.txt && cat probe.txt');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('hello');
    expect(readFileSync(path.join(worktree, 'probe.txt'), 'utf8')).toContain('hello');
  });

  it('runs node and git', async () => {
    const r = await sandboxed('node --version && git --version');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/v\d+/);
    expect(r.stdout).toContain('git version');
  });

  it('refuses connections in no-network mode', async () => {
    const server = net.createServer((s) => s.end());
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    const { port } = server.address() as net.AddressInfo;
    try {
      const r = await sandboxed(`exec 3<>/dev/tcp/127.0.0.1/${port}`, 'home-hidden-no-network');
      expect(r.code).not.toBe(0);
    } finally {
      server.close();
    }
  });

  it('fails closed when PowerShell cannot be found', () => {
    const r = wrapForSandbox(bash || 'C:\\Git\\bin\\bash.exe', ['-c', 'ls'], {
      mode: 'home-hidden',
      cwd: worktree,
      projectDir: worktree,
      writablePaths: [],
      find: () => null,
    });
    expect(r.ok).toBe(false);
  });
});
