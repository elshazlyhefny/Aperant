/**
 * Ideation Runner
 * ===============
 *
 * AI-powered idea generation using Vercel AI SDK.
 * See apps/desktop/src/main/ai/runners/ideation.ts for the TypeScript implementation.
 *
 * Uses `createSimpleClient()` with read-only tools and streaming to generate
 * ideas of different types: code improvements, UI/UX, documentation, security,
 * performance, code quality, and SEO.
 */

import { stepCountIs } from 'ai';
import { streamText } from '../claude-code/sdk';
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createSimpleClient } from '../client/factory';
import { buildToolRegistry } from '../tools/build-registry';
import type { ToolContext } from '../tools/types';
import type { ModelShorthand, ThinkingLevel } from '../config/types';
import type { SecurityProfile } from '../security/bash-validator';
import { safeParseJson } from '../../utils/json-repair';
import { validateIdeasData, IDEATION_SCHEMA_HINT } from '../schema/ideation';
import { buildValidationRetryPrompt } from '../schema/structured-output';

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
  'seo_improvements',
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
  seo_improvements: 'SEO',
};

/** Prompt file mapping per ideation type */
const IDEATION_TYPE_PROMPTS: Record<IdeationType, string> = {
  code_improvements: 'ideation_code_improvements.md',
  ui_ux_improvements: 'ideation_ui_ux.md',
  documentation_gaps: 'ideation_documentation.md',
  security_hardening: 'ideation_security.md',
  performance_optimizations: 'ideation_performance.md',
  code_quality: 'ideation_code_quality.md',
  seo_improvements: 'ideation_seo.md',
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
  /** zeenha fork: prompt section listing existing tasks and saved ideas (see ideation-prior-work.ts) */
  priorWorkNote?: string;
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
 * zeenha fork: appended to every category's prompt. An audit of the
 * 2026-10-26 run against the code found ideas that called documented things
 * undocumented, cited a composable that does not exist, generalised one file
 * to its siblings, and reversed recorded design decisions without saying so.
 */
export const IDEATION_EVIDENCE_RULES = `## Evidence rules
- Before you call something undocumented or missing, search the whole documentation (every docs folder, README*, CLAUDE.md / AGENTS.md, and the docblocks in the code) under more than one name. Say where you looked.
- Grep for every file, function, class, component, route, config key or command you name before you cite it, and cite only names you found, with their path.
- Measure counts and line numbers yourself. When a claim covers several files, check each one; do not generalise from the first.
- Before you propose changing how something is designed, look for a comment or doc that records why it is that way. If there is one, answer it in the rationale.`;

/** How many times an invalid ideas file is sent back to the agent for a rewrite. */
export const MAX_VALIDATION_RETRIES = 1;

/** Most validation errors quoted in a retry prompt, so the prompt stays small. */
const MAX_RETRY_PROMPT_ERRORS = 20;

/** Most validation errors quoted in the final failure message. */
const MAX_REPORTED_ERRORS = 3;

/** Output file each category's prompt tells the agent to write. */
const IDEATION_OUTPUT_FILES: Record<IdeationType, string> = {
  code_improvements: 'code_improvements_ideas.json',
  ui_ux_improvements: 'ui_ux_ideas.json',
  documentation_gaps: 'documentation_gaps_ideas.json',
  security_hardening: 'security_hardening_ideas.json',
  performance_optimizations: 'performance_optimizations_ideas.json',
  code_quality: 'code_quality_ideas.json',
  seo_improvements: 'seo_improvements_ideas.json',
};

const IDEAS_FILE_SUFFIX = '_ideas.json';

/** Same wording as validateJsonFile() in schema/structured-output.ts. */
const UNPARSEABLE_JSON_ERRORS = [
  'Invalid JSON syntax that could not be auto-repaired.',
  'The file must contain valid JSON. Common issues:',
  '- Trailing commas after the last item in arrays/objects',
  '- Missing commas between items',
  '- Unquoted property names',
  '- Markdown code fences (```json) wrapping the content',
];

/** Result of looking for, and validating, the ideas file of one category. */
export type IdeasFileCheck =
  | { status: 'missing' }
  | { status: 'valid'; file: string }
  | { status: 'invalid'; file: string; fileName: string; errors: string[] };

function holdsIdeasOfType(data: unknown, ideationType: string): boolean {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return false;
  return Object.values(data).some(
    (value) =>
      Array.isArray(value) &&
      value.some((idea) => typeof idea === 'object' && idea !== null && (idea as { type?: unknown }).type === ideationType),
  );
}

/**
 * Find the `*_ideas.json` file written since `since` for `ideationType` and
 * validate it. File names are chosen by the prompts (`ui_ux_ideas.json` holds
 * `ui_ux_improvements`), so the ideas' own `type` decides which category a
 * file belongs to. A file that cannot be parsed even after repair has no
 * content to attribute, so it is claimed by name only, and only when no file
 * was attributed by content: categories run in parallel and must not claim
 * each other's broken files.
 */
export function checkIdeasFile(outputDir: string, ideationType: string, since: number): IdeasFileCheck {
  if (!existsSync(outputDir)) return { status: 'missing' };

  const ownPrefix = (IDEATION_OUTPUT_FILES[ideationType as IdeationType] ?? '').replace(IDEAS_FILE_SUFFIX, '');
  const attributed: Array<{ file: string; fileName: string; data: unknown }> = [];
  const unparseable: Array<{ file: string; fileName: string }> = [];

  for (const name of readdirSync(outputDir)) {
    if (!name.endsWith(IDEAS_FILE_SUFFIX)) continue;
    const file = join(outputDir, name);
    try {
      // One handle for both, so the age check and the content are the same file.
      const fd = openSync(file, 'r');
      try {
        if (fstatSync(fd).mtimeMs < since) continue;
        const data = safeParseJson<unknown>(readFileSync(fd, 'utf-8'));
        if (data === null) {
          unparseable.push({ file, fileName: name });
        } else if (holdsIdeasOfType(data, ideationType)) {
          attributed.push({ file, fileName: name, data });
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      // unreadable (half-written, removed): does not count
    }
  }

  if (attributed.length > 0) {
    let firstInvalid: IdeasFileCheck | null = null;
    for (const { file, fileName, data } of attributed) {
      const validation = validateIdeasData(data, ideationType);
      if (validation.valid) return { status: 'valid', file };
      firstInvalid ??= { status: 'invalid', file, fileName, errors: validation.errors };
    }
    return firstInvalid ?? { status: 'missing' };
  }

  if (ownPrefix) {
    const own = unparseable.find((entry) => entry.fileName.startsWith(ownPrefix));
    if (own) return { status: 'invalid', file: own.file, fileName: own.fileName, errors: [...UNPARSEABLE_JSON_ERRORS] };
  }
  return { status: 'missing' };
}

/** Whether a fresh ideas file exists for `ideationType` (valid or not). */
export function wroteIdeasFor(outputDir: string, ideationType: string, since: number): boolean {
  return checkIdeasFile(outputDir, ideationType, since).status !== 'missing';
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
    priorWorkNote,
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
  prompt += `\n${IDEATION_EVIDENCE_RULES}\n`;
  if (priorWorkNote) prompt += `\n${priorWorkNote}\n`;

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
    const run = (runPrompt: string) =>
      streamText({
        model: client.model,
        system: isCodex ? undefined : prompt,
        prompt: runPrompt,
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

    const consume = async (result: ReturnType<typeof run>): Promise<void> => {
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
    };

    await consume(run(userPrompt));

    // zeenha fork: finishing the stream is not success. A run stopped by the
    // step limit writes nothing and used to be reported as done, so the
    // category silently stayed empty.
    const since = startedAt - 1000;
    let check = checkIdeasFile(outputDir, ideationType, since);
    if (check.status === 'missing') {
      const error = `The ${IDEATION_TYPE_LABELS[ideationType]} agent finished without writing any ideas (it may have run out of steps). Try generating this category again.`;
      onStream?.({ type: 'error', error });
      return { success: false, text: responseText, error };
    }

    // An ideas file that exists but fails validation goes back to the agent.
    for (let attempt = 0; attempt < MAX_VALIDATION_RETRIES && check.status === 'invalid'; attempt++) {
      const retryPrompt = `${buildValidationRetryPrompt(
        check.fileName,
        check.errors.slice(0, MAX_RETRY_PROMPT_ERRORS),
        IDEATION_SCHEMA_HINT,
      )}\n\nThe file is in the output directory: ${outputDir}`;
      await consume(run(retryPrompt));
      check = checkIdeasFile(outputDir, ideationType, since);
    }

    if (check.status !== 'valid') {
      const label = IDEATION_TYPE_LABELS[ideationType];
      let error: string;
      if (check.status === 'invalid') {
        const shown = check.errors.slice(0, MAX_REPORTED_ERRORS).join('; ');
        const more = check.errors.length > MAX_REPORTED_ERRORS ? ` (+${check.errors.length - MAX_REPORTED_ERRORS} more)` : '';
        error = `The ${label} agent wrote ${check.fileName} but it is still invalid after one retry: ${shown}${more}`;
      } else {
        error = `The ${label} agent finished without writing any ideas (it may have run out of steps). Try generating this category again.`;
      }
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
