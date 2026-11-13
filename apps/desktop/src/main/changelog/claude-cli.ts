/**
 * zeenha fork: safe spawn of the Claude CLI for changelog generation.
 *
 * The prompt contains user-controlled text (task titles, commit messages), so it
 * is NEVER placed on the command line: it is written to stdin. The argv is fixed.
 * No shell is used (shell: false), which avoids CWE-78 / BatBadBut injection on
 * Windows where .cmd/.bat files are run through an explicit cmd.exe invocation.
 */

import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { isWindows } from '../platform';
import { isSecurePath } from '../utils/windows-paths';

const FIXED_ARGS = ['-p', '--output-format', 'text', '--model', 'haiku'] as const;

export interface ClaudeInvocationPlan {
  file: string;
  args: string[];
  options: {
    shell: false;
    windowsHide: true;
    stdio: ['pipe', 'pipe', 'pipe'];
    windowsVerbatimArguments?: true;
  };
}

/** Pure: decide how to execute the Claude CLI. Throws for insecure Windows .cmd/.bat paths. */
export function planClaudeInvocation(claudePath: string, args: readonly string[] = FIXED_ARGS): ClaudeInvocationPlan {
  const trimmed = claudePath.trim();
  const unquoted =
    trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
  const base = { shell: false as const, windowsHide: true as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };

  if (isWindows() && /\.(cmd|bat)$/i.test(unquoted)) {
    if (!isSecurePath(unquoted)) {
      throw new Error(`Claude CLI path failed security validation: ${unquoted}`);
    }
    const cmdExe =
      process.env.ComSpec ||
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    return {
      file: cmdExe,
      args: ['/d', '/s', '/c', `""${unquoted}" ${args.join(' ')}"`],
      options: { ...base, windowsVerbatimArguments: true },
    };
  }

  return { file: unquoted, args: [...args], options: base };
}

export interface SpawnClaudeOptions {
  claudePath: string;
  prompt: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Spawn the Claude CLI and feed the prompt through stdin. */
export function spawnClaudeWithPrompt({ claudePath, prompt, cwd, env }: SpawnClaudeOptions): ChildProcess {
  const plan = planClaudeInvocation(claudePath);
  const child = spawn(plan.file, plan.args, { ...plan.options, cwd, env });

  if (child.stdin) {
    // EPIPE when the CLI exits before reading the prompt must not crash the main process
    child.stdin.on('error', () => {
      // intentionally ignored; process exit/close handlers report failures
    });
    child.stdin.write(prompt, 'utf-8');
    child.stdin.end();
  }
  return child;
}
