/**
 * Changelog Runner
 * ================
 *
 * AI-powered changelog generation using Vercel AI SDK.
 * Provides the AI generation logic previously handled by the Claude CLI subprocess
 * in apps/desktop/src/main/changelog/generator.ts.
 *
 * Supports multiple source modes: tasks (specs), git history, or branch diffs.
 *
 * Uses `createSimpleClient()` with no tools (single-turn text generation).
 */

import { generateText } from 'ai';

import type {
  ChangelogAudience,
  ChangelogEmojiLevel,
  ChangelogFormat,
} from '../../../shared/types/changelog';
import { buildStyleInstructions } from '../../changelog/formatter';
import { createSimpleClient } from '../client/factory';
import type { ModelShorthand, ThinkingLevel } from '../config/types';

// =============================================================================
// Types
// =============================================================================

/** A task entry for changelog generation */
export interface ChangelogTask {
  /** Task title */
  title: string;
  /** Task description or spec overview */
  description: string;
  /** Task category (feature, bug_fix, refactoring, etc.) */
  category?: string;
  /** GitHub/GitLab issue number if linked */
  issueNumber?: number;
}

/** Configuration for changelog generation */
export interface ChangelogConfig {
  /** Project name */
  projectName: string;
  /** Version string (e.g., "1.2.0") */
  version: string;
  /** Source mode for changelog content */
  sourceMode: 'tasks' | 'git-history' | 'branch-diff';
  /** Tasks/specs to include (for 'tasks' mode) */
  tasks?: ChangelogTask[];
  /** Git commit messages (for 'git-history' or 'branch-diff' modes) */
  commits?: string;
  /** Previous changelog content for style matching */
  previousChangelog?: string;
  // zeenha fork: the request's style options, which used to be dropped.
  /** Release date for the version header (YYYY-MM-DD) */
  date?: string;
  /** Changelog format (defaults to Keep a Changelog) */
  format?: ChangelogFormat;
  /** Target audience (defaults to user-facing) */
  audience?: ChangelogAudience;
  /** Emoji usage level (defaults to none) */
  emojiLevel?: ChangelogEmojiLevel;
  /** Free-text instructions from the user */
  customInstructions?: string;
  /** Model shorthand (defaults to 'sonnet') */
  modelShorthand?: ModelShorthand;
  /** Thinking level (defaults to 'low') */
  thinkingLevel?: ThinkingLevel;
}

/** Result of changelog generation */
export interface ChangelogResult {
  /** Whether generation succeeded */
  success: boolean;
  /** Generated changelog markdown text */
  text: string;
  /** Error message if failed */
  error?: string;
}

// =============================================================================
// Prompt Building
// =============================================================================

const SYSTEM_PROMPT = `You are a technical writer who creates clear, professional changelogs.

Rules:
1. Follow the format, audience and emoji instructions given in the prompt; when none are given, use Keep a Changelog format (https://keepachangelog.com/)
2. Group changes by type (for Keep a Changelog: Added, Changed, Deprecated, Removed, Fixed, Security)
3. Write concise descriptions suited to the stated audience (user-facing by default, not implementation details)
4. Use past tense ("Added dark mode" not "Add dark mode")
5. Reference issue numbers where available
6. Keep entries actionable and meaningful to end users

Output ONLY the changelog markdown, nothing else.`;

/**
 * Build the user prompt for changelog generation based on source mode.
 */
function buildChangelogPrompt(config: ChangelogConfig): string {
  const parts: string[] = [];
  // zeenha fork: the date and the requested format/audience/emoji level reach the
  // prompt through the same helper the legacy CLI prompts use.
  const dated = config.date ? `, released **${config.date}**` : '';
  parts.push(`Generate a changelog entry for **${config.projectName}** version **${config.version}**${dated}.`);

  if (config.format || config.audience || config.emojiLevel) {
    const style = buildStyleInstructions({
      version: config.version,
      date: config.date ?? new Date().toISOString().split('T')[0],
      format: config.format ?? 'keep-a-changelog',
      audience: config.audience ?? 'user-facing',
      emojiLevel: config.emojiLevel,
    });
    parts.push(`\n## Audience\n\n${style.audience}`);
    parts.push(`\n## Format\n\nFollow this structure (replace the placeholders):\n\n${style.format}`);
    if (style.emoji) {
      parts.push(`\n## Emoji Usage\n\n${style.emoji}`);
    }
  } else if (config.date) {
    parts.push(`\nUse ${config.date} as the release date in the version header.`);
  }

  if (config.sourceMode === 'tasks' && config.tasks && config.tasks.length > 0) {
    parts.push('\n## Completed Tasks\n');
    for (const task of config.tasks) {
      let entry = `- **${task.title}**`;
      if (task.category) entry += ` [${task.category}]`;
      if (task.issueNumber) entry += ` (#${task.issueNumber})`;
      entry += `\n  ${task.description}`;
      parts.push(entry);
    }
  } else if (config.commits) {
    parts.push(`\n## Git ${config.sourceMode === 'branch-diff' ? 'Branch Diff' : 'History'}\n`);
    parts.push('```');
    parts.push(config.commits.slice(0, 5000));
    parts.push('```');
  }

  if (config.previousChangelog) {
    parts.push('\n## Previous Changelog (for style reference)\n');
    parts.push(config.previousChangelog.slice(0, 2000));
  }

  if (config.customInstructions?.trim()) {
    parts.push(`\n## Additional Instructions\n\n${config.customInstructions.trim()}`);
  }

  parts.push('\nGenerate ONLY the changelog entry markdown for this version.');
  return parts.join('\n');
}

// =============================================================================
// Changelog Generator
// =============================================================================

/**
 * Generate a changelog entry using AI.
 *
 * @param config - Changelog generation configuration
 * @returns Generated changelog result
 */
export async function generateChangelog(
  config: ChangelogConfig,
): Promise<ChangelogResult> {
  const {
    modelShorthand = 'sonnet',
    thinkingLevel = 'low',
  } = config;

  const prompt = buildChangelogPrompt(config);

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
      return { success: true, text: result.text.trim() };
    }

    return { success: false, text: '', error: 'Empty response from AI' };
  } catch (error) {
    return {
      success: false,
      text: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
