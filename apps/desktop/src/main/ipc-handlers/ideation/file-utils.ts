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

function isIdea(value: unknown): value is RawIdea {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RawIdea).id === 'string' &&
    typeof (value as RawIdea).type === 'string' &&
    typeof (value as RawIdea).title === 'string'
  );
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
  for (const { name } of files) {
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
        list.push(item);
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
 * A regenerated idea with the same id AND title as a saved one keeps the saved
 * status and task link. Returns the written data, or null when there are no
 * ideas at all (nothing is written then).
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

  const saved = new Map((existing?.ideas ?? []).map((idea) => [idea.id, idea]));
  const kept = (existing?.ideas ?? []).filter((idea) => !replaced.has(idea.type));
  const fresh: RawIdea[] = [];
  for (const type of replaced) {
    for (const idea of fromFiles.get(type) ?? []) {
      const previous = saved.get(idea.id);
      const merged: RawIdea = { ...idea };
      if (previous && previous.title === idea.title) {
        for (const field of STATE_FIELDS) {
          if (previous[field] !== undefined) merged[field] = previous[field];
        }
      }
      fresh.push(merged);
    }
  }

  const ideas = [...kept, ...fresh];
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
