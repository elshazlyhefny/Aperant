/**
 * zeenha fork: converting ideas to tasks against the shapes the ideation runner
 * really writes. Four of the six types are camelCase; converted ideas are stored
 * as status "archived" with linked_task_id.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ref = vi.hoisted(() => ({ path: '' }));
vi.mock('../../../project-store', () => ({
  projectStore: { getProject: () => ({ id: 'p1', path: ref.path, autoBuildPath: '.auto-claude' }) },
}));
vi.mock('../../../utils/spec-number-lock', () => ({
  withSpecNumberLock: async (_p: string, fn: (lock: { getNextSpecNumber: () => number }) => unknown) =>
    fn({ getNextSpecNumber: () => 7 }),
}));

import { dismissAllIdeas } from '../idea-manager';
import { convertIdeaToTask } from '../task-converter';
import { transformIdeaFromSnakeCase } from '../transformers';
import type { RawIdea } from '../types';

const ideationDir = () => path.join(ref.path, '.auto-claude', 'ideation');
const ideationFile = () => path.join(ideationDir(), 'ideation.json');

beforeEach(() => {
  ref.path = mkdtempSync(path.join(tmpdir(), 'ideation-convert-'));
  mkdirSync(ideationDir(), { recursive: true });
});
afterEach(() => rmSync(ref.path, { recursive: true, force: true }));

const base = { description: 'd', rationale: 'r', status: 'draft' };

describe('converted ideas', () => {
  it('keeps the camelCase fields of a security idea on the task it becomes', async () => {
    const sec = { ...base, id: 'sec-001', type: 'security_hardening', title: 'Require MFA', severity: 'high', affectedFiles: ['app/Auth.php'] };
    writeFileSync(ideationFile(), JSON.stringify({ ideas: [sec] }));

    const result = await convertIdeaToTask({} as never, 'p1', 'sec-001');

    expect(result.success).toBe(true);
    const specDir = path.join(ref.path, '.auto-claude', 'specs', result.data!.specId);
    const metadata = JSON.parse(readFileSync(path.join(specDir, 'task_metadata.json'), 'utf-8'));
    expect(metadata.affectedFiles).toEqual(['app/Auth.php']);
  });

  it('keeps estimatedEffort and targetAudience of a camelCase documentation idea', async () => {
    const doc = { ...base, id: 'doc-001', type: 'documentation_gaps', title: 'Doc the scheduler', estimatedEffort: 'small', targetAudience: 'operators', affectedAreas: ['docs/'] };
    writeFileSync(ideationFile(), JSON.stringify({ ideas: [doc] }));

    const result = await convertIdeaToTask({} as never, 'p1', 'doc-001');

    const metadata = JSON.parse(readFileSync(path.join(ref.path, '.auto-claude', 'specs', result.data!.specId, 'task_metadata.json'), 'utf-8'));
    expect(metadata).toMatchObject({ estimatedEffort: 'small', targetAudience: 'operators', affectedFiles: ['docs/'] });
  });

  it('converts when only the per-category files exist (no ideation.json yet)', async () => {
    const sec = { ...base, id: 'sec-002', type: 'security_hardening', title: 'Rotate keys' };
    writeFileSync(path.join(ideationDir(), 'security_hardening_ideas.json'), JSON.stringify({ security_hardening: [sec] }));

    const result = await convertIdeaToTask({} as never, 'p1', 'sec-002');

    expect(result.success).toBe(true);
  });

  it('links a converted idea to its task after a reload', () => {
    const idea = { ...base, id: 'sec-001', type: 'security_hardening', title: 'T', status: 'archived', linked_task_id: '005-require-mfa' } as RawIdea;
    expect(transformIdeaFromSnakeCase(idea).taskId).toBe('005-require-mfa');
    expect(transformIdeaFromSnakeCase({ ...idea, linked_task_id: undefined }).taskId).toBeUndefined();
  });

  it('"Dismiss all" leaves converted (archived) ideas alone', async () => {
    const ideas = [
      { ...base, id: 'a', type: 'code_quality', title: 'A', status: 'archived', linked_task_id: '005-x' },
      { ...base, id: 'b', type: 'code_quality', title: 'B' },
    ];
    writeFileSync(ideationFile(), JSON.stringify({ ideas }));

    await dismissAllIdeas({} as never, 'p1');

    const saved = JSON.parse(readFileSync(ideationFile(), 'utf-8')).ideas;
    expect(saved.map((i: { status: string }) => i.status)).toEqual(['archived', 'dismissed']);
  });
});
