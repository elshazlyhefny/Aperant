/**
 * Bash Command Tool
 * =================
 *
 * Executes bash commands with security validation.
 * Integrates with bashSecurityHook() for pre-execution denylist checks and
 * per-command validation (a guardrail, not a sandbox).
 *
 * NOTE: Commands run via execFile in the task cwd with the user's permissions
 * and are NOT covered by path-containment.ts. The child process gets a scrubbed
 * environment (credential variables removed), and the real isolation control is
 * the opt-in OS sandbox (bubblewrap/sandbox-exec).
 * Supports timeouts, background execution, and descriptive metadata.
 */

import { execFile } from 'node:child_process';
import { z } from 'zod/v3';

import { findExecutable, isWindows, killProcessGracefully } from '../../../platform/index';
import { buildChildEnv } from '../../security/child-env';
import { bashSecurityHook } from '../../security/bash-validator';
import { parseSandboxMode, wrapForSandbox } from '../../security/sandbox';
import { Tool } from '../define';
import { ToolPermission } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_LENGTH = 30_000;

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  command: z.string().describe('The bash command to execute'),
  timeout: z
    .number()
    .optional()
    .describe('Optional timeout in milliseconds (max 600000)'),
  run_in_background: z
    .boolean()
    .optional()
    .describe('Set to true to run this command in the background'),
  description: z
    .string()
    .optional()
    .describe('Clear, concise description of what this command does'),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_LENGTH) {
    return output;
  }
  return `${output.slice(0, MAX_OUTPUT_LENGTH)}\n\n[Output truncated — ${output.length} characters total]`;
}

function resolveShell(): string {
  if (isWindows()) {
    // Prefer Git Bash on Windows; fall back to cmd.exe
    return findExecutable('bash') ?? (process.env.ComSpec || 'cmd.exe');
  }
  return '/bin/bash';
}

function buildShellInvocation(command: string): { shell: string; args: string[] } {
  const shell = resolveShell();
  const args = isWindows() && shell.toLowerCase().endsWith('cmd.exe')
    ? ['/c', command]
    : ['-c', command];
  return { shell, args };
}

function executeCommand(
  shell: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  abortSignal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      shell,
      args,
      {
        cwd,
        env,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        signal: abortSignal,
      },
      (error, stdout, stderr) => {
        const exitCode = error
          ? ('code' in error && typeof error.code === 'number'
              ? error.code
              : 1)
          : 0;
        resolve({
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
          exitCode,
        });
      },
    );

    // Ensure the child process is killed on abort
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        killProcessGracefully(child);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const bashTool = Tool.define({
  metadata: {
    name: 'Bash',
    description:
      'Executes a given bash command with optional timeout. Use for git operations, command execution, and other terminal tasks.',
    permission: ToolPermission.RequiresApproval,
    executionOptions: {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      allowBackground: true,
    },
  },
  inputSchema,
  execute: async (input, context) => {
    const { command, timeout, run_in_background } = input;

    // Security: validate command against security profile via bashSecurityHook
    const hookResult = bashSecurityHook(
      {
        toolName: 'Bash',
        toolInput: { command },
        cwd: context.cwd,
      },
      context.securityProfile,
    );

    if ('hookSpecificOutput' in hookResult) {
      const reason = hookResult.hookSpecificOutput.permissionDecisionReason;
      return `Error: Command not allowed — ${reason}`;
    }

    const timeoutMs = Math.min(timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    // zeenha fork: commands run without credential variables unless the project allows them.
    const env = buildChildEnv(process.env, {
      passthrough: context.securityProfile.envPassthrough,
    });

    let { shell, args } = buildShellInvocation(command);

    // zeenha fork: optionally hide the home directory from the command. Fails
    // closed (also for background runs) when the sandbox cannot be built.
    const sandboxMode = parseSandboxMode(context.securityProfile.bashSandbox);
    if (sandboxMode !== 'off') {
      const wrapped = wrapForSandbox(shell, args, {
        mode: sandboxMode,
        cwd: context.cwd,
        projectDir: context.projectDir,
        writablePaths: [context.specDir],
      });
      if (!wrapped.ok) {
        return `Error: Sandbox unavailable — ${wrapped.reason}`;
      }
      shell = wrapped.file;
      args = wrapped.args;
    }

    if (run_in_background) {
      // Fire-and-forget for background commands
      executeCommand(shell, args, context.cwd, timeoutMs, env, context.abortSignal);
      return `Command started in background: ${command}`;
    }

    const { stdout, stderr, exitCode } = await executeCommand(
      shell,
      args,
      context.cwd,
      timeoutMs,
      env,
      context.abortSignal,
    );

    const parts: string[] = [];

    if (stdout) {
      parts.push(truncateOutput(stdout));
    }

    if (stderr) {
      parts.push(`STDERR:\n${truncateOutput(stderr)}`);
    }

    if (exitCode !== 0) {
      parts.push(`Exit code: ${exitCode}`);
    }

    return parts.length > 0 ? parts.join('\n') : '(no output)';
  },
});
