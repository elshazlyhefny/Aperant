// TEMPORARY diagnostic for PR #55, removed in the next commit.
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'vitest';
import { wrapForSandbox } from '../sandbox';

const G = 'C:\\Program Files\\Git';
const S = 'C:\\Windows\\System32';
const targets: Array<[string, string, string[]]> = [
  ['cmd', `${S}\\cmd.exe`, ['/c', 'echo ok']],
  ['whoami', `${S}\\whoami.exe`, []],
  ['node', 'C:\\Program Files\\nodejs\\node.exe', ['--version']],
  ['git-native', `${G}\\cmd\\git.exe`, ['--version']],
  ['usr-echo', `${G}\\usr\\bin\\echo.exe`, ['ok']],
  ['usr-bash', `${G}\\usr\\bin\\bash.exe`, ['-c', 'echo ok']],
  ['bin-bash', `${G}\\bin\\bash.exe`, ['-c', 'echo ok']],
];
const run = (file: string, args: string[], cwd: string) =>
  new Promise<string>((resolve) => {
    execFile(file, args, { cwd, timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err ? err.code : 0;
      const hex = typeof code === 'number' ? `0x${(code >>> 0).toString(16)}` : String(code);
      resolve(JSON.stringify({ code: hex, stdout: String(stdout).trim().slice(0, 200), stderr: String(stderr).trim().slice(0, 400) }));
    });
  });

describe.skipIf(process.platform !== 'win32')('sandbox diag', () => {
  it('reports', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'aperant-diag-'));
    process.stderr.write(`DIAG acl-usr ${await run(`${S}\\icacls.exe`, [`${G}\\usr\\bin`], cwd)}\n`);
    process.stderr.write(`DIAG acl-msys ${await run(`${S}\\icacls.exe`, [`${G}\\usr\\bin\\msys-2.0.dll`], cwd)}\n`);
    for (const [label, exe, args] of targets) {
      process.stderr.write(`DIAG plain ${label} ${await run(exe, args, cwd)}\n`);
      const w = wrapForSandbox(exe, args, { mode: 'home-hidden', cwd, projectDir: cwd, writablePaths: [] });
      process.stderr.write(`DIAG boxed ${label} ${w.ok ? await run(w.file, w.args, cwd) : w.reason}\n`);
    }
  }, 300_000);
});
