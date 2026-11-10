// zeenha fork: runs the real Windows "restricted rights" launcher (restricted
// token + Job object). Only meaningful on Windows, so it is skipped elsewhere (a
// test file may check the OS directly). Each assertion runs a real shell; tests
// that check a restriction also check that the shell ran, so a test cannot pass
// just because bash failed to start.
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
describe.skipIf(process.platform !== 'win32')('Windows restricted-rights sandbox (integration)', { timeout: 120_000 }, () => {
  let worktree: string;
  let bash: string;

  beforeAll(() => {
    bash = BASH_CANDIDATES.find((p) => existsSync(p)) ?? '';
    worktree = mkdtempSync(path.join(os.tmpdir(), 'aperant-sbx-wt-'));
  });

  afterAll(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  function wrap(script: string, mode: SandboxMode = 'restricted-rights', launcherDir?: string) {
    return wrapForSandbox(bash, ['-c', script], {
      mode,
      cwd: worktree,
      projectDir: worktree,
      writablePaths: [],
      launcherDir,
    });
  }

  function sandboxed(script: string): Promise<RunResult> {
    const wrapped = wrap(script);
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

  it('can write and read files in the project', async () => {
    const r = await sandboxed('echo hello > probe.txt && cat probe.txt && cat <<EOF\nheredoc-ok\nEOF');
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.stdout).toContain('hello');
    expect(r.stdout).toContain('heredoc-ok');
    expect(readFileSync(path.join(worktree, 'probe.txt'), 'utf8')).toContain('hello');
  });

  it('runs node and git, including a git repository in the project', async () => {
    const r = await sandboxed(
      'node --version && git --version && git init -q repo && cd repo && echo x > f && git add f && git status --short'
    );
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.stdout).toMatch(/v\d+/);
    expect(r.stdout).toContain('git version');
    expect(r.stdout).toContain('A  f');
  });

  it('makes the Administrators group deny-only and keeps only SeChangeNotifyPrivilege', async () => {
    const whoami = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe');
    const outside = await exec(whoami, ['/groups', '/fo', 'csv'], worktree);
    const outsidePrivs = await exec(whoami, ['/priv', '/fo', 'csv'], worktree);
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
    // Control: the unsandboxed process really had more privileges to drop.
    expect(outsidePrivs.stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('"Se')).length).toBeGreaterThan(1);
  });

  it('kills leftover background processes when the command ends', async () => {
    const script = (marker: string) =>
      `(sleep 5; echo late > ${marker}) </dev/null >/dev/null 2>&1 & echo started`;

    // Control: without the sandbox the orphaned background process survives and writes its marker.
    const plain = wrap(script('late-plain.txt'), 'off');
    if (!plain.ok) throw new Error(plain.reason);
    const control = await exec(plain.file, plain.args, worktree);
    expect(control.stdout, describeRun(control)).toContain('started');

    const r = await sandboxed(script('late-sandboxed.txt'));
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.stdout).toContain('started');

    await sleep(9_000);
    expect(existsSync(path.join(worktree, 'late-plain.txt'))).toBe(true);
    expect(existsSync(path.join(worktree, 'late-sandboxed.txt'))).toBe(false);
  });

  it('refuses a launcher script that was replaced after it was written', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aperant-sbx-launcher-'));
    try {
      const wrapped = wrap('echo should-not-run', 'restricted-rights', dir);
      if (!wrapped.ok) throw new Error(wrapped.reason);
      const command = wrapped.args[wrapped.args.indexOf('-Command') + 1];
      const file = command.match(/ReadAllText\('([^']+)'\)/)?.[1];
      expect(file).toBeDefined();
      writeFileSync(file as string, "Set-Content -Path 'pwned.txt' -Value x");
      const r = await exec(wrapped.file, wrapped.args, worktree);
      expect(r.code, describeRun(r)).toBe(125);
      expect(r.stderr).toMatch(/modified/);
      expect(r.stdout).not.toContain('should-not-run');
      expect(existsSync(path.join(worktree, 'pwned.txt'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses both home-hidden modes, which Windows cannot enforce for Git Bash', () => {
    for (const mode of ['home-hidden', 'home-hidden-no-network'] as const) {
      const r = wrap('echo hi', mode);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/not supported on Windows/);
    }
  });

  it('fails closed when PowerShell cannot be found', () => {
    const r = wrapForSandbox(bash || 'C:\\Git\\bin\\bash.exe', ['-c', 'ls'], {
      mode: 'restricted-rights',
      cwd: worktree,
      projectDir: worktree,
      writablePaths: [],
      find: () => null,
    });
    expect(r.ok).toBe(false);
  });
});
