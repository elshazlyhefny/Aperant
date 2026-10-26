/**
 * File system utilities for ideation operations
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import type { RawIdea, RawIdeationData } from './types';

/**
 * Read ideation data from file.
 *
 * zeenha fork: the TypeScript ideation runner writes one `<name>_ideas.json`
 * per category and never the combined `ideation.json` (the Python runner it
 * replaced used to). Every operation that reads this file (convert to task,
 * dismiss, archive, delete) then failed with "Ideation not found". When the
 * combined file is missing it is now built from the category files beside it.
 */
export function readIdeationFile(ideationPath: string): RawIdeationData | null {
  if (!existsSync(ideationPath)) {
    return syncIdeationFile(path.dirname(ideationPath), 'all', path.basename(ideationPath));
  }

  try {
    const content = readFileSync(ideationPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : 'Failed to read ideation file'
    );
  }
}

/**
 * Write ideation data to file
 */
export function writeIdeationFile(ideationPath: string, data: RawIdeationData): void {
  try {
    writeFileSync(ideationPath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : 'Failed to write ideation file'
    );
  }
}

/**
 * Update timestamp for ideation data
 */
export function updateIdeationTimestamp(data: RawIdeationData): void {
  data.updated_at = new Date().toISOString();
}

// =============================================================================
// Combining the per-category files
// =============================================================================

/** Fields the app writes onto an idea after generation; kept when the same idea is generated again. */
const STATE_FIELDS = ['status', 'linked_task_id'] as const;

/** Converted to a task (stored as `archived` with `linked_task_id`) or archived: never dropped by a regeneration. */
function isPreservedIdea(idea: RawIdea): boolean {
  return Boolean(idea.linked_task_id) || idea.status === 'archived' || idea.status === 'converted';
}

/** `<id>-2`, `<id>-3`, ... : the first one not taken. */
function freeId(id: string, taken: ReadonlySet<string>): string {
  let n = 2;
  while (taken.has(`${id}-${n}`)) n++;
  return `${id}-${n}`;
}

function isIdea(value: unknown): value is RawIdea {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RawIdea).id === 'string' &&
    typeof (value as RawIdea).type === 'string' &&
    typeof (value as RawIdea).title === 'string'
  );
}

const toSnakeCase = (key: string): string => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * zeenha fork: one field convention in `ideation.json`. The prompts' schemas
 * mixed snake_case (code improvements, UI/UX) and camelCase (security, code
 * quality, performance, docs), and the latter carried no `status` or
 * `created_at`, so the app stamped a new creation date on every load and the
 * task converter, which reads snake_case, dropped their content. Top-level
 * keys become snake_case (the snake_case spelling wins if both exist; the
 * renderer's `taskId` becomes `linked_task_id`), and a missing status or
 * creation date is filled in. Nested values (e.g. `metrics`) are left alone.
 */
export function normalizeIdea(idea: RawIdea, createdAt: string): RawIdea {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(idea)) {
    const snake = key === 'taskId' ? 'linked_task_id' : toSnakeCase(key);
    if (snake !== key && (idea[snake] !== undefined || out[snake] !== undefined)) continue;
    out[snake] = value;
  }
  out.status ??= 'draft';
  out.created_at ??= createdAt;
  return out as RawIdea;
}

/**
 * Ideas from the current `*_ideas.json` files, grouped by the idea's own
 * `type`. File names are chosen by the prompts and do not match the type
 * (`ui_ux_ideas.json` holds `ui_ux_improvements`), so they are not relied on.
 * Backups (`*.bak.json`) are ignored. When two files hold the same type, the
 * newest file wins.
 */
export function readIdeasByType(ideationDir: string): Map<string, RawIdea[]> {
  if (!existsSync(ideationDir)) return new Map();
  const files = readdirSync(ideationDir)
    .filter((name) => name.endsWith('_ideas.json')) // backups are *.bak.json, so never match
    .map((name) => ({ name, mtime: statSync(path.join(ideationDir, name)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);

  const byType = new Map<string, RawIdea[]>();
  for (const { name, mtime } of files) {
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(path.join(ideationDir, name), 'utf-8'));
    } catch {
      continue; // a half-written or invalid file must not block the others
    }
    if (typeof data !== 'object' || data === null) continue;
    const fromFile = new Map<string, RawIdea[]>();
    for (const value of Object.values(data as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (!isIdea(item)) continue;
        const list = fromFile.get(item.type) ?? [];
        list.push(normalizeIdea(item, new Date(mtime).toISOString()));
        fromFile.set(item.type, list);
      }
    }
    // Newer files replace older ones type by type.
    for (const [type, ideas] of fromFile) byType.set(type, ideas);
  }
  return byType;
}

/**
 * Bring `ideation.json` up to date with the category files.
 *
 * - `regenerated = 'all'` (or no combined file yet): every category comes from its file.
 * - otherwise only the listed idea types are replaced; every other type keeps
 *   what `ideation.json` already holds, so dismissals, archives and deletions
 *   made in the app are not undone.
 *
 * A regenerated idea with the same title as a saved one of its type keeps the
 * saved id, status and task link. A saved idea that was converted to a task or
 * archived is kept even when the new run did not produce it again; a new idea
 * whose id it holds gets a free id instead. Returns the written data, or null
 * when there are no ideas at all (nothing is written then).
 */
export function syncIdeationFile(
  ideationDir: string,
  regenerated: readonly string[] | 'all',
  fileName = 'ideation.json',
): RawIdeationData | null {
  const ideationPath = path.join(ideationDir, fileName);
  const existing = existsSync(ideationPath)
    ? (JSON.parse(readFileSync(ideationPath, 'utf-8')) as RawIdeationData)
    : null;
  const fromFiles = readIdeasByType(ideationDir);

  const replaceAll = regenerated === 'all' || existing === null;
  const replaced = new Set(replaceAll ? fromFiles.keys() : regenerated.filter((t) => fromFiles.has(t)));

  // Ideas saved before normalizeIdea existed are converted on the next sync.
  const savedAt = existing?.generated_at ?? new Date().toISOString();
  const previousIdeas = (existing?.ideas ?? []).map((idea) => normalizeIdea(idea, savedAt));
  const kept = previousIdeas.filter((idea) => !replaced.has(idea.type));
  const fresh: RawIdea[] = [];
  const retained: RawIdea[] = [];
  const takenIds = new Set(kept.map((idea) => idea.id));
  for (const type of replaced) {
    const previousOfType = previousIdeas.filter((idea) => idea.type === type);
    const consumed = new Set<RawIdea>();
    const generated = fromFiles.get(type) ?? [];
    // Ids are positional (the second idea is always `*-002`), so a regenerated
    // idea is matched to a saved one by its TITLE, preferring the same id.
    const matches = generated.map((idea) => {
      const match =
        previousOfType.find((p) => !consumed.has(p) && p.id === idea.id && p.title === idea.title) ??
        previousOfType.find((p) => !consumed.has(p) && p.title === idea.title);
      if (match) consumed.add(match);
      return match;
    });
    for (const match of matches) if (match) takenIds.add(match.id);
    // zeenha fork: a saved idea that became a task (or was archived) stays,
    // whatever the new run produced. It used to be dropped whenever the idea at
    // its id had a different title, leaving the task with no idea behind it.
    for (const previous of previousOfType) {
      if (!consumed.has(previous) && isPreservedIdea(previous)) {
        retained.push(previous);
        takenIds.add(previous.id);
      }
    }
    generated.forEach((idea, index) => {
      const previous = matches[index];
      const merged: RawIdea = { ...idea };
      if (previous) {
        merged.id = previous.id; // a task or a dismissal refers to it by this id
        for (const field of STATE_FIELDS) {
          if (previous[field] !== undefined) merged[field] = previous[field];
        }
      } else if (takenIds.has(merged.id)) {
        merged.id = freeId(merged.id, takenIds);
        takenIds.add(merged.id);
      } else {
        takenIds.add(merged.id);
      }
      fresh.push(merged);
    });
  }

  const ideas = [...kept, ...retained, ...fresh];
  if (ideas.length === 0 && existing === null) return null;

  // Ids must stay unique: `find(id)` drives every operation on an idea.
  const seen = new Set<string>();
  const unique = ideas.filter((idea) => {
    if (seen.has(idea.id)) return false;
    seen.add(idea.id);
    return true;
  });

  const now = new Date().toISOString();
  const types = [...new Set(unique.map((idea) => idea.type))];
  const data: RawIdeationData = {
    ...(existing ?? {}),
    id: existing?.id ?? `ideation-${Date.now()}`,
    config: existing?.config ?? { enabled_types: types },
    ideas: unique,
    generated_at: existing?.generated_at ?? now,
    updated_at: now,
  };
  writeIdeationFile(ideationPath, data);
  return data;
}
