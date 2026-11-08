/**
 * Ideation Schema
 * ===============
 *
 * Zod schema and validator for the `<name>_ideas.json` files written by the
 * ideation agents.
 *
 * Handles LLM variations like:
 * - camelCase vs snake_case top-level keys (the prompts mix both)
 * - the renderer's `taskId` spelling of `linked_task_id`
 *
 * Category-specific fields (severity, metrics, ...) are not validated; they pass through.
 */

import { z } from 'zod';
import { formatZodErrors } from './structured-output';

// =============================================================================
// Key Normalization
// =============================================================================

const toSnakeCase = (key: string): string => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * Normalize the top-level keys of an idea to snake_case. `taskId` becomes
 * `linked_task_id`; the snake_case spelling wins if both spellings exist.
 * Nested values are left alone.
 */
export function normalizeIdeaKeys(idea: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(idea)) {
    const snake = key === 'taskId' ? 'linked_task_id' : toSnakeCase(key);
    if (snake !== key && (idea[snake] !== undefined || out[snake] !== undefined)) continue;
    out[snake] = value;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Non-objects pass through untouched so Zod reports "expected object". */
function normalizeIdeaInput(input: unknown): unknown {
  return isPlainObject(input) ? normalizeIdeaKeys(input) : input;
}

// =============================================================================
// Schema
// =============================================================================

const nonEmptyString = z.string().trim().min(1, 'must not be empty');

export const IdeaSchema = z.preprocess(
  normalizeIdeaInput,
  z
    .object({
      id: nonEmptyString,
      type: nonEmptyString,
      title: nonEmptyString,
      description: nonEmptyString,
      rationale: nonEmptyString,
    })
    .passthrough(),
);

export type ValidatedIdea = z.infer<typeof IdeaSchema>;

// =============================================================================
// File-level Validation
// =============================================================================

export interface IdeasValidation {
  valid: boolean;
  ideas: ValidatedIdea[];
  errors: string[];
  fileName?: never;
}

/**
 * Validate the parsed contents of an ideas file for one ideation type.
 * Scans every top-level array; ideas of other types are ignored.
 */
export function validateIdeasData(data: unknown, ideationType: string): IdeasValidation {
  const ideas: ValidatedIdea[] = [];
  const errors: string[] = [];

  if (!isPlainObject(data)) {
    return { valid: false, ideas, errors: ['At "(root)": expected object'] };
  }

  for (const [key, value] of Object.entries(data)) {
    if (!Array.isArray(value)) continue;

    const typeOf = (item: unknown): unknown =>
      isPlainObject(item) ? normalizeIdeaKeys(item).type : undefined;
    const holdsThisType = value.some((item) => typeOf(item) === ideationType);
    if (!holdsThisType) continue;

    value.forEach((item, index) => {
      const prefix = `${key}[${index}]`;
      if (!isPlainObject(item)) {
        errors.push(`${prefix}: expected object`);
        return;
      }
      const type = typeOf(item);
      if (type === undefined || type === null || type === '') {
        errors.push(`${prefix}: At "type": expected string`);
        return;
      }
      if (type !== ideationType) return;

      const result = IdeaSchema.safeParse(item);
      if (result.success) {
        ideas.push(result.data);
      } else {
        for (const message of formatZodErrors(result.error)) errors.push(`${prefix}: ${message}`);
      }
    });
  }

  if (ideas.length === 0 && errors.length === 0) {
    errors.push(`no ideas of type ${ideationType} found`);
  }

  return { valid: ideas.length > 0 && errors.length === 0, ideas, errors };
}

/** Schema hint for retry prompts */
export const IDEATION_SCHEMA_HINT = `\`\`\`
{
  "<category_key>": [
    {
      "id": "string (unique idea identifier)",
      "type": "string (the ideation type you were asked for)",
      "title": "string (REQUIRED, non-empty)",
      "description": "string (REQUIRED, non-empty)",
      "rationale": "string (REQUIRED, non-empty)"
    }
  ]
}
\`\`\`

Category-specific fields (e.g. severity, affected_files, metrics) are allowed in addition to the required ones.`;
