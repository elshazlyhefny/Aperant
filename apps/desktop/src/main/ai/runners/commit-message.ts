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
4. If GitHub issue number provided, end with "Fixes #N" on its own line
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
  githubIssues: number[];
}

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
 * Extract context from spec files for commit message generation.
 * Mirrors Python's `_get_spec_context()`.
 */
function getSpecContext(specDir: string): SpecContext {
  const context: SpecContext = {
    title: '',
    category: 'chore',
    description: '',
    githubIssues: [],
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
        context.githubIssues = fromPlan;
      }
      if (!context.title) {
        context.title = String(planData.feature ?? planData.title ?? '');
      }
    }
  }

  // zeenha fork: task_metadata.json is where the GitHub import
  // (ipc-handlers/github/spec-utils.ts) actually writes githubIssueNumber(s) and
  // the label-derived category; nothing writes them to implementation_plan.json,
  // so commits never got "Fixes #N". It wins over the plan and requirements.json
  // (whose workflow_type the import always writes as 'feature').
  const metaFile = join(specDir, 'task_metadata.json');
  if (existsSync(metaFile)) {
    const meta = safeParseJson<Record<string, unknown>>(readFileSync(metaFile, 'utf-8'));
    if (meta) {
      const issues = issueNumbers(meta.githubIssueNumber);
      const batch = issueNumbers(meta.githubIssueNumbers);
      const all = [...new Set([...issues, ...batch])];
      if (all.length > 0) {
        context.githubIssues = all;
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

  let githubRef = '';
  if (specContext.githubIssues.length > 0) {
    const refs = specContext.githubIssues.map((n) => `#${n}`).join(', ');
    const fixes = specContext.githubIssues.map((n) => `'Fixes #${n}'`).join(', ');
    githubRef = `\nGitHub Issue: ${refs} (include ${fixes} at the end, each on its own line)`;
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
${githubRef}

Description: ${specContext.description || 'No description available'}

Changed files:
${filesDisplay}

Diff summary:
${diffSummary ? diffSummary.slice(0, 2000) : '(no diff available)'}

Generate ONLY the commit message, nothing else. Follow the format exactly:
type(scope): short description

Body explaining changes.

Fixes #N (if applicable)`;
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
    githubIssues: [],
  };

  // Override with provided github issue
  if (githubIssue) {
    specContext.githubIssues = [githubIssue];
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

  if (specContext.githubIssues.length > 0) {
    fallback += `\n\n${specContext.githubIssues.map((n) => `Fixes #${n}`).join('\n')}`;
  }

  return fallback;
}
