/**
 * Commit Message Runner
 * =====================
 *
 * Generates high-quality commit messages using Vercel AI SDK.
 * See apps/desktop/src/main/ai/runners/commit-message.ts for the TypeScript implementation.
 *
 * Features:
 * - Conventional commits format (feat/fix/refactor/etc)
 * - GitHub issue references (Fixes #123)
 * - Context-aware descriptions from spec metadata
 *
 * Uses `createSimpleClient()` with no tools (single-turn text generation).
 */

import { generateText } from 'ai';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createSimpleClient } from '../client/factory';
import type { ModelShorthand, ThinkingLevel } from '../config/types';
import { safeParseJson } from '../../utils/json-repair';

// =============================================================================
// Constants
// =============================================================================

/** Map task categories to conventional commit types */
const CATEGORY_TO_COMMIT_TYPE: Record<string, string> = {
  feature: 'feat',
  bug_fix: 'fix',
  bug: 'fix',
  refactoring: 'refactor',
  refactor: 'refactor',
  documentation: 'docs',
  docs: 'docs',
  testing: 'test',
  test: 'test',
  performance: 'perf',
  perf: 'perf',
  // zeenha fork: 'security' is not one of the types the prompt allows; a
  // security task is a fix. ui_ux and infrastructure are the two TaskCategory
  // values (shared/types/task.ts) that had no mapping and fell to 'chore'.
  security: 'fix',
  ui_ux: 'feat',
  infrastructure: 'build',
  chore: 'chore',
  style: 'style',
  ci: 'ci',
  build: 'build',
};

const SYSTEM_PROMPT = `You are a Git expert who writes clear, concise commit messages following conventional commits format.

Rules:
1. First line: type(scope): description (max 72 chars total)
2. Leave blank line after first line
3. Body: 1-3 sentences explaining WHAT changed and WHY
4. If source issue lines are provided (e.g. "Fixes #N", "Closes #N", "PROJ-123"), end with them verbatim, each on its own line
5. Be specific about the changes, not generic
6. Use imperative mood ("Add feature" not "Added feature")

Types: feat, fix, refactor, docs, test, perf, chore, style, ci, build

Example output:
feat(auth): add OAuth2 login flow

Implement OAuth2 authentication with Google and GitHub providers.
Add token refresh logic and secure storage.

Fixes #42`;

// =============================================================================
// Types
// =============================================================================

/** Context extracted from spec files */
interface SpecContext {
  title: string;
  category: string;
  description: string;
  // zeenha fork: a list, because a batch task carries githubIssueNumbers.
  issues: IssueRef[];
}

/** A link from a task back to the issue it came from, in any supported tracker. */
export type IssueRef = { kind: 'github' | 'gitlab' | 'jira' | 'linear'; ref: string };

/** Configuration for commit message generation */
export interface CommitMessageConfig {
  /** Project root directory */
  projectDir: string;
  /** Spec identifier (e.g., "001-add-feature") */
  specName: string;
  /** Git diff stat or summary */
  diffSummary?: string;
  /** List of changed file paths */
  filesChanged?: string[];
  /** GitHub issue number if linked (overrides spec metadata) */
  githubIssue?: number;
  /** Model shorthand (defaults to 'haiku') */
  modelShorthand?: ModelShorthand;
  /** Thinking level (defaults to 'low') */
  thinkingLevel?: ThinkingLevel;
}

// =============================================================================
// Spec Context Extraction
// =============================================================================

/** Keep only positive integers: these values are written into the prompt. */
function issueNumbers(value: unknown): number[] {
  const list = Array.isArray(value) ? value : [value];
  return list.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0);
}

/**
 * Same pattern as ISSUE_KEY_RE in ipc-handlers/jira/jira-client.ts (not imported
 * here to keep the AI layer free of IPC-handler dependencies). Jira keys and
 * Linear identifiers go into a prompt and a PR body, so they must match it.
 */
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]{1,19}-[1-9][0-9]{0,9}$/;

/** Keep only strings that are a valid issue key. */
function issueKey(value: unknown): string[] {
  return typeof value === 'string' && ISSUE_KEY_RE.test(value) ? [value] : [];
}

/**
 * Read the validated, de-duplicated issue refs from task_metadata.json.
 */
export function readIssueRefs(specDir: string): IssueRef[] {
  const metaFile = join(specDir, 'task_metadata.json');
  if (!existsSync(metaFile)) return [];
  const meta = safeParseJson<Record<string, unknown>>(readFileSync(metaFile, 'utf-8'));
  if (!meta || typeof meta !== 'object') return [];

  const refs: IssueRef[] = [];
  const seen = new Set<string>();
  const add = (kind: IssueRef['kind'], ref: string) => {
    const id = `${kind}:${ref}`;
    if (seen.has(id)) return;
    seen.add(id);
    refs.push({ kind, ref });
  };

  for (const n of [...issueNumbers(meta.githubIssueNumber), ...issueNumbers(meta.githubIssueNumbers)]) {
    add('github', String(n));
  }
  for (const n of issueNumbers(meta.gitlabIssueIid)) add('gitlab', String(n));
  for (const k of issueKey(meta.jiraIssueKey)) add('jira', k);
  for (const k of issueKey(meta.linearIdentifier)) add('linear', k);
  return refs;
}

/**
 * One issue-closing line per ref, in input order.
 *
 * zeenha fork: the 'azuredevops' style never starts a reference with '#',
 * because Azure DevOps reads a bare '#123' as Azure Boards work item 123.
 */
export function formatIssueClosingLines(
  refs: IssueRef[],
  style: 'default' | 'azuredevops' = 'default',
): string[] {
  return refs.map((r) => {
    if (style === 'azuredevops') {
      switch (r.kind) {
        case 'github':
          return `Related GitHub issue: ${r.ref}`;
        case 'gitlab':
          return `Related GitLab issue: ${r.ref}`;
        default:
          return `Related issue: ${r.ref}`;
      }
    }
    switch (r.kind) {
      case 'github':
        return `Fixes #${r.ref}`;
      case 'gitlab':
        return `Closes #${r.ref}`;
      case 'linear':
        return `Fixes ${r.ref}`;
      default:
        return r.ref;
    }
  });
}

/**
 * Extract context from spec files for commit message generation.
 * Mirrors Python's `_get_spec_context()`.
 */
function getSpecContext(specDir: string): SpecContext {
  const context: SpecContext = {
    title: '',
    category: 'chore',
    description: '',
    issues: [],
  };

  // Try to read spec.md for title
  const specFile = join(specDir, 'spec.md');
  if (existsSync(specFile)) {
    try {
      const content = readFileSync(specFile, 'utf-8');
      const titleMatch = content.match(/^#+ (.+)$/m);
      if (titleMatch) {
        context.title = titleMatch[1].trim();
      }
      const overviewMatch = content.match(/## Overview\s*\n([\s\S]+?)(?=\n##|$)/);
      if (overviewMatch) {
        context.description = overviewMatch[1].trim().slice(0, 200);
      }
    } catch {
      // Ignore read errors
    }
  }

  // Try to read requirements.json for metadata
  const reqFile = join(specDir, 'requirements.json');
  if (existsSync(reqFile)) {
    const reqData = safeParseJson<Record<string, unknown>>(readFileSync(reqFile, 'utf-8'));
    if (reqData) {
      if (!context.title && reqData.feature) {
        context.title = String(reqData.feature);
      }
      if (reqData.workflow_type) {
        context.category = String(reqData.workflow_type);
      }
      if (reqData.task_description && !context.description) {
        context.description = String(reqData.task_description).slice(0, 200);
      }
    }
  }

  // Try to read implementation_plan.json for GitHub issue
  const planFile = join(specDir, 'implementation_plan.json');
  if (existsSync(planFile)) {
    const planData = safeParseJson<Record<string, unknown>>(readFileSync(planFile, 'utf-8'));
    if (planData) {
      const metadata = (planData.metadata as Record<string, unknown>) ?? {};
      const fromPlan = issueNumbers(metadata.githubIssueNumber);
      if (fromPlan.length > 0) {
        context.issues = fromPlan.map((n) => ({ kind: 'github' as const, ref: String(n) }));
      }
      if (!context.title) {
        context.title = String(planData.feature ?? planData.title ?? '');
      }
    }
  }

  // zeenha fork: task_metadata.json is where the GitHub import
  // (ipc-handlers/github/spec-utils.ts) actually writes githubIssueNumber(s) and
  // the label-derived category; nothing writes them to implementation_plan.json,
  // so commits never got "Fixes #N". The GitLab, Jira and Linear imports had the
  // same gap (gitlabIssueIid, jiraIssueKey, linearIdentifier). It wins over the plan and requirements.json
  // (whose workflow_type the import always writes as 'feature').
  const metaFile = join(specDir, 'task_metadata.json');
  if (existsSync(metaFile)) {
    const meta = safeParseJson<Record<string, unknown>>(readFileSync(metaFile, 'utf-8'));
    if (meta) {
      const fromMeta = readIssueRefs(specDir);
      if (fromMeta.length > 0) {
        context.issues = fromMeta;
      }
      if (typeof meta.category === 'string' && meta.category.trim()) {
        context.category = meta.category.trim();
      }
    }
  }

  return context;
}

/**
 * Build the prompt for commit message generation.
 * Mirrors Python's `_build_prompt()`.
 */
function buildPrompt(
  specContext: SpecContext,
  diffSummary: string,
  filesChanged: string[],
): string {
  const commitType = CATEGORY_TO_COMMIT_TYPE[specContext.category.toLowerCase()] ?? 'chore';

  let issueRef = '';
  if (specContext.issues.length > 0) {
    const refs = specContext.issues
      .map((r) => (r.kind === 'github' || r.kind === 'gitlab' ? `#${r.ref}` : r.ref))
      .join(', ');
    const lines = formatIssueClosingLines(specContext.issues)
      .map((l) => `'${l}'`)
      .join(', ');
    issueRef = `\nSource issue(s): ${refs} (include ${lines} at the end, each on its own line)`;
  }

  let filesDisplay: string;
  if (filesChanged.length > 20) {
    filesDisplay =
      filesChanged.slice(0, 20).join('\n') +
      `\n... and ${filesChanged.length - 20} more files`;
  } else {
    filesDisplay = filesChanged.length > 0 ? filesChanged.join('\n') : '(no files listed)';
  }

  return `Generate a commit message for this change.

Task: ${specContext.title || 'Unknown task'}
Type: ${commitType}
Files changed: ${filesChanged.length}
${issueRef}

Description: ${specContext.description || 'No description available'}

Changed files:
${filesDisplay}

Diff summary:
${diffSummary ? diffSummary.slice(0, 2000) : '(no diff available)'}

Generate ONLY the commit message, nothing else. Follow the format exactly:
type(scope): short description

Body explaining changes.

<issue-closing line, e.g. Fixes #N (if applicable)>`;
}

// =============================================================================
// Commit Message Generator
// =============================================================================

/**
 * Generate a commit message using AI.
 *
 * @param config - Commit message configuration
 * @returns Generated commit message, or a fallback message on failure
 */
export async function generateCommitMessage(
  config: CommitMessageConfig,
): Promise<string> {
  const {
    projectDir,
    specName,
    diffSummary = '',
    filesChanged = [],
    githubIssue,
    modelShorthand = 'haiku',
    thinkingLevel = 'low',
  } = config;

  // Find spec directory
  let specDir = join(projectDir, '.auto-claude', 'specs', specName);
  if (!existsSync(specDir)) {
    specDir = join(projectDir, 'auto-claude', 'specs', specName);
  }

  // Get context from spec files
  const specContext = existsSync(specDir) ? getSpecContext(specDir) : {
    title: '',
    category: 'chore',
    description: '',
    issues: [],
  };

  // Override with provided github issue
  if (githubIssue) {
    specContext.issues = [{ kind: 'github', ref: String(githubIssue) }];
  }

  // Build prompt
  const prompt = buildPrompt(specContext, diffSummary, filesChanged);

  // Call AI
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

    if (result.text.trim()) {
      return result.text.trim();
    }
  } catch {
    // Fall through to fallback
  }

  // Fallback message
  const commitType = CATEGORY_TO_COMMIT_TYPE[specContext.category.toLowerCase()] ?? 'chore';
  const title = specContext.title || specName;
  let fallback = `${commitType}: ${title}`;

  if (specContext.issues.length > 0) {
    fallback += `\n\n${formatIssueClosingLines(specContext.issues).join('\n')}`;
  }

  return fallback;
}
