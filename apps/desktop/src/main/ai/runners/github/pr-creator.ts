/**
 * PR Creator Runner
 * =================
 *
 * Creates GitHub Pull Requests with AI-generated descriptions using Vercel AI SDK.
 * See apps/desktop/src/main/ai/runners/github/pr-creator.ts for the TypeScript implementation.
 *
 * Steps:
 * 1. Push the worktree branch to origin via git
 * 2. Gather diff/commit context from the branch
 * 3. Generate a semantic PR description via generateText
 * 4. Create the PR via `gh pr create`
 * 5. Return the PR URL and metadata
 *
 * Uses `createSimpleClient()` with no tools (single-turn text generation).
 */

import { generateText } from 'ai';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getAugmentedEnv } from '../../../env-utils';
import { createSimpleClient } from '../../client/factory';
import type { ModelShorthand, ThinkingLevel } from '../../config/types';

// =============================================================================
// Constants
// =============================================================================

const SYSTEM_PROMPT = `You are a senior software engineer writing a GitHub Pull Request description.
Write a clear, professional PR description that explains WHAT was changed, WHY it was changed, and HOW to test it.

Format your response in Markdown with these sections:
## Summary
(1-3 bullet points describing the main changes)

## Changes
(Bulleted list of specific changes made)

## Testing
(How to verify the changes work correctly)

Keep the description concise but informative. Focus on the business value and technical impact.
Do not include any preamble — output only the Markdown body.`;

/**
 * zeenha fork: every git/gh call here runs in the Electron MAIN process. They
 * used to be execFileSync with no timeout, so a slow push froze the whole UI
 * and a credential prompt hung the app for good. Now they are async, bounded,
 * and run with prompts disabled.
 */
export const PUSH_TIMEOUT_MS = 120_000;
export const GH_TIMEOUT_MS = 60_000;
const GIT_READ_TIMEOUT_MS = 30_000;

/** The only branches Create PR may push (worktree-manager.ts names them). */
const TASK_BRANCH_RE = /^auto-claude\/[A-Za-z0-9._\-/]+$/;

// =============================================================================
// Types
// =============================================================================

/** Configuration for PR creation */
export interface CreatePRConfig {
  /** Project root directory (main git repo) */
  projectDir: string;
  /** Worktree directory (where the branch lives) */
  worktreePath: string;
  /** Spec ID (e.g., "001-add-feature") */
  specId: string;
  /** Branch name to push and create PR from */
  branchName: string;
  /** Base branch to merge into (e.g., "main", "develop") */
  baseBranch: string;
  /** PR title */
  title: string;
  /** Whether to create as a draft PR */
  draft?: boolean;
  /** Path to the gh CLI executable */
  ghPath: string;
  /** Path to the git CLI executable */
  gitPath: string;
  /** Model shorthand (defaults to 'haiku') */
  modelShorthand?: ModelShorthand;
  /** Thinking level (defaults to 'low') */
  thinkingLevel?: ThinkingLevel;
}

/** Result of PR creation */
export interface CreatePRResult {
  success: boolean;
  prUrl?: string;
  alreadyExists?: boolean;
  /** zeenha fork: the task branch has no commits beyond its base (nothing to propose). */
  noChanges?: boolean;
  error?: string;
}

// =============================================================================
// Process helper
// =============================================================================

/** Failure of a bounded child process, with its output kept for messages. */
export class CommandError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
    readonly timedOut: boolean,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

/**
 * zeenha fork: environment for git and gh with the augmented PATH (GUI launches
 * do not inherit the shell's) and every interactive prompt switched off, so a
 * missing credential fails fast instead of waiting for input nobody can give.
 */
export function nonInteractiveEnv(): NodeJS.ProcessEnv {
  return {
    ...getAugmentedEnv(),
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GH_PROMPT_DISABLED: '1',
  };
}

/** Run a command asynchronously with a timeout; stdin is closed at once. */
function run(command: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { cwd, encoding: 'utf-8', timeout: timeoutMs, env: nonInteractiveEnv(), maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(String(stdout));
          return;
        }
        const timedOut = (error as { killed?: boolean }).killed === true;
        const name = command.split(/[\\/]/).pop() ?? command;
        const message = timedOut
          ? `${name} ${args.slice(0, name === 'gh' ? 2 : 1).join(' ')} timed out after ${Math.round(timeoutMs / 1000)}s ` +
            '(it may be waiting for credentials; interactive prompts are disabled)'
          : error.message;
        reject(new CommandError(message, String(stdout ?? ''), String(stderr ?? ''), timedOut));
      },
    );
    child.stdin?.end();
  });
}

// =============================================================================
// Context Gathering
// =============================================================================

/**
 * Gather diff and commit log context for the PR.
 * Mirrors Python's _gather_pr_context().
 */
/** zeenha fork: shown when the task branch has no commits beyond its base. */
export const NO_CHANGES_MESSAGE =
  'This task made no code changes, so there is nothing to put in a pull request. ' +
  'If its work was done outside the code (for example, running database migrations), mark the task as done.';

/**
 * zeenha fork: commits on HEAD that the base branch does not have, or null
 * when that cannot be determined (then Create PR proceeds as before).
 */
export async function commitsAheadOfBase(
  worktreePath: string,
  gitPath: string,
  baseBranch: string,
): Promise<number | null> {
  const base = baseBranch.replace(/^origin\//, '');
  for (const ref of [`origin/${base}`, base]) {
    try {
      const out = (await run(gitPath, ['rev-list', '--count', `${ref}..HEAD`], worktreePath, GIT_READ_TIMEOUT_MS)).trim();
      const count = Number.parseInt(out, 10);
      if (Number.isInteger(count) && count >= 0) return count;
    } catch {
      // try the next ref
    }
  }
  return null;
}

async function gatherPRContext(
  worktreePath: string,
  gitPath: string,
  baseBranch: string,
): Promise<{ diffSummary: string; commitLog: string }> {
  let diffSummary = '';
  let commitLog = '';

  try {
    diffSummary = (
      await run(gitPath, ['diff', '--stat', `origin/${baseBranch}...HEAD`], worktreePath, GIT_READ_TIMEOUT_MS)
    ).slice(0, 3000);
  } catch {
    try {
      // Fallback without "origin/" prefix
      diffSummary = (
        await run(gitPath, ['diff', '--stat', `${baseBranch}...HEAD`], worktreePath, GIT_READ_TIMEOUT_MS)
      ).slice(0, 3000);
    } catch {
      // Not fatal — proceed without diff
    }
  }

  try {
    commitLog = (
      await run(gitPath, ['log', '--oneline', `origin/${baseBranch}..HEAD`], worktreePath, GIT_READ_TIMEOUT_MS)
    ).slice(0, 2000);
  } catch {
    try {
      commitLog = (
        await run(gitPath, ['log', '--oneline', `${baseBranch}..HEAD`], worktreePath, GIT_READ_TIMEOUT_MS)
      ).slice(0, 2000);
    } catch {
      // Not fatal — proceed without commit log
    }
  }

  return { diffSummary, commitLog };
}

/**
 * Extract a brief summary from the spec file for fallback PR body.
 */
function extractSpecSummary(projectDir: string, specId: string): string {
  const specFile = join(projectDir, '.auto-claude', 'specs', specId, 'spec.md');
  if (!existsSync(specFile)) {
    return `Implements ${specId}`;
  }

  try {
    const content = readFileSync(specFile, 'utf-8');
    // Extract first ~500 chars after the title
    const withoutTitle = content.replace(/^#+[^\n]+\n/, '').trim();
    return withoutTitle.slice(0, 500) || `Implements ${specId}`;
  } catch {
    return `Implements ${specId}`;
  }
}

// =============================================================================
// AI PR Body Generation
// =============================================================================

/**
 * Generate a PR description using AI.
 * Mirrors Python's _try_ai_pr_body().
 */
async function generatePRBody(
  specId: string,
  title: string,
  baseBranch: string,
  branchName: string,
  diffSummary: string,
  commitLog: string,
  modelShorthand: ModelShorthand,
  thinkingLevel: ThinkingLevel,
): Promise<string | null> {
  const prompt = `Create a GitHub Pull Request description for the following change:

Task: ${title}
Spec ID: ${specId}
Branch: ${branchName}
Base branch: ${baseBranch}

Commit log:
${commitLog || '(no commits listed)'}

Diff summary:
${diffSummary || '(no diff available)'}

Write a professional PR description. Output ONLY the Markdown body — no preamble.`;

  try {
    const client = await createSimpleClient({
      systemPrompt: SYSTEM_PROMPT,
      modelShorthand,
      thinkingLevel,
    });

    const result = await generateText({
      model: client.model,
      system: client.systemPrompt,
      prompt,
    });

    return result.text.trim() || null;
  } catch {
    return null;
  }
}

// =============================================================================
// Push Branch
// =============================================================================

/**
 * Push the worktree branch to origin.
 * Returns an error string on failure, or undefined on success.
 *
 * zeenha fork: pushed with --force-with-lease. The merge queue sends a
 * conflicting PR back to be rebased, and a rebased task branch is not a
 * fast-forward of what was pushed before, so a plain push was rejected and
 * Create PR could never succeed again. The lease still refuses to overwrite
 * remote work this clone has not seen. Only the task's own `auto-claude/*`
 * branch is ever force-pushed: anything else is refused before git runs.
 */
async function pushBranch(
  worktreePath: string,
  gitPath: string,
  branchName: string,
): Promise<string | undefined> {
  const ref = `refs/heads/${branchName}`;
  try {
    await run(
      gitPath,
      ['push', '--force-with-lease', '--set-upstream', 'origin', `${ref}:${ref}`],
      worktreePath,
      PUSH_TIMEOUT_MS,
    );
    return undefined;
  } catch (err: unknown) {
    if (err instanceof CommandError) {
      if (err.timedOut) return err.message;
      return err.stderr || err.message || 'Push failed';
    }
    return String(err) || 'Push failed';
  }
}

// =============================================================================
// Get Existing PR URL
// =============================================================================

/**
 * Try to retrieve the URL of an existing PR for the branch.
 */
async function getExistingPRUrl(
  projectDir: string,
  ghPath: string,
  branchName: string,
  baseBranch: string,
): Promise<string | undefined> {
  try {
    const output = (
      await run(ghPath, ['pr', 'view', branchName, '--json', 'url', '--jq', '.url'], projectDir, GH_TIMEOUT_MS)
    ).trim();
    return output.startsWith('http') ? output : undefined;
  } catch {
    // Try alternative: list open PRs for this head
    try {
      const listOutput = (
        await run(
          ghPath,
          ['pr', 'list', '--head', branchName, '--base', baseBranch, '--json', 'url', '--jq', '.[0].url'],
          projectDir,
          GH_TIMEOUT_MS,
        )
      ).trim();
      return listOutput.startsWith('http') ? listOutput : undefined;
    } catch {
      return undefined;
    }
  }
}

// =============================================================================
// Main PR Creator
// =============================================================================

/**
 * Push a worktree branch and create a GitHub PR with an AI-generated description.
 *
 * @param config - PR creation configuration
 * @returns Result with PR URL or error details
 */
export async function createPR(config: CreatePRConfig): Promise<CreatePRResult> {
  const {
    projectDir,
    worktreePath,
    specId,
    branchName,
    baseBranch,
    title,
    draft = false,
    ghPath,
    gitPath,
    modelShorthand = 'haiku',
    thinkingLevel = 'low',
  } = config;

  // zeenha fork: Create PR force-pushes (with lease), so it must only ever
  // touch this task's own branch. Refuse anything else before git runs.
  if (branchName !== `auto-claude/${specId}` || !TASK_BRANCH_RE.test(branchName) || branchName.includes('..')) {
    return {
      success: false,
      error: `Refusing to push "${branchName}": Create PR only pushes the task's own branch (auto-claude/${specId}).`,
    };
  }

  // zeenha fork: a task can legitimately finish without changing code (e.g.
  // the fix was running database migrations). GitHub then refuses the PR with
  // "GraphQL: No commits between main and auto-claude/...", which reads like
  // a failure. Say what happened before pushing anything.
  const ahead = await commitsAheadOfBase(worktreePath, gitPath, baseBranch);
  if (ahead === 0) {
    return {
      success: false,
      noChanges: true,
      error: NO_CHANGES_MESSAGE,
    };
  }

  // Step 1: Push the branch to origin
  const pushError = await pushBranch(worktreePath, gitPath, branchName);
  if (pushError) {
    // If it looks like the branch is already up-to-date, don't bail
    const isUpToDate = pushError.includes('Everything up-to-date') ||
                       pushError.includes('up to date');
    if (!isUpToDate) {
      return { success: false, error: `Failed to push branch: ${pushError}` };
    }
  }

  // Step 2: Gather context for AI description
  const { diffSummary, commitLog } = await gatherPRContext(worktreePath, gitPath, baseBranch);

  // Step 3: Generate AI PR body (falls back to spec summary on failure)
  const aiBody = await generatePRBody(
    specId,
    title,
    baseBranch,
    branchName,
    diffSummary,
    commitLog,
    modelShorthand,
    thinkingLevel,
  );

  const prBody = aiBody || extractSpecSummary(projectDir, specId);

  // Step 4: Strip remote prefix from base branch if present
  const effectiveBase = baseBranch.startsWith('origin/')
    ? baseBranch.slice('origin/'.length)
    : baseBranch;

  // Step 5: Build gh pr create command
  const ghArgs = [
    'pr', 'create',
    '--base', effectiveBase,
    '--head', branchName,
    '--title', title,
    '--body', prBody,
  ];

  if (draft) {
    ghArgs.push('--draft');
  }

  // Step 6: Execute gh pr create with retry on network errors
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const output = (await run(ghPath, ghArgs, projectDir, GH_TIMEOUT_MS)).trim();

      // Extract PR URL from output
      let prUrl: string | undefined;
      if (output.startsWith('http')) {
        prUrl = output;
      } else {
        const match = output.match(/https:\/\/[^\s]+\/pull\/\d+/);
        prUrl = match ? match[0] : undefined;
      }

      return { success: true, prUrl, alreadyExists: false };
    } catch (err: unknown) {
      const spawnErr = err as Partial<CommandError> & { message?: string };
      const stderr = String(spawnErr.stderr ?? '');
      const stdout = String(spawnErr.stdout ?? '');

      // zeenha fork: a timed-out create is ambiguous (the PR may exist) and
      // retrying it could hang the same way, so report it plainly.
      if (spawnErr.timedOut) {
        return { success: false, error: spawnErr.message ?? 'gh pr create timed out' };
      }

      // Check "already exists" — not a failure
      if (stderr.toLowerCase().includes('already exists') || stdout.toLowerCase().includes('already exists')) {
        const existingUrl = await getExistingPRUrl(projectDir, ghPath, branchName, effectiveBase);
        return { success: true, prUrl: existingUrl, alreadyExists: true };
      }

      // Check if retryable (network / 5xx errors)
      const isNetworkError = /timeout|connection|network|ECONNRESET|ECONNREFUSED/i.test(stderr);
      const isServerError = /5\d\d|server error|internal error/i.test(stderr);

      if ((isNetworkError || isServerError) && attempt < 2) {
        // Exponential backoff before retry
        await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 2000));
        continue;
      }

      // Non-retryable error — return failure
      const errorMessage = stderr || stdout || String(spawnErr.message) || 'Failed to create PR';
      return { success: false, error: errorMessage };
    }
  }

  return { success: false, error: 'PR creation failed after 3 attempts' };
}
