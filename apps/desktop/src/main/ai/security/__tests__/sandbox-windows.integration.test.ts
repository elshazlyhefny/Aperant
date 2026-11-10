// zeenha fork: runs the real Windows restricted-token + Job object launcher.
// Only meaningful on Windows, so it is skipped elsewhere (a test file may check
// the OS directly). Every isolation assertion is paired with a positive control
// in the same shell run, so a test cannot pass just because bash failed to start.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SandboxMode, wrapForSandbox } from '../sandbox';

const BASH_CANDIDATES = [
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Git', 'bin', 'bash.exe'),
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Git', 'usr', 'bin', 'bash.exe'),
].filter((p): p is string => Boolean(p));

const ADMINISTRATORS = 'S-1-5-32-544';
const NO_PATH_CONVERSION = "MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function exec(file: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout: 90_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function describeRun(r: RunResult): string {
  return `exit=${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`;
}

// Each run starts PowerShell and compiles the launcher, so allow a generous timeout.
describe.skipIf(process.platform !== 'win32')('Windows sandbox (integration)', { timeout: 120_000 }, () => {
  let worktree: string;
  let canaryDir: string;
  let canary: string;
  let bash: string;

  beforeAll(() => {
    bash = BASH_CANDIDATES.find((p) => existsSync(p)) ?? '';
    // On a GitHub runner os.tmpdir() is inside the user profile, so the worktree
    // only works because the sandbox grants it explicitly.
    worktree = mkdtempSync(path.join(os.tmpdir(), 'aperant-sbx-wt-'));
    // Created before the first grant: the grant must reach existing files too.
    mkdirSync(path.join(worktree, 'existing', 'nested'), { recursive: true });
    writeFileSync(path.join(worktree, 'existing', 'nested', 'old.txt'), 'pre-existing');
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
    return exec(wrapped.file, wrapped.args, worktree);
  }

  it('finds Git Bash', () => {
    expect(bash).not.toBe('');
  });

  it('runs bash with pipes, subshells and command substitution', async () => {
    const r = await sandboxed('echo "a-$(echo b)" | cat && (echo sub) && printf "%s\\n" done');
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.stdout).toContain('a-b');
    expect(r.stdout).toContain('sub');
    expect(r.stdout).toContain('done');
  });

  it('can write and read a file in the worktree', async () => {
    const r = await sandboxed(
      'echo hello > probe.txt && cat probe.txt && cat existing/nested/old.txt && echo more >> existing/nested/old.txt && cat <<EOF\nheredoc-ok\nEOF'
    );
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.stdout).toContain('pre-existing');
    expect(r.stdout).toContain('hello');
    expect(r.stdout).toContain('heredoc-ok');
    expect(readFileSync(path.join(worktree, 'probe.txt'), 'utf8')).toContain('hello');
  });

  it('runs node and git, including a git repository in the worktree', async () => {
    const r = await sandboxed(
      'node --version && git --version && git init -q repo && cd repo && echo x > f && git add f && git status --short'
    );
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.stdout).toMatch(/v\d+/);
    expect(r.stdout).toContain('git version');
    expect(r.stdout).toContain('A  f');
  });

  it('cannot read a canary file under the home directory', async () => {
    const r = await sandboxed(`echo control-ok; cat "${toPosix(canary)}"`);
    expect(r.stdout, describeRun(r)).toContain('control-ok');
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toContain('SECRET-CANARY');
    expect(r.stderr).toMatch(/Permission denied/i);
  });

  it('cannot list or write into the home directory', async () => {
    const target = path.join(canaryDir, 'written-by-sandbox.txt');
    const r = await sandboxed(
      `echo control-ok; ls "${toPosix(canaryDir)}"; echo pwned > "${toPosix(target)}"`
    );
    expect(r.stdout, describeRun(r)).toContain('control-ok');
    expect(r.stdout).not.toContain('canary.txt');
    expect(r.code).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it('makes the Administrators group deny-only and keeps only SeChangeNotifyPrivilege', async () => {
    const whoami = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe');
    const outside = await exec(whoami, ['/groups', '/fo', 'csv'], worktree);
    const r = await sandboxed(
      `${NO_PATH_CONVERSION} "${toPosix(whoami)}" /groups /fo csv && echo ---- && ${NO_PATH_CONVERSION} "${toPosix(whoami)}" /priv /fo csv`
    );
    expect(r.code, describeRun(r)).toBe(0);
    const [groups, privs] = r.stdout.split('----');
    const adminLine = groups.split(/\r?\n/).find((l) => l.includes(ADMINISTRATORS));
    if (outside.stdout.includes(ADMINISTRATORS)) {
      expect(adminLine, groups).toBeDefined();
      expect(adminLine).toMatch(/deny only/i);
      expect(adminLine).not.toMatch(/Enabled group/i);
    }
    const privRows = privs
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('"Se'));
    expect(privRows.map((l) => l.split(',')[0]), privs).toEqual(['"SeChangeNotifyPrivilege"']);
  });

  it('kills leftover background processes when the command ends', async () => {
    const script = (marker: string) =>
      `(sleep 5; echo late > ${marker}) </dev/null >/dev/null 2>&1 & echo started`;

    // Control: without the sandbox the orphaned background process survives and writes its marker.
    const plain = wrapForSandbox(bash, ['-c', script('late-plain.txt')], {
      mode: 'off', cwd: worktree, projectDir: worktree, writablePaths: [],
    });
    if (!plain.ok) throw new Error(plain.reason);
    const control = await exec(plain.file, plain.args, worktree);
    expect(control.stdout, describeRun(control)).toContain('started');

    const r = await sandboxed(script('late-sandboxed.txt'));
    expect(r.stdout, describeRun(r)).toContain('started');

    await sleep(9_000);
    expect(existsSync(path.join(worktree, 'late-plain.txt'))).toBe(true);
    expect(existsSync(path.join(worktree, 'late-sandboxed.txt'))).toBe(false);
  });

  it('refuses the no-network mode, which Windows cannot enforce', () => {
    const r = wrapForSandbox(bash, ['-c', 'echo hi'], {
      mode: 'home-hidden-no-network',
      cwd: worktree,
      projectDir: worktree,
      writablePaths: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not supported on Windows/);
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
