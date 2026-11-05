/**
 * zeenha fork: ideation agents are told which tasks and ideas already exist.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_LISTED, priorWorkNote, readPriorWork, roadmapPriorWorkNote } from '../ideation-prior-work';

let project: string;
beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), 'prior-work-'));
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

function spec(id: string, files: { spec?: string; plan?: unknown }) {
  const dir = path.join(project, '.auto-claude', 'specs', id);
  mkdirSync(dir, { recursive: true });
  if (files.spec !== undefined) writeFileSync(path.join(dir, 'spec.md'), files.spec);
  if (files.plan !== undefined) writeFileSync(path.join(dir, 'implementation_plan.json'), JSON.stringify(files.plan));
}

function ideation(ideas: unknown[]) {
  const dir = path.join(project, '.auto-claude', 'ideation');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'ideation.json'), JSON.stringify({ ideas }));
}

describe('readPriorWork', () => {
  it('reads task titles from spec.md, else the plan, else the folder name', () => {
    spec('007-restrict-telescope', { spec: '# Restrict the Telescope gate\n\nbody', plan: { status: 'done' } });
    spec('002-from-plan', { plan: { feature: 'Planned feature', status: 'backlog' } });
    spec('003-bare', {});

    expect(readPriorWork(project).tasks).toEqual([
      { id: '002-from-plan', title: 'Planned feature', status: 'backlog' },
      { id: '003-bare', title: '003-bare', status: 'unknown' },
      { id: '007-restrict-telescope', title: 'Restrict the Telescope gate', status: 'done' },
    ]);
  });

  it('reads saved ideas with their status and task link, and nothing when there are none', () => {
    expect(readPriorWork(project)).toEqual({ tasks: [], ideas: [] });
    ideation([
      { id: 'sec-003', type: 'security_hardening', title: 'Restrict Telescope', status: 'archived', linked_task_id: '007-restrict-telescope' },
      { id: 'cq-001', type: 'code_quality', title: 'Use t()' },
      { id: 'bad' },
    ]);
    expect(readPriorWork(project).ideas).toEqual([
      { type: 'security_hardening', title: 'Restrict Telescope', status: 'archived', linkedTaskId: '007-restrict-telescope' },
      { type: 'code_quality', title: 'Use t()', status: 'draft' },
    ]);
  });
});

describe('priorWorkNote', () => {
  const prior = {
    tasks: [{ id: '007-restrict-telescope', title: 'Restrict the Telescope gate', status: 'done' }],
    ideas: [
      { type: 'security_hardening', title: 'Restrict Telescope', status: 'archived', linkedTaskId: '007-restrict-telescope' },
      { type: 'security_hardening', title: 'Rotate HMAC keys', status: 'draft' },
      { type: 'code_quality', title: 'Use t()', status: 'draft' },
      { type: 'code_quality', title: 'Old idea', status: 'dismissed' },
    ],
  };

  it('lists tasks and settled ideas, and points at the spec to read', () => {
    const note = priorWorkNote(prior, 'security_hardening') ?? '';
    expect(note).toContain('- 007-restrict-telescope: Restrict the Telescope gate [done]');
    expect(note).toContain('[security_hardening, archived → task 007-restrict-telescope] Restrict Telescope');
    expect(note).toContain('[code_quality, dismissed] Old idea');
    expect(note).toContain('.auto-claude/specs/<id>/spec.md');
  });

  it('lists the drafts this run replaces apart from the settled ideas', () => {
    const note = priorWorkNote(prior, 'security_hardening') ?? '';
    const [settled, replaced] = note.split('### Current security_hardening ideas');
    expect(replaced).toContain('- Rotate HMAC keys');
    expect(settled).not.toContain('Rotate HMAC keys');
    // another category's drafts are not replaced by this run
    expect(settled).toContain('[code_quality, draft] Use t()');
  });

  it('is undefined for a project with nothing yet, and caps long lists', () => {
    expect(priorWorkNote({ tasks: [], ideas: [] }, 'code_quality')).toBeUndefined();
    const tasks = Array.from({ length: MAX_LISTED + 3 }, (_, i) => ({ id: `t${i}`, title: 'T', status: 'done' }));
    expect(priorWorkNote({ tasks, ideas: [] }, 'code_quality')).toContain('- …and 3 more');
  });
});

describe('roadmapPriorWorkNote', () => {
  it('lists every task and idea, and tells the agent to scope to what is missing', () => {
    const note = roadmapPriorWorkNote({
      tasks: [{ id: '044-draft-stock-orders-from-low-stock', title: 'Draft stock orders from low-stock products', status: 'done' }],
      ideas: [{ type: 'code_quality', title: 'Old idea', status: 'dismissed' }],
    }) ?? '';
    expect(note).toContain('- 044-draft-stock-orders-from-low-stock: Draft stock orders from low-stock products [done]');
    expect(note).toContain('[code_quality, dismissed] Old idea');
    expect(note).toContain('.auto-claude/specs/<id>/spec.md');
    expect(note).toContain('git log --oneline -i --grep=<keyword>');
  });

  it('is undefined for a project with nothing yet', () => {
    expect(roadmapPriorWorkNote({ tasks: [], ideas: [] })).toBeUndefined();
  });
});
