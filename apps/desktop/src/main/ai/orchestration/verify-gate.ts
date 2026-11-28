/**
 * zeenha fork: run the project's own checks after QA approves.
 *
 * QA approval used to be only what the reviewer LLM wrote, and typecheck and
 * test breakages reached trunk behind first-time approvals. This gate runs the
 * commands a repository lists in `.aperant.json` `verifyCommands` against the
 * task's committed work merged with the latest base branch, so a task that
 * passes alone but breaks once combined with newer trunk commits is caught here,
 * not after merge. A failure turns the approval into a rejection and writes a
 * QA_FIX_REQUEST.md for the existing fixer loop.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isWindows, killProcessGracefully } from '../../platform';
import { getIsolatedGitEnv } from '../../utils/git-env';
import { buildChildEnv } from '../security/child-env';
import { linkWorktreeDependencies } from '../worktree/worktree-dependency-links';
import { waitForHostLoad } from './host-load';

/** Per-command limit. A full test suite on a loaded laptop can take a while. */
const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2 * 60 * 1000;
const GIT_TIMEOUT_MS = 60 * 1000;
export const OUTPUT_TAIL_CHARS = 4000;
/** Output kept in memory while a command runs; only the tail is reported. */
const OUTPUT_BUFFER_CHARS = 64 * 1024;

export type VerifyGateResult =
  | { status: 'skipped' }
  | {
      status: 'passed';
      /** The ref the work was verified against (merged or already contained), or null. */
      base: string | null;
      baseMerged: boolean;
      notes: string[];
    }
  | {
      status: 'failed';
      reason: 'command_failed';
      command: string;
      outputTail: string;
      base: string | null;
      baseMerged: boolean;
      notes: string[];
    }
  | {
      status: 'failed';
      reason: 'base_conflict';
      files: string[];
      base: string;
      notes: string[];
    };

export type VerifyGateFailure = Extract<VerifyGateResult, { status: 'failed' }>;

export interface VerifyGateOptions {
  /** The task's worktree (its HEAD is the work being verified). */
  worktreePath: string;
  /** The main checkout, the source of linked dependencies. */
  projectPath: string;
  baseBranch: string;
  commands: readonly string[] | undefined;
  /** Per-command timeout. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Environment for the commands. Default: the process env without credentials. */
  env?: NodeJS.ProcessEnv;
  /** Injected by tests. */
  waitForLoad?: (signal?: AbortSignal) => Promise<unknown>;
}

// =============================================================================
// Process helpers
// =============================================================================

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, env: getIsolatedGitEnv(), timeout: timeoutMs, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

function killTree(child: ChildProcess): void {
  // The command runs in its own process group on Linux and macOS, so the whole
  // tree (npm → vitest → workers) goes, not only the shell.
  if (!isWindows() && child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // Group already gone; fall through to the single-process kill.
    }
  }
  killProcessGracefully(child);
}

interface CommandResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
}

/** Run one command through the platform's default shell (sh, or cmd.exe on Windows). */
function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let settled = false;

    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Not on Windows, where detached opens a console window.
      detached: !isWindows(),
    });

    const append = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > OUTPUT_BUFFER_CHARS) output = output.slice(-OUTPUT_BUFFER_CHARS);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const onAbort = () => killTree(child);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode, output, timedOut });
    };
    child.on('error', (err) => {
      append(Buffer.from(`\n${err.message}\n`));
      finish(1);
    });
    child.on('close', (code) => finish(!timedOut && typeof code === 'number' ? code : 1));
  });
}

// =============================================================================
// Gate
// =============================================================================

async function refExists(cwd: string, ref: string): Promise<boolean> {
  return (await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd)).ok;
}

async function runCommands(
  cwd: string,
  options: VerifyGateOptions,
  base: string | null,
  baseMerged: boolean,
  notes: string[],
): Promise<VerifyGateResult> {
  const { commands = [], signal, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = options;
  const env = options.env ?? buildChildEnv(process.env);
  await (options.waitForLoad ?? ((s) => waitForHostLoad({ signal: s })))(signal);

  for (const command of commands) {
    const result = await runShellCommand(command, cwd, timeoutMs, env, signal);
    if (result.exitCode !== 0) {
      let outputTail = result.output.slice(-OUTPUT_TAIL_CHARS);
      if (result.timedOut) {
        outputTail += `\n[verify gate: timed out after ${Math.round(timeoutMs / 60000)} min]`;
      }
      return { status: 'failed', reason: 'command_failed', command, outputTail, base, baseMerged, notes };
    }
  }
  return { status: 'passed', base, baseMerged, notes };
}

/**
 * Verify the task's committed work against the latest base branch.
 * Never throws for git trouble: anything that prevents a merged check falls
 * back to verifying the task worktree as it is, recorded in `notes`.
 */
export async function runVerifyGate(options: VerifyGateOptions): Promise<VerifyGateResult> {
  const commands = (options.commands ?? []).filter((c) => c.trim() !== '');
  if (commands.length === 0) return { status: 'skipped' };
  const opts = { ...options, commands };
  const { worktreePath, projectPath, baseBranch } = opts;
  const notes: string[] = [];

  // 1. Latest base. A failed fetch is not fatal: the local ref is the best we have.
  const fetched = await git(['fetch', 'origin', baseBranch], worktreePath, FETCH_TIMEOUT_MS);
  if (!fetched.ok) {
    notes.push(`Could not fetch origin/${baseBranch}; verified against the local ref instead.`);
  }

  let base: string | null = null;
  if (await refExists(worktreePath, `refs/remotes/origin/${baseBranch}`)) {
    base = `origin/${baseBranch}`;
  } else if (await refExists(worktreePath, `refs/heads/${baseBranch}`)) {
    base = baseBranch;
  } else {
    notes.push(`Base branch ${baseBranch} not found; verified the task branch without merging it.`);
    return runCommands(worktreePath, opts, null, false, notes);
  }

  // 2. Base already contained: verify the worktree itself.
  if ((await git(['merge-base', '--is-ancestor', base, 'HEAD'], worktreePath)).ok) {
    return runCommands(worktreePath, opts, base, true, notes);
  }

  // 3. Base moved on: verify the merged result in a throwaway worktree, so the
  // task branch itself is never changed by the gate.
  let tempDir: string;
  try {
    tempDir = mkdtempSync(join(tmpdir(), 'aperant-verify-'));
  } catch {
    notes.push(`Could not create a temporary worktree; verified the task branch without merging ${base}.`);
    return runCommands(worktreePath, opts, base, false, notes);
  }
  // `git worktree add` wants to create the directory itself.
  rmSync(tempDir, { recursive: true, force: true });

  let linked: string[] = [];
  try {
    const added = await git(['worktree', 'add', '--detach', tempDir, 'HEAD'], worktreePath);
    if (!added.ok) {
      notes.push(`Could not create a temporary worktree; verified the task branch without merging ${base}.`);
      return runCommands(worktreePath, opts, base, false, notes);
    }

    // --no-commit: the merged tree is all we need, and it needs no git identity.
    const merged = await git(['merge', '--no-commit', '--no-ff', base], tempDir);
    if (!merged.ok) {
      const conflicts = await git(['diff', '--name-only', '--diff-filter=U'], tempDir);
      const files = conflicts.stdout.split('\n').map((f) => f.trim()).filter(Boolean);
      if (files.length > 0) {
        return { status: 'failed', reason: 'base_conflict', files, base, notes };
      }
      notes.push(`Could not merge ${base} (${merged.stderr.trim() || 'unknown error'}); verified the task branch without merging.`);
      return runCommands(worktreePath, opts, base, false, notes);
    }

    linked = await linkWorktreeDependencies(projectPath, tempDir);
    return await runCommands(tempDir, opts, base, true, notes);
  } finally {
    // Remove the dependency links first, so nothing can follow them into the
    // main checkout's folders while the worktree is deleted.
    for (const relPath of linked) {
      rmSync(join(tempDir, relPath), { force: true });
    }
    await git(['worktree', 'remove', '--force', tempDir], worktreePath);
    rmSync(tempDir, { recursive: true, force: true });
    await git(['worktree', 'prune'], worktreePath);
  }
}

// =============================================================================
// Reporting
// =============================================================================

function describeBase(result: VerifyGateFailure): string {
  if (result.reason === 'base_conflict') return `merged with ${result.base}`;
  if (result.base && result.baseMerged) return `with ${result.base} merged in`;
  return 'on the task branch as it is (the latest base could not be merged in for this check)';
}

/** One line for the task log. */
export function describeVerifyGateResult(result: VerifyGateResult): string {
  switch (result.status) {
    case 'skipped':
      return 'Verify gate skipped: the project lists no verifyCommands in .aperant.json.';
    case 'passed':
      return `Verify gate passed${result.base && result.baseMerged ? ` against ${result.base}` : ''}.${
        result.notes.length > 0 ? ` ${result.notes.join(' ')}` : ''
      }`;
    case 'failed':
      return result.reason === 'base_conflict'
        ? `Verify gate failed: the task branch conflicts with ${result.base} in ${result.files.join(', ')}. QA approval withdrawn.`
        : `Verify gate failed: \`${result.command}\` did not pass ${describeBase(result)}. QA approval withdrawn.`;
  }
}

/** The issue recorded in qa_signoff / iteration history for a gate failure. */
export function verifyGateIssue(result: VerifyGateFailure): {
  type: 'critical';
  title: string;
  description: string;
  fix_required: string;
} {
  if (result.reason === 'base_conflict') {
    return {
      type: 'critical',
      title: `Verify gate: conflicts with ${result.base}`,
      description: `Merging ${result.base} into the task branch conflicts in: ${result.files.join(', ')}`,
      fix_required: `Merge ${result.base} into the task branch and resolve the conflicts`,
    };
  }
  return {
    type: 'critical',
    title: `Verify gate: ${result.command} failed`,
    description: `\`${result.command}\` failed ${describeBase(result)}`,
    fix_required: `Make \`${result.command}\` pass`,
  };
}

/** A code fence longer than any backtick run in the text, so output cannot close it. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** QA_FIX_REQUEST.md text, in the format the reviewer writes (prompts/qa_reviewer.md). */
export function buildVerifyGateFixRequest(result: VerifyGateFailure, date = new Date()): string {
  const header =
    `# QA Fix Request\n\n` +
    `**Status**: REJECTED\n` +
    `**Date**: ${date.toISOString()}\n` +
    `**Source**: Automated verify gate (\`verifyCommands\` in \`.aperant.json\`)\n\n` +
    `The QA reviewer approved this task, but the project's own checks did not pass, so the approval was withdrawn.\n\n` +
    `## Critical Issues to Fix\n\n`;

  let issue: string;
  if (result.reason === 'base_conflict') {
    const branch = result.base.replace(/^origin\//, '');
    issue =
      `### 1. Task branch conflicts with ${result.base}\n` +
      `**Problem**: ${result.base} has moved on since this task branched, and merging it conflicts.\n` +
      `**Location**: ${result.files.map((f) => `\`${f}\``).join(', ')}\n` +
      `**Required Fix**: Run \`git fetch origin ${branch}\` and \`git merge ${result.base}\` in the task worktree, ` +
      `resolve each conflict keeping the intent of both sides, run the verify commands, and commit the merge.\n` +
      `**Verification**: The verify gate merges ${result.base} again and runs every verify command.\n`;
  } else {
    const fence = fenceFor(result.outputTail);
    issue =
      `### 1. Verify command failed: \`${result.command}\`\n` +
      `**Problem**: \`${result.command}\` exited with an error ${describeBase(result)}.\n` +
      `**Location**: See the output below.\n` +
      `**Required Fix**: Fix the cause in the code so \`${result.command}\` passes. Do not skip, disable or weaken the check.\n` +
      `**Verification**: Run \`${result.command}\` yourself before committing; the verify gate re-runs every verify command after QA approves.\n\n` +
      `Output (last ${OUTPUT_TAIL_CHARS} characters):\n\n` +
      `${fence}text\n${result.outputTail.trimEnd()}\n${fence}\n`;
  }

  const notes = result.notes.length > 0 ? `\n## Notes\n\n${result.notes.map((n) => `- ${n}`).join('\n')}\n` : '';

  return (
    header +
    issue +
    notes +
    `\n## After Fixes\n\n` +
    `Once fixes are complete:\n` +
    `1. Commit with message: "fix: [description] (qa-requested)"\n` +
    `2. QA will automatically re-run\n` +
    `3. Loop continues until approved\n`
  );
}

export async function writeVerifyGateFixRequest(specDir: string, result: VerifyGateFailure): Promise<void> {
  await writeFile(join(specDir, 'QA_FIX_REQUEST.md'), buildVerifyGateFixRequest(result), 'utf-8');
}
