/**
 * Landing Policy Validator
 * ========================
 *
 * zeenha fork: when a project lands work through pull requests only
 * (`project.settings.prOnlyLanding`, on by default), an agent must not be able
 * to put work on the base branch itself. The app's own merge buttons are
 * guarded in the main process; this closes the other door, the agent's Bash
 * tool:
 *
 * - `git push` is allowed only to an explicit `auto-claude/*` destination
 *   (the task branch, see worktree-manager.ts). A push with no refspec, to
 *   `HEAD` alone, to any other branch, a tag, a wildcard, `--all`,
 *   `--mirror`, `--tags` or `--prune` is refused. Deletes (`--delete`,
 *   `:ref`) and force pushes are therefore also confined to `auto-claude/*`.
 * - `git send-pack`, `git subtree push` and git aliases defined through
 *   `-c alias.*` / `git config alias.*` are refused (each can push past the
 *   refspec check).
 * - `gh pr merge`, `gh repo sync`, `gh alias set|import`, and `gh api` calls
 *   that merge or move a ref (REST merge/refs/contents writes, GraphQL merge
 *   or ref mutations) are refused.
 *
 * The whole command string is parsed here, not the first segment the generic
 * validator picks, so chaining (`cd x && git push origin main`), env prefixes,
 * wrappers (`env`, `nohup`, `xargs`, ...), `git -C dir push`, `sh -c "..."`,
 * `eval` and `$(...)` are all seen.
 *
 * This is a guardrail on the agent's shell, not a sandbox: a script file the
 * agent writes and runs, an interpreter one-liner (`python -c`), a raw HTTP
 * call to the GitHub API, or a git alias already present in the repository
 * config is not visible to it.
 */

import type { ValidationResult } from '../denylist';

/** Task branches are `auto-claude/{specId}` (worktree-manager.ts). */
const TASK_BRANCH_PREFIX = 'auto-claude/';
const TASK_BRANCH_RE = /^auto-claude\/[A-Za-z0-9._\-/]+$/;

const MAX_DEPTH = 8;

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
const RESERVED_WORDS = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time']);

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

interface Lexed {
  /** Simple commands, each a list of words with quotes removed. */
  commands: string[][];
  /** Command text found inside `$(...)`, backticks, `<(...)` and here-strings. */
  nested: string[];
}

/**
 * Find the index just past the `)` closing a `(` at `start - 1`.
 * Quote-aware enough for nested substitutions; returns input length if open.
 */
function findClosingParen(input: string, start: number): number {
  let depth = 1;
  let i = start;
  let inSingle = false;
  let inDouble = false;
  while (i < input.length) {
    const ch = input[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
    } else if (inDouble) {
      if (ch === '\\') i++;
      else if (ch === '"') inDouble = false;
    } else if (ch === '\\') {
      i++;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return input.length;
}

function lex(input: string): Lexed {
  const commands: string[][] = [];
  const nested: string[] = [];
  let words: string[] = [];
  let current = '';
  let hasWord = false;
  let skipNextWord = false;
  let captureNextWord = false;
  let inSingle = false;
  let inDouble = false;

  const finishWord = (): void => {
    if (!hasWord) return;
    if (captureNextWord) {
      nested.push(current);
      captureNextWord = false;
    } else if (skipNextWord) {
      skipNextWord = false;
    } else {
      words.push(current);
    }
    current = '';
    hasWord = false;
  };
  const finishCommand = (): void => {
    finishWord();
    if (words.length > 0) commands.push(words);
    words = [];
    skipNextWord = false;
    captureNextWord = false;
  };

  let i = 0;
  while (i < input.length) {
    const ch = input[i];

    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
      i++;
      continue;
    }

    if (ch === '$' && input[i + 1] === '(' ) {
      const end = findClosingParen(input, i + 2);
      nested.push(input.slice(i + 2, Math.max(i + 2, end - 1)));
      current += input.slice(i, end);
      hasWord = true;
      i = end;
      continue;
    }
    if (ch === '`') {
      const end = input.indexOf('`', i + 1);
      const stop = end === -1 ? input.length : end;
      nested.push(input.slice(i + 1, stop));
      current += input.slice(i, stop + 1);
      hasWord = true;
      i = stop + 1;
      continue;
    }

    if (inDouble) {
      if (ch === '\\' && i + 1 < input.length) {
        current += input[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      else current += ch;
      i++;
      continue;
    }

    if (ch === '\\') {
      if (input[i + 1] === '\n') {
        i += 2; // line continuation
        continue;
      }
      if (i + 1 < input.length) current += input[i + 1];
      hasWord = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      hasWord = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      hasWord = true;
      i++;
      continue;
    }
    if (ch === '#' && !hasWord) {
      while (i < input.length && input[i] !== '\n') i++;
      continue;
    }
    if ((ch === '<' || ch === '>') && input[i + 1] === '(') {
      finishWord();
      const end = findClosingParen(input, i + 2);
      nested.push(input.slice(i + 2, Math.max(i + 2, end - 1)));
      i = end;
      continue;
    }
    if (ch === '<' || ch === '>' || (ch === '&' && input[i + 1] === '>')) {
      // A redirection: drop an fd number written just before it, and the
      // target word after it, so neither is read as an argument.
      if (hasWord && /^\d+$/.test(current)) {
        current = '';
        hasWord = false;
      } else {
        finishWord();
      }
      let op = '';
      while (i < input.length && (input[i] === '<' || input[i] === '>' || input[i] === '&')) {
        op += input[i];
        i++;
      }
      if (op.endsWith('&') && /[\d-]/.test(input[i] ?? '')) {
        while (i < input.length && /[\d-]/.test(input[i])) i++;
        continue; // `2>&1`: target already consumed
      }
      if (op === '<<<') captureNextWord = true;
      else skipNextWord = true;
      continue;
    }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '\n' || ch === '(' || ch === ')') {
      finishCommand();
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      finishWord();
      i++;
      continue;
    }
    current += ch;
    hasWord = true;
    i++;
  }
  finishCommand();
  return { commands, nested };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function refuse(what: string): ValidationResult {
  return [
    false,
    `BLOCKED: This project lands work through pull requests only.\n\n` +
      `${what}\n\n` +
      `WHAT TO DO: Push only your task branch, naming it as the destination, e.g. ` +
      `\`git push -u origin HEAD:${TASK_BRANCH_PREFIX}<spec-id>\` (use --force-with-lease ` +
      `after a rebase). Never push to or merge into the base branch: open a pull request ` +
      `and the project's merge queue lands it.`,
  ];
}

const ALLOW: ValidationResult = [true, ''];

function basename(word: string): string {
  const parts = word.split('/');
  return parts[parts.length - 1] ?? word;
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']);

/** Is `ref` a push destination this policy allows? */
function isTaskDestination(ref: string): boolean {
  const name = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
  return TASK_BRANCH_RE.test(name) && !name.includes('..') && !name.includes('*');
}

const PUSH_OPTIONS_WITH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
const PUSH_REFUSED_FLAGS = new Set(['--all', '--branches', '--mirror', '--tags', '--prune']);

function checkGitPush(args: string[], appendsArgs: boolean): ValidationResult {
  if (appendsArgs) {
    return refuse('A `git push` whose arguments come from another command (xargs) cannot be checked, so it is refused.');
  }
  let isDelete = false;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const name = arg.split('=')[0];
      if (PUSH_REFUSED_FLAGS.has(name)) {
        return refuse(`\`git push ${name}\` pushes more than your task branch.`);
      }
      if (name === '--delete') isDelete = true;
      if (PUSH_OPTIONS_WITH_VALUE.has(name) && !arg.includes('=')) i++;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      if (arg.includes('d')) isDelete = true;
      if (PUSH_OPTIONS_WITH_VALUE.has(arg)) i++;
      continue;
    }
    positionals.push(arg);
  }

  const refspecs = positionals.slice(1);
  if (refspecs.length === 0) {
    return refuse(
      '`git push` without an explicit destination may push the base branch (it depends on the ' +
        'current branch and push configuration), so it is refused.',
    );
  }
  for (const raw of refspecs) {
    const spec = raw.startsWith('+') ? raw.slice(1) : raw;
    const colon = spec.indexOf(':');
    let dst: string;
    if (colon === -1) {
      if (!isDelete && (spec === 'HEAD' || spec === '@' || /^[0-9a-f]{7,40}$/i.test(spec))) {
        return refuse(`\`git push ... ${raw}\` does not name the destination branch.`);
      }
      dst = spec;
    } else {
      dst = spec.slice(colon + 1);
    }
    if (!isTaskDestination(dst)) {
      const verb = isDelete || (colon !== -1 && spec.slice(0, colon) === '') ? 'delete' : 'push to';
      return refuse(`You may not ${verb} \`${dst || raw}\`: agents may only push to \`${TASK_BRANCH_PREFIX}*\` branches.`);
    }
  }
  return ALLOW;
}

function checkGit(args: string[], appendsArgs: boolean): ValidationResult {
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (!arg.startsWith('-')) break;
    const name = arg.split('=')[0];
    let value: string | undefined;
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(name)) {
      if (arg.includes('=') && name.startsWith('--')) {
        value = arg.slice(name.length + 1);
        i++;
      } else {
        value = args[i + 1];
        i += 2;
      }
    } else if (arg.startsWith('-c') && arg.length > 2) {
      value = arg.slice(2);
      i++;
    } else {
      i++;
    }
    if ((name === '-c' || name === '--config-env' || (arg.startsWith('-c') && arg.length > 2)) && value) {
      if (/^alias\./i.test(value)) {
        return refuse('Defining a git alias inline (`-c alias.*`) is refused: an alias can push past this check.');
      }
    }
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === undefined) return ALLOW;
  if (sub === 'push') return checkGitPush(rest, appendsArgs);
  if (sub === 'send-pack') {
    return refuse('`git send-pack` writes remote refs directly and is refused.');
  }
  if (sub === 'subtree' && rest.includes('push')) {
    return refuse('`git subtree push` is refused.');
  }
  if (sub === 'config') {
    const readOnly = rest.some((a) => ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(a));
    if (!readOnly && rest.some((a) => /^alias\./i.test(a))) {
      return refuse('Defining a git alias (`git config alias.*`) is refused: an alias can push past this check.');
    }
  }
  return ALLOW;
}

// ---------------------------------------------------------------------------
// gh
// ---------------------------------------------------------------------------

const GH_OPTIONS_WITH_VALUE = new Set([
  '-R', '--repo', '--hostname', '-X', '--method', '-f', '-F', '--field', '--raw-field',
  '--input', '-H', '--header', '-q', '--jq', '-t', '--template', '-p', '--preview', '--cache',
]);

const GRAPHQL_LANDING_MUTATIONS =
  /\b(mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|mergeBranch|updateRefs?|createRef|deleteRef|createCommitOnBranch)\b/;

const REST_LANDING_ENDPOINT =
  /(^|\/)(pulls\/[^/]+\/merge|merges|merge-upstream)$|(^|\/)(git\/refs?|contents)(\/|$)/;

function checkGhApi(args: string[]): ValidationResult {
  let method: string | null = null;
  let hasBody = false;
  let hasInput = false;
  const values: string[] = [];
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('-') && arg.length > 1) {
      const eq = arg.indexOf('=');
      const name = arg.startsWith('--') && eq !== -1 ? arg.slice(0, eq) : arg;
      let value: string | undefined;
      if (name !== arg) value = arg.slice(eq + 1);
      else if (GH_OPTIONS_WITH_VALUE.has(name)) value = args[++i];
      if (name === '-X' || name === '--method') method = (value ?? '').toUpperCase();
      if (['-f', '-F', '--field', '--raw-field'].includes(name)) hasBody = true;
      if (name === '--input') hasInput = true;
      if (value !== undefined) values.push(value);
      continue;
    }
    positionals.push(arg);
  }
  const endpoint = (positionals[0] ?? '').replace(/^\/+/, '').split('?')[0];
  if (endpoint === 'graphql') {
    if (hasInput) {
      return refuse('`gh api graphql --input` cannot be checked for merge mutations, so it is refused.');
    }
    if (values.some((v) => GRAPHQL_LANDING_MUTATIONS.test(v))) {
      return refuse('A GraphQL mutation that merges a pull request or moves a branch is refused.');
    }
    return ALLOW;
  }
  const effectiveMethod = method ?? (hasBody || hasInput ? 'POST' : 'GET');
  if (effectiveMethod !== 'GET' && effectiveMethod !== 'HEAD' && REST_LANDING_ENDPOINT.test(endpoint)) {
    return refuse(`\`gh api -X ${effectiveMethod} ${endpoint}\` merges or writes a branch directly and is refused.`);
  }
  return ALLOW;
}

function checkGh(args: string[], appendsArgs: boolean): ValidationResult {
  const positionals: number[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('-') && arg.length > 1) {
      if (GH_OPTIONS_WITH_VALUE.has(arg) && positionals.length === 0) i++;
      continue;
    }
    positionals.push(i);
    if (positionals.length === 2) break;
  }
  const first = positionals[0] === undefined ? undefined : args[positionals[0]];
  const second = positionals[1] === undefined ? undefined : args[positionals[1]];
  if (first === 'api') {
    if (appendsArgs) return refuse('A `gh api` call whose arguments come from another command (xargs) cannot be checked.');
    return checkGhApi(args.slice((positionals[0] ?? 0) + 1));
  }
  if (first === 'pr' && second === 'merge') {
    return refuse('`gh pr merge` is refused: the merge queue lands pull requests, agents do not.');
  }
  if (first === 'repo' && second === 'sync') {
    return refuse('`gh repo sync` moves a branch on the remote and is refused.');
  }
  if (first === 'alias' && (second === 'set' || second === 'import')) {
    return refuse('Defining a gh alias is refused: an alias can merge past this check.');
  }
  return ALLOW;
}

// ---------------------------------------------------------------------------
// Simple command dispatch
// ---------------------------------------------------------------------------

/** Wrapper commands and the options among theirs that take a value. */
const WRAPPERS: Record<string, Set<string>> = {
  command: new Set(),
  builtin: new Set(),
  exec: new Set(['-a']),
  nohup: new Set(),
  time: new Set(),
  nice: new Set(['-n']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  stdbuf: new Set(['-i', '-o', '-e']),
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '-C', '--unset', '--chdir']),
  xargs: new Set(['-n', '-L', '-P', '-I', '-d', '-E', '-s', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file']),
};

function checkSimpleCommand(input: string[], depth: number): ValidationResult {
  let words = input;
  let appendsArgs = false;

  for (;;) {
    while (words.length > 0 && (RESERVED_WORDS.has(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) {
      words = words.slice(1);
    }
    if (words.length === 0) return ALLOW;
    const name = basename(words[0]);
    const valueOptions = WRAPPERS[name];
    if (!valueOptions) break;
    let i = 1;
    while (i < words.length && words[i].startsWith('-')) {
      const opt = words[i];
      if (opt === '--') {
        i++;
        break;
      }
      if (name === 'env' && (opt === '-S' || opt.startsWith('--split-string'))) {
        const str = opt.includes('=') ? opt.slice(opt.indexOf('=') + 1) : words[i + 1];
        return validateLandingPolicyAt(`${str ?? ''} ${words.slice(i + (opt.includes('=') ? 1 : 2)).join(' ')}`, depth + 1);
      }
      i += valueOptions.has(opt) ? 2 : 1;
    }
    if (name === 'timeout') i++; // the duration
    if (name === 'xargs') appendsArgs = true;
    words = words.slice(i);
  }

  const name = basename(words[0]);
  const args = words.slice(1);

  if (SHELLS.has(name)) {
    const cIndex = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
    if (cIndex !== -1 && args[cIndex + 1] !== undefined) {
      return validateLandingPolicyAt(args[cIndex + 1], depth + 1);
    }
    return ALLOW;
  }
  if (name === 'eval') return validateLandingPolicyAt(args.join(' '), depth + 1);
  if (name === 'git') return checkGit(args, appendsArgs);
  if (name === 'gh') return checkGh(args, appendsArgs);
  return ALLOW;
}

function validateLandingPolicyAt(commandString: string, depth: number): ValidationResult {
  if (depth > MAX_DEPTH) {
    return refuse('The command nests shells too deeply to be checked.');
  }
  const { commands, nested } = lex(commandString);
  for (const words of commands) {
    const result = checkSimpleCommand(words, depth);
    if (!result[0]) return result;
  }
  for (const inner of nested) {
    const result = validateLandingPolicyAt(inner, depth + 1);
    if (!result[0]) return result;
  }
  return ALLOW;
}

/**
 * Refuse any part of a shell command that would land work on the base branch
 * without a pull request. Call only when PR-only landing is on.
 */
export function validateLandingPolicy(commandString: string): ValidationResult {
  return validateLandingPolicyAt(commandString, 0);
}
