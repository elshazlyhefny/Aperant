/**
 * zeenha fork: tell a coder session which subtask it has and what already changed.
 *
 * Every subtask is a fresh CLI session. The orchestrator always knew which
 * subtask it was running, but dropped that fact, so each session re-derived it
 * from the plan and re-explored the branch. Appended after the stable prompt,
 * so the shared prefix stays cacheable across subtasks.
 */

import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { SubtaskInfo } from '../orchestration/build-orchestrator';

const execFileAsync = promisify(execFile);

/** A branch can touch many files; past this the list stops saving reading. */
const MAX_LISTED_FILES = 60;

interface RawSubtask {
  id?: string;
  title?: string;
  description?: string;
  status?: string;
  files_to_modify?: unknown;
  files_to_create?: unknown;
  patterns_from?: unknown;
  verification?: unknown;
}

interface RawPlan {
  phases?: Array<{ name?: string; subtasks?: RawSubtask[] }>;
}

async function git(cwd: string, ...args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function baseCandidates(specDir: string): Promise<string[]> {
  const candidates = ['origin/main', 'main'];
  try {
    const metadata = JSON.parse(await readFile(join(specDir, 'task_metadata.json'), 'utf-8')) as { baseBranch?: unknown };
    if (typeof metadata.baseBranch === 'string' && metadata.baseBranch.length > 0) {
      candidates.unshift(`origin/${metadata.baseBranch}`, metadata.baseBranch);
    }
  } catch {
    // No metadata: the defaults stand.
  }
  return candidates;
}

/**
 * Files changed on this branch so far, committed or not. Null means "could not
 * tell": a wrong list is worse than none, so nothing is guessed. A folder that
 * is not its own top level would answer for the parent repository.
 */
export async function changedFilesOnBranch(projectDir: string, specDir: string): Promise<string[] | null> {
  const topLevel = await git(projectDir, 'rev-parse', '--show-toplevel');
  if (!topLevel) return null;
  try {
    if ((await realpath(topLevel)) !== (await realpath(projectDir))) return null;
  } catch {
    return null;
  }

  let base: string | null = null;
  for (const candidate of await baseCandidates(specDir)) {
    base = await git(projectDir, 'merge-base', 'HEAD', candidate);
    if (base) break;
  }
  if (!base) return null;

  const committed = await git(projectDir, 'diff', '--name-only', base, 'HEAD');
  const working = await git(projectDir, 'status', '--porcelain', '--no-renames');
  if (committed === null || working === null) return null;

  const files = new Set(committed.split('\n').filter(Boolean));
  for (const line of working.split('\n')) {
    const path = line.slice(3).trim();
    if (path && !path.startsWith('.auto-claude')) files.add(path);
  }
  return [...files].sort();
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

function bullet(label: string, items: string[]): string[] {
  return items.length > 0 ? [`- **${label}**: ${items.map((item) => `\`${item}\``).join(', ')}`] : [];
}

export interface SubtaskBriefInput {
  specDir: string;
  projectDir: string;
  subtask: SubtaskInfo;
  attemptCount: number;
}

/** Never throws, and an unreadable plan only loses detail: the prompt's own scan still works. */
export async function buildSubtaskBrief(input: SubtaskBriefInput): Promise<string> {
  const { specDir, projectDir, subtask, attemptCount } = input;

  let plan: RawPlan = {};
  try {
    plan = JSON.parse(await readFile(join(specDir, 'implementation_plan.json'), 'utf-8')) as RawPlan;
  } catch {
    // Fall back to what the orchestrator handed over.
  }
  const subtasks = (plan.phases ?? []).flatMap((phase) => (phase.subtasks ?? []).map((raw) => ({ raw, phase: phase.name })));
  const found = subtasks.find((entry) => entry.raw.id === subtask.id);
  const raw: RawSubtask = found?.raw ?? {};

  const lines = [
    '## YOUR SUBTASK',
    '',
    'The orchestrator assigned this subtask to this session. Do this one and no other.',
    '',
    `- **ID**: \`${subtask.id}\``,
    ...(raw.title ? [`- **Title**: ${raw.title}`] : []),
    ...(found?.phase ?? subtask.phaseName ? [`- **Phase**: ${found?.phase ?? subtask.phaseName}`] : []),
    `- **Description**: ${raw.description ?? subtask.description}`,
    ...bullet('Files to modify', list(raw.files_to_modify).length > 0 ? list(raw.files_to_modify) : (subtask.filesToModify ?? [])),
    ...bullet('Files to create', list(raw.files_to_create).length > 0 ? list(raw.files_to_create) : (subtask.filesToCreate ?? [])),
    ...bullet('Follow the patterns in', list(raw.patterns_from)),
  ];

  if (raw.verification !== undefined) {
    lines.push(`- **Verification**: \`${JSON.stringify(raw.verification)}\``);
  }
  if (subtasks.length > 0) {
    const done = subtasks.filter((entry) => entry.raw.status === 'completed').length;
    lines.push(`- **Progress**: ${done} of ${subtasks.length} subtasks completed`);
  }
  if (attemptCount > 1) {
    lines.push(`- **Attempt ${attemptCount}**: an earlier attempt did not finish. Check \`git status\` and \`build-progress.txt\` for what it left.`);
  }

  const changed = await changedFilesOnBranch(projectDir, specDir);
  if (changed && changed.length > 0) {
    const shown = changed.slice(0, MAX_LISTED_FILES);
    lines.push('', 'Already changed on this branch (read one only if your subtask touches it):', ...shown.map((file) => `- \`${file}\``));
    if (changed.length > shown.length) {
      lines.push(`- ...and ${changed.length - shown.length} more (\`git diff --name-only\`)`);
    }
  }

  return lines.join('\n');
}
