/**
 * Ideation Runner
 * ===============
 *
 * AI-powered idea generation using Vercel AI SDK.
 * See apps/desktop/src/main/ai/runners/ideation.ts for the TypeScript implementation.
 *
 * Uses `createSimpleClient()` with read-only tools and streaming to generate
 * ideas of different types: code improvements, UI/UX, documentation, security,
 * performance, and code quality.
 */

import { stepCountIs } from 'ai';
import { streamText } from '../claude-code/sdk';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { createSimpleClient } from '../client/factory';
import { buildToolRegistry } from '../tools/build-registry';
import type { ToolContext } from '../tools/types';
import type { ModelShorthand, ThinkingLevel } from '../config/types';
import type { SecurityProfile } from '../security/bash-validator';

// =============================================================================
// Constants
// =============================================================================

/** Supported ideation types */
export const IDEATION_TYPES = [
  'code_improvements',
  'ui_ux_improvements',
  'documentation_gaps',
  'security_hardening',
  'performance_optimizations',
  'code_quality',
] as const;

export type IdeationType = (typeof IDEATION_TYPES)[number];

/** Human-readable labels for ideation types */
export const IDEATION_TYPE_LABELS: Record<IdeationType, string> = {
  code_improvements: 'Code Improvements',
  ui_ux_improvements: 'UI/UX Improvements',
  documentation_gaps: 'Documentation Gaps',
  security_hardening: 'Security Hardening',
  performance_optimizations: 'Performance Optimizations',
  code_quality: 'Code Quality & Refactoring',
};

/** Prompt file mapping per ideation type */
const IDEATION_TYPE_PROMPTS: Record<IdeationType, string> = {
  code_improvements: 'ideation_code_improvements.md',
  ui_ux_improvements: 'ideation_ui_ux.md',
  documentation_gaps: 'ideation_documentation.md',
  security_hardening: 'ideation_security.md',
  performance_optimizations: 'ideation_performance.md',
  code_quality: 'ideation_code_quality.md',
};

// =============================================================================
// Types
// =============================================================================

/** Configuration for running ideation */
export interface IdeationConfig {
  /** Project directory path */
  projectDir: string;
  /** Output directory for results */
  outputDir: string;
  /** Prompts directory containing ideation prompt files */
  promptsDir: string;
  /** Type of ideation to run */
  ideationType: IdeationType;
  /** Model shorthand (defaults to 'sonnet') */
  modelShorthand?: ModelShorthand;
  /** Thinking level (defaults to 'medium') */
  thinkingLevel?: ThinkingLevel;
  /** Maximum ideas per type (defaults to 5) */
  maxIdeasPerType?: number;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** zeenha fork: prompt section naming merged commits the checkout lacks (see ideation-freshness.ts) */
  checkoutNote?: string;
}

/** Result of an ideation run */
export interface IdeationResult {
  /** Whether the run succeeded */
  success: boolean;
  /** Full response text from the agent */
  text: string;
  /** Error message if failed */
  error?: string;
}

/** Callback for streaming events from the ideation runner */
export type IdeationStreamCallback = (event: IdeationStreamEvent) => void;

/** Events emitted during ideation streaming */
export type IdeationStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-use'; name: string }
  | { type: 'error'; error: string };

/**
 * Tool-using steps an ideation agent may take. zeenha fork: upstream allowed 30,
 * and on a large repository the performance agent spent all of them reading
 * files and was stopped before writing anything.
 */
export const IDEATION_MAX_STEPS = 60;

/**
 * Whether a `*_ideas.json` file written since `since` holds ideas of `ideationType`.
 * File names are chosen by the prompts (`ui_ux_ideas.json` holds
 * `ui_ux_improvements`), so the ideas' own `type` is what counts.
 */
export function wroteIdeasFor(outputDir: string, ideationType: string, since: number): boolean {
  if (!existsSync(outputDir)) return false;
  for (const name of readdirSync(outputDir)) {
    if (!name.endsWith('_ideas.json')) continue;
    const file = join(outputDir, name);
    if (statSync(file).mtimeMs < since) continue;
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
      for (const value of Object.values(data)) {
        if (
          Array.isArray(value) &&
          value.some((idea) => typeof idea === 'object' && idea !== null && (idea as { type?: unknown }).type === ideationType)
        ) {
          return true;
        }
      }
    } catch {
      // half-written or invalid: does not count
    }
  }
  return false;
}

// =============================================================================
// Ideation Runner
// =============================================================================

/**
 * Run an ideation agent for a specific ideation type.
 *
 * Loads the appropriate prompt, creates a simple client with read-only tools,
 * and streams the response. Mirrors Python's `IdeationGenerator.run_agent()`.
 *
 * @param config - Ideation configuration
 * @param onStream - Optional callback for streaming events
 * @returns Ideation result
 */
export async function runIdeation(
  config: IdeationConfig,
  onStream?: IdeationStreamCallback,
): Promise<IdeationResult> {
  const {
    projectDir,
    outputDir,
    promptsDir,
    ideationType,
    modelShorthand = 'sonnet',
    thinkingLevel = 'medium',
    maxIdeasPerType = 5,
    abortSignal,
    checkoutNote,
  } = config;

  // Load prompt file
  const promptFile = IDEATION_TYPE_PROMPTS[ideationType];
  const promptPath = join(promptsDir, promptFile);

  if (!existsSync(promptPath)) {
    return {
      success: false,
      text: '',
      error: `Prompt not found: ${promptPath}`,
    };
  }

  let prompt: string;
  try {
    prompt = readFileSync(promptPath, 'utf-8');
  } catch (error) {
    return {
      success: false,
      text: '',
      error: `Failed to read prompt: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Add context to prompt (matches Python format)
  prompt += `\n\n---\n\n**Output Directory**: ${outputDir}\n`;
  prompt += `**Project Directory**: ${projectDir}\n`;
  prompt += `**Max Ideas**: ${maxIdeasPerType}\n`;
  if (checkoutNote) prompt += `\n${checkoutNote}\n`;

  // Create tool context for read-only tools
  const toolContext: ToolContext = {
    cwd: projectDir,
    projectDir,
    specDir: join(projectDir, '.auto-claude', 'specs'),
    securityProfile: null as unknown as SecurityProfile,
    abortSignal,
  };

  // Bind read-only tools + Write for output
  const registry = buildToolRegistry();
  const tools = registry.getToolsForAgent('ideation', toolContext);

  // Create simple client
  const client = await createSimpleClient({
    systemPrompt: '',
    modelShorthand,
    thinkingLevel,
    maxSteps: IDEATION_MAX_STEPS,
    tools,
  });

  let responseText = '';

  // Detect Codex models — they require instructions via providerOptions, not system
  const modelId = typeof client.model === 'string' ? client.model : client.model.modelId;
  const isCodex = modelId?.includes('codex') ?? false;
  const userPrompt = `Analyze the project at ${projectDir} and generate up to ${maxIdeasPerType} ${ideationType.replace(/_/g, ' ')} ideas. Use the available tools to explore the codebase, then write your findings as a JSON file to the output directory. You have at most ${client.maxSteps} tool-using steps: keep the exploration focused and write the JSON file well before you run out, because ideas that are not written to the file are lost.`;

  const startedAt = Date.now();
  try {
    const result = streamText({
      model: client.model,
      system: isCodex ? undefined : prompt,
      prompt: userPrompt,
      tools: client.tools,
      stopWhen: stepCountIs(client.maxSteps),
      abortSignal,
      ...(isCodex ? {
        providerOptions: {
          openai: {
            instructions: prompt,
            store: false,
          },
        },
      } : {}),
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta': {
          responseText += part.text;
          onStream?.({ type: 'text-delta', text: part.text });
          break;
        }
        case 'tool-call': {
          onStream?.({ type: 'tool-use', name: part.toolName });
          break;
        }
        case 'error': {
          const errorMsg =
            part.error instanceof Error ? part.error.message : String(part.error);
          onStream?.({ type: 'error', error: errorMsg });
          break;
        }
      }
    }

    // zeenha fork: finishing the stream is not success. A run stopped by the
    // step limit writes nothing and used to be reported as done, so the
    // category silently stayed empty.
    if (!wroteIdeasFor(outputDir, ideationType, startedAt - 1000)) {
      const error = `The ${IDEATION_TYPE_LABELS[ideationType]} agent finished without writing any ideas (it may have run out of steps). Try generating this category again.`;
      onStream?.({ type: 'error', error });
      return { success: false, text: responseText, error };
    }

    return {
      success: true,
      text: responseText,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    onStream?.({ type: 'error', error: errorMsg });
    return {
      success: false,
      text: responseText,
      error: errorMsg,
    };
  }
}
