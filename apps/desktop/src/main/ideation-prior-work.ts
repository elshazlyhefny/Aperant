/**
 * zeenha fork: ideation agents were never told what the project already has.
 * None of the six prompts mention the task specs or the saved ideas, so an
 * agent avoided a repeat only when it happened to open an old backup file, and
 * half-finished work came back as "new" (2026-10-26: sec-005 re-proposed the
 * `otp`/`code` redaction task 007 had been asked for). Every category now gets
 * the list of tasks and saved ideas, with what to do about them.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Entries listed per section; the rest are counted. */
export const MAX_LISTED = 300;
const MAX_TITLE = 160;

export interface PriorTask {
  id: string;
  title: string;
  status: string;
}

export interface PriorIdea {
  type: string;
  title: string;
  status: string;
  linkedTaskId?: string;
}

export interface PriorWork {
  tasks: PriorTask[];
  ideas: PriorIdea[];
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function specTitle(specDir: string): string | null {
  try {
    const heading = readFileSync(path.join(specDir, 'spec.md'), 'utf-8').match(/^#\s+(.+)$/m);
    if (heading) return heading[1].trim();
  } catch {
    // no spec.md: fall back to the plan
  }
  const feature = readJson(path.join(specDir, 'implementation_plan.json'))?.feature;
  return typeof feature === 'string' && feature.trim() ? feature.trim() : null;
}

/** The project's task specs and the ideas saved in `ideation.json`. Unreadable entries are skipped. */
export function readPriorWork(projectDir: string): PriorWork {
  const specsDir = path.join(projectDir, '.auto-claude', 'specs');
  const tasks: PriorTask[] = [];
  if (existsSync(specsDir)) {
    for (const entry of readdirSync(specsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(specsDir, entry.name);
      const status = readJson(path.join(dir, 'implementation_plan.json'))?.status;
      tasks.push({ id: entry.name, title: specTitle(dir) ?? entry.name, status: typeof status === 'string' ? status : 'unknown' });
    }
    tasks.sort((a, b) => a.id.localeCompare(b.id));
  }

  const ideas: PriorIdea[] = [];
  const saved = readJson(path.join(projectDir, '.auto-claude', 'ideation', 'ideation.json'))?.ideas;
  if (Array.isArray(saved)) {
    for (const idea of saved) {
      if (typeof idea?.title !== 'string' || typeof idea?.type !== 'string') continue;
      const linked = idea.linked_task_id ?? idea.taskId;
      ideas.push({
        type: idea.type,
        title: idea.title,
        status: typeof idea.status === 'string' ? idea.status : 'draft',
        ...(typeof linked === 'string' && linked ? { linkedTaskId: linked } : {}),
      });
    }
  }
  return { tasks, ideas };
}

const clip = (s: string) => (s.length > MAX_TITLE ? `${s.slice(0, MAX_TITLE - 1)}…` : s);

function list<T>(items: T[], line: (item: T) => string): string {
  const shown = items.slice(0, MAX_LISTED).map((item) => `- ${line(item)}`);
  if (items.length > MAX_LISTED) shown.push(`- …and ${items.length - MAX_LISTED} more`);
  return shown.join('\n');
}

/**
 * The prompt section for one category. Its own draft ideas are listed apart:
 * this run replaces them, so repeating one is allowed if it is still true.
 */
export function priorWorkNote({ tasks, ideas }: PriorWork, ideationType: string): string | undefined {
  const replaced = ideas.filter((i) => i.type === ideationType && i.status === 'draft' && !i.linkedTaskId);
  const settled = ideas.filter((i) => !replaced.includes(i));
  if (tasks.length === 0 && ideas.length === 0) return undefined;

  const parts = [
    '## Work that already exists',
    'An idea that repeats any of this is wasted. When an earlier task covered part of what you would propose, read its spec (`.auto-claude/specs/<id>/spec.md`) and the code it changed, propose only what is still missing, and name it in the idea ("follows on from task 007"). A dismissed idea was turned down: do not propose it again.',
  ];
  if (tasks.length > 0) {
    parts.push(`### Tasks in this project (${tasks.length}; built, in progress or planned)`, list(tasks, (t) => `${t.id}: ${clip(t.title)} [${t.status}]`));
  }
  if (settled.length > 0) {
    parts.push(
      `### Ideas already generated (${settled.length})`,
      list(settled, (i) => `[${i.type}, ${i.status}${i.linkedTaskId ? ` → task ${i.linkedTaskId}` : ''}] ${clip(i.title)}`),
    );
  }
  if (replaced.length > 0) {
    parts.push(
      `### Current ${ideationType} ideas (${replaced.length}; this run replaces them)`,
      'Propose one of these again only if it is still among the best and you checked it is still true.',
      list(replaced, (i) => clip(i.title)),
    );
  }
  return parts.join('\n\n');
}

/**
 * zeenha fork: the roadmap's feature agent saw only the roadmap's own feature
 * titles, never the task specs, so a refresh re-proposed work that tasks had
 * already built (2026-11-05: "Low-stock auto-reorder drafts" after task 044
 * and PR #227 drafted stock orders from low stock).
 */
export function roadmapPriorWorkNote({ tasks, ideas }: PriorWork): string | undefined {
  if (tasks.length === 0 && ideas.length === 0) return undefined;
  const parts = [
    '## Work that already exists',
    'These tasks were built, are being built, or are planned, outside the roadmap features listed above. A feature that repeats one is wasted. Before you add a feature, check this list and the code (grep it, and `git log --oneline -i --grep=<keyword>`). When part of it exists already, read that task\'s spec (`.auto-claude/specs/<id>/spec.md`) and the code it changed, scope the feature to what is still missing, and say so in the rationale ("task 044 already drafts stock orders from low stock; this adds …"). A dismissed idea was turned down: do not propose it again.',
  ];
  if (tasks.length > 0) {
    parts.push(`### Tasks in this project (${tasks.length})`, list(tasks, (t) => `${t.id}: ${clip(t.title)} [${t.status}]`));
  }
  if (ideas.length > 0) {
    parts.push(
      `### Ideation ideas (${ideas.length})`,
      list(ideas, (i) => `[${i.type}, ${i.status}${i.linkedTaskId ? ` → task ${i.linkedTaskId}` : ''}] ${clip(i.title)}`),
    );
  }
  return parts.join('\n\n');
}
