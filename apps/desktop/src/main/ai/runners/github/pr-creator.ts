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
import type { WorktreeCreatePRErrorCode } from '../../../../shared/types';
import { capPRTitle } from '../../../../shared/utils/pr-title';

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
(What was verified and how a reviewer can re-check it)

Keep the description concise but informative. Focus on the business value and technical impact.
For Testing, use only what you are given:
- Report what the QA report says was run and its result, including anything it says was not run.
- Write a command only if it appears in the project conventions or the QA report, exactly as written there (for example through the project's container or test script). Never invent setup or test commands, and never fall back to generic ones such as running php, composer, npm or artisan directly.
- If neither tells you how to run something, name the tests that were added or changed and leave the command out.
Do not include any preamble — output only the Markdown body.`;

/** zeenha fork: caps on what the PR body model is given from the project. */
const MAX_CONVENTIONS_CHARS = 6_000;
const MAX_QA_REPORT_CHARS = 5_000;
const CONVENTION_HEADING_RE = /\b(run|running|test|tests|testing|commands?|develop|development|setup|docker|verif\w*)\b/i;

/**
 * zeenha fork: the sections of a project instructions file (AGENTS.md or
 * CLAUDE.md) whose `##`/`###` heading is about running or testing things. The
 * body model used to see only the commit log and diff stat, so its Testing
 * section was generic: PR #219 told reviewers to run `php artisan migrate`
 * on the host, which that project forbids (everything runs in Docker).
 * Exported for tests.
 */
export function extractConventionSections(markdown: string): string {
  const sections: string[] = [];
  let current: string[] | null = null;
  let currentLevel = 0;
  for (const line of markdown.split('\n')) {
    const heading = line.match(/^(#{2,3})\s+(.*)$/);
    if (heading && (current === null || heading[1].length <= currentLevel)) {
      if (current) sections.push(current.join('\n').trim());
      current = CONVENTION_HEADING_RE.test(heading[2]) ? [line] : null;
      currentLevel = heading[1].length;
      continue;
    }
    current?.push(line);
  }
  if (current) sections.push(current.join('\n').trim());
  return sections.join('\n\n').slice(0, MAX_CONVENTIONS_CHARS).trim();
}

function readCapped(file: string, max: number): string {
  try {
    return readFileSync(file, 'utf-8').slice(0, max).trim();
  } catch {
    return '';
  }
}

/** The branch's own AGENTS.md or CLAUDE.md, reduced to its running/testing sections. */
function readProjectConventions(worktreePath: string): string {
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const file = join(worktreePath, name);
    if (!existsSync(file)) continue;
    const sections = extractConventionSections(readFileSync(file, 'utf-8'));
    if (sections) return sections;
  }
  return '';
}

/** The task's QA report: the worktree's copy, else the main project's. */
function readQAReport(worktreePath: string, projectDir: string, specId: string): string {
  for (const root of [worktreePath, projectDir]) {
    const report = readCapped(join(root, '.auto-claude', 'specs', specId, 'qa_report.md'), MAX_QA_REPORT_CHARS);
    if (report) return report;
  }
  return '';
}

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
  /**
   * PR title the person typed. When absent, the title is suggested by the
   * model from the branch AFTER pending work is committed, then falls back to
   * `fallbackTitle`.
   */
  title?: string;
  /** zeenha fork: used when no title was typed and no usable suggestion came back. */
  fallbackTitle?: string;
  /** zeenha fork: the task's own title, given to the model when suggesting one. */
  taskTitle?: string;
  /** zeenha fork: subtask counts from the task's plan, when it has one. */
  subtaskProgress?: { completed: number; total: number };
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
  /** Machine-readable failure reason; only set on failures. */
  errorCode?: WorktreeCreatePRErrorCode;
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
function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        cwd,
        encoding: 'utf-8',
        timeout: timeoutMs,
        env: extraEnv ? { ...nonInteractiveEnv(), ...extraEnv } : nonInteractiveEnv(),
        maxBuffer: 10 * 1024 * 1024,
      },
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
/** A short, readable reason from a failed git call. */
function describeError(err: unknown): string {
  if (err instanceof CommandError) {
    return (err.stderr.trim() || err.stdout.trim() || err.message).slice(0, 400);
  }
  return err instanceof Error ? err.message : String(err);
}

/** Aperant's own task files: never part of a PR. */
const TASK_FILES_DIR = '.auto-claude';

/** `git status --porcelain` lines for anything but Aperant's own task files. */
function workChanges(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter((line) => line.trim() !== '')
    .filter((line) => {
      const path = line.slice(3).replace(/^"/, '');
      return path !== TASK_FILES_DIR && !path.startsWith(`${TASK_FILES_DIR}/`);
    });
}

/**
 * zeenha fork: commit uncommitted work in the task worktree. Returns an
 * error message, or null when there was nothing to commit or it committed.
 *
 * Stage everything, then unstage .auto-claude. An exclude pathspec
 * (`:(exclude).auto-claude`) cannot be used: when .auto-claude is gitignored,
 * `git add` fails with "paths are ignored" because the pathspec names it.
 */
export async function commitPendingWork(
  worktreePath: string,
  gitPath: string,
  message: string,
): Promise<string | null> {
  try {
    const status = await run(gitPath, ['status', '--porcelain'], worktreePath, GIT_READ_TIMEOUT_MS);
    if (workChanges(status).length === 0) return null;
    await run(gitPath, ['add', '-A', '--', '.'], worktreePath, GIT_READ_TIMEOUT_MS);
    await run(gitPath, ['reset', '-q', '--', TASK_FILES_DIR], worktreePath, GIT_READ_TIMEOUT_MS);
    const staged = await run(gitPath, ['diff', '--cached', '--name-only'], worktreePath, GIT_READ_TIMEOUT_MS);
    if (staged.trim() === '') return null;
    await run(gitPath, ['commit', '-m', message], worktreePath, PUSH_TIMEOUT_MS);
    return null;
  } catch (err) {
    return describeError(err);
  }
}

/** zeenha fork: shown when the task branch has no commits beyond its base. */
export const NO_CHANGES_MESSAGE =
  'This task made no code changes, so there is nothing to put in a pull request. ' +
  'If its work was done outside the code (for example, running database migrations), mark the task as done.';

/**
 * zeenha fork: shown instead of NO_CHANGES_MESSAGE when the plan still has
 * unfinished subtasks. A task that was stopped (or stalled) before writing
 * code is not one whose work happened outside the code, so it must not be
 * told to mark itself done.
 */
export function unfinishedTaskMessage(completed: number, total: number): string {
  return (
    `This task stopped after ${completed} of ${total} subtasks and has made no code changes yet, ` +
    'so there is nothing to put in a pull request. Resume the task to finish its work. ' +
    'Do not mark it as done: the work it was created for has not been done.'
  );
}

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
 * zeenha fork: work the coder left in the task worktree without committing it,
 * for the title suggestion. Strictly read-only: nothing is staged or committed
 * (the person has not confirmed the PR yet), and GIT_OPTIONAL_LOCKS=0 stops
 * `git status` from rewriting the index. Aperant's own .auto-claude files are
 * left out, and gitignored files never appear (status does not list them).
 * Empty strings when there is nothing uncommitted or git cannot answer.
 */
export async function gatherUncommittedContext(
  worktreePath: string,
  gitPath: string,
): Promise<{ uncommittedDiff: string; untrackedFiles: string }> {
  const readOnly = { GIT_OPTIONAL_LOCKS: '0' };
  let changes: string[];
  try {
    const status = await run(
      gitPath,
      ['status', '--porcelain', '--untracked-files=all'],
      worktreePath,
      GIT_READ_TIMEOUT_MS,
      readOnly,
    );
    changes = workChanges(status);
  } catch {
    return { uncommittedDiff: '', untrackedFiles: '' };
  }
  if (changes.length === 0) return { uncommittedDiff: '', untrackedFiles: '' };

  const untracked = changes.filter((line) => line.startsWith('?? ')).map((line) => line.slice(3));
  const untrackedFiles = untracked.join('\n').slice(0, 2000);

  let uncommittedDiff = '';
  if (untracked.length < changes.length) {
    try {
      // The exclude pathspec is safe here: unlike `git add`, `git diff` does
      // not refuse a pathspec that names an ignored directory.
      uncommittedDiff = (
        await run(
          gitPath,
          ['diff', '--stat', 'HEAD', '--', '.', `:(exclude)${TASK_FILES_DIR}`],
          worktreePath,
          GIT_READ_TIMEOUT_MS,
          readOnly,
        )
      ).slice(0, 3000);
    } catch {
      // Not fatal — proceed with the untracked names alone
    }
  }
  return { uncommittedDiff, untrackedFiles };
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
export interface PRBodyContext {
  specId: string;
  title: string;
  baseBranch: string;
  branchName: string;
  diffSummary: string;
  commitLog: string;
  /** zeenha fork: running/testing sections of the project's instructions file */
  conventions: string;
  /** zeenha fork: the task's qa_report.md */
  qaReport: string;
}

/** Exported for tests. */
export function buildPRBodyPrompt(ctx: PRBodyContext): string {
  return `Create a GitHub Pull Request description for the following change:

Task: ${ctx.title}
Spec ID: ${ctx.specId}
Branch: ${ctx.branchName}
Base branch: ${ctx.baseBranch}

Commit log:
${ctx.commitLog || '(no commits listed)'}

Diff summary:
${ctx.diffSummary || '(no diff available)'}

Project conventions for running and testing (from the repository's instructions file):
${ctx.conventions || '(none found: do not write any commands)'}

QA report for this task:
${ctx.qaReport || '(no QA report: say that verification was not recorded)'}

Write a professional PR description. Output ONLY the Markdown body — no preamble.`;
}

async function generatePRBody(
  ctx: PRBodyContext,
  modelShorthand: ModelShorthand,
  thinkingLevel: ThinkingLevel,
): Promise<string | null> {
  const prompt = buildPRBodyPrompt(ctx);

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
// AI PR Title Suggestion (zeenha fork)
// =============================================================================

/**
 * zeenha fork: PR titles used to be the raw task title ("Make 'Add to cart'
 * confirmation actionable: a View cart link in the toast and visible feedback
 * on the cart badge"). The model that writes the body now also proposes a
 * short Conventional Commits title, which the Create PR dialog pre-fills and
 * the person can still edit. Any answer that is not one clean line of the
 * expected shape is discarded and the task title is used instead.
 */
export const MAX_SUGGESTED_PR_TITLE_LENGTH = 72;

const CONVENTIONAL_TITLE_RE =
  /^(feat|fix|perf|refactor|docs|test|chore|build|ci|style|revert)(\([a-z0-9][a-z0-9._/-]*\))?!?: \S/;

const TITLE_SYSTEM_PROMPT = `You write GitHub pull request titles in the Conventional Commits style.
Output exactly ONE line and nothing else, shaped: type(scope): summary
- type is one of: feat, fix, perf, refactor, docs, test, chore, build, ci, style, revert
- scope is optional: one short lowercase word for the area changed (for example shop, pos, dashboard, auth, billing, booking)
- summary is imperative ("add", "fix", "keep"), starts lowercase, has no trailing period, and says what changed specifically
- at most ${MAX_SUGGESTED_PR_TITLE_LENGTH} characters in total
No quotes, no backticks, no preamble, no explanation.`;

/**
 * Accept a model answer only if it is a usable title; otherwise null.
 * Exported for tests.
 */
export function normalizeSuggestedPRTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const firstLine = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const line = firstLine
    .replace(/^(pr\s+)?title:\s*/i, '')
    .replace(/^[`"'*]+|[`"'*]+$/g, '')
    .trim()
    .replace(/\.+$/, '');
  if (!line || line.length > MAX_SUGGESTED_PR_TITLE_LENGTH) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(line)) return null;
  if (!CONVENTIONAL_TITLE_RE.test(line)) return null;
  return line;
}

/** Ask the model for a title from the task and its changes. Null when unusable. */
export async function suggestPRTitle(options: {
  taskTitle: string;
  specId: string;
  diffSummary: string;
  commitLog: string;
  /** zeenha fork: `git diff --stat HEAD` of work not committed yet. */
  uncommittedDiff?: string;
  /** zeenha fork: new files not committed yet, one per line. */
  untrackedFiles?: string;
  modelShorthand?: ModelShorthand;
  thinkingLevel?: ThinkingLevel;
}): Promise<string | null> {
  const { taskTitle, specId, diffSummary, commitLog, modelShorthand = 'haiku', thinkingLevel = 'low' } = options;
  const uncommittedDiff = options.uncommittedDiff?.trim() ?? '';
  const untrackedFiles = options.untrackedFiles?.trim() ?? '';
  const uncommitted =
    uncommittedDiff || untrackedFiles
      ? `

Uncommitted changes (part of this pull request; they are committed when it is created):
${uncommittedDiff || '(no changes to existing files)'}

New files not committed yet:
${untrackedFiles || '(none)'}`
      : '';
  const prompt = `Task: ${taskTitle}
Spec ID: ${specId}

Commit log:
${commitLog || '(no commits listed)'}

Diff summary:
${diffSummary || '(no diff available)'}${uncommitted}

Write the pull request title.`;

  // zeenha fork: bounded. Create PR without a typed title (the bulk dialog)
  // awaits this before opening the PR, and a stalled model request never
  // throws, so it used to hold the PR forever instead of falling back to the
  // task title.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, PR_TITLE_TIMEOUT_MS);
  });
  const ask = (async () => {
    try {
      const client = await createSimpleClient({ systemPrompt: TITLE_SYSTEM_PROMPT, modelShorthand, thinkingLevel });
      const result = await generateText({ model: client.model, system: client.systemPrompt, prompt, abortSignal: controller.signal });
      return normalizeSuggestedPRTitle(result.text);
    } catch {
      return null;
    }
  })();
  try {
    return await Promise.race([ask, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** zeenha fork: the longest a PR title suggestion may take before the task title is used. */
export const PR_TITLE_TIMEOUT_MS = 30_000;

/**
 * Suggest a title for a task's worktree: gathers the same commit log and diff
 * summary the body uses, plus the work the coder left uncommitted (Create PR
 * commits it only once the person confirms), then asks the model. Read-only
 * on the repository: it never stages or commits.
 */
export async function suggestPRTitleForWorktree(options: {
  worktreePath: string;
  gitPath: string;
  baseBranch: string;
  taskTitle: string;
  specId: string;
}): Promise<string | null> {
  const { diffSummary, commitLog } = await gatherPRContext(options.worktreePath, options.gitPath, options.baseBranch);
  const { uncommittedDiff, untrackedFiles } = await gatherUncommittedContext(options.worktreePath, options.gitPath);
  return suggestPRTitle({
    taskTitle: options.taskTitle,
    specId: options.specId,
    diffSummary,
    commitLog,
    uncommittedDiff,
    untrackedFiles,
  });
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
export async function pushBranch(
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
    title: typedTitle,
    fallbackTitle,
    taskTitle,
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
      errorCode: 'BRANCH_REFUSED',
      error: `Refusing to push "${branchName}": Create PR only pushes the task's own branch (auto-claude/${specId}).`,
    };
  }

  // zeenha fork: a task can legitimately finish without changing code (e.g.
  // the fix was running database migrations). GitHub then refuses the PR with
  // "GraphQL: No commits between main and auto-claude/...", which reads like
  // a failure. Say what happened before pushing anything.
  // zeenha fork: the coder is told to commit after each subtask but does not
  // always do it, so finished work can sit uncommitted in the worktree. Commit
  // it (never Aperant's own .auto-claude files) before anything is counted or
  // pushed; otherwise the PR would be empty or refused.
  const typed = typedTitle?.trim() ? typedTitle : undefined;
  const fallback = typed ?? (capPRTitle(fallbackTitle) || `auto-claude: ${specId}`);
  const commitError = await commitPendingWork(worktreePath, gitPath, fallback);
  if (commitError) {
    return { success: false, errorCode: 'COMMIT_FAILED', error: `Could not commit the task's changes: ${commitError}` };
  }

  const ahead = await commitsAheadOfBase(worktreePath, gitPath, baseBranch);
  if (ahead === 0) {
    const progress = config.subtaskProgress;
    const unfinished = progress !== undefined && progress.total > 0 && progress.completed < progress.total;
    return {
      success: false,
      noChanges: true,
      errorCode: 'NO_CHANGES',
      error: unfinished ? unfinishedTaskMessage(progress.completed, progress.total) : NO_CHANGES_MESSAGE,
    };
  }

  // zeenha fork: the title is suggested only now, from the committed branch.
  // It used to be asked for before commitPendingWork, so work the coder left
  // uncommitted was invisible to the model, which could see no changes at all.
  const { diffSummary, commitLog } = await gatherPRContext(worktreePath, gitPath, baseBranch);
  const title =
    typed ??
    (await suggestPRTitle({ taskTitle: taskTitle?.trim() ? taskTitle : fallback, specId, diffSummary, commitLog })) ??
    fallback;

  // Step 1: Push the branch to origin
  const pushError = await pushBranch(worktreePath, gitPath, branchName);
  if (pushError) {
    // If it looks like the branch is already up-to-date, don't bail
    const isUpToDate = pushError.includes('Everything up-to-date') ||
                       pushError.includes('up to date');
    if (!isUpToDate) {
      return { success: false, errorCode: 'PUSH_FAILED', error: `Failed to push branch: ${pushError}` };
    }
  }

  // Step 2: the context gathered above (pushing does not change it)

  // Step 3: Generate AI PR body (falls back to spec summary on failure)
  const aiBody = await generatePRBody(
    {
      specId,
      title,
      baseBranch,
      branchName,
      diffSummary,
      commitLog,
      conventions: readProjectConventions(worktreePath),
      qaReport: readQAReport(worktreePath, projectDir, specId),
    },
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
        return { success: false, errorCode: 'GH_TIMEOUT', error: spawnErr.message ?? 'gh pr create timed out' };
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
      return { success: false, errorCode: 'GH_FAILED', error: errorMessage };
    }
  }

  return { success: false, errorCode: 'RETRIES_EXHAUSTED', error: 'PR creation failed after 3 attempts' };
}
