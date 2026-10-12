import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readIdeasByType, readIdeationFile, syncIdeationFile } from '../file-utils';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ideation-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const idea = (id: string, type: string, title = `Idea ${id}`) => ({ id, type, title, description: 'd', rationale: 'r', status: 'draft' });

function write(name: string, data: unknown, ageSeconds = 0) {
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify(data));
  const when = Date.now() / 1000 - ageSeconds;
  utimesSync(file, when, when);
}

function combined() {
  return JSON.parse(readFileSync(path.join(dir, 'ideation.json'), 'utf-8'));
}

describe('ideation.json from the per-category files', () => {
  it('is built on first read when only category files exist (the "Ideation not found" bug)', () => {
    write('security_hardening_ideas.json', { security_hardening: [idea('sec-001', 'security_hardening')], metadata: { notes: 'x' } });
    // The prompt-chosen file name does not match the type it holds.
    write('ui_ux_ideas.json', { ui_ux_improvements: [idea('uiux-001', 'ui_ux_improvements')] });
    write('ui_ux_ideas.2026-10-08.bak.json', { ui_ux_improvements: [idea('old-001', 'ui_ux_improvements')] });

    const data = readIdeationFile(path.join(dir, 'ideation.json'));

    expect(data?.ideas?.map((i) => i.id).sort()).toEqual(['sec-001', 'uiux-001']);
    expect(combined().ideas).toHaveLength(2);
  });

  it('returns null and writes nothing when there are no ideas', () => {
    expect(readIdeationFile(path.join(dir, 'ideation.json'))).toBeNull();
    expect(() => combined()).toThrow();
  });

  it('replaces only the regenerated categories, keeping changes made in the app', () => {
    write('security_hardening_ideas.json', { security_hardening: [idea('sec-001', 'security_hardening'), idea('sec-002', 'security_hardening')] });
    write('code_quality_ideas.json', { code_quality: [idea('cq-001', 'code_quality')] });
    syncIdeationFile(dir, 'all');

    // In the app: one security idea converted, the other deleted, the quality idea dismissed.
    const saved = combined();
    saved.ideas = saved.ideas
      .filter((i: { id: string }) => i.id !== 'sec-002')
      .map((i: { id: string }) =>
        i.id === 'sec-001' ? { ...i, status: 'archived', linked_task_id: '007-mfa' } : i.id === 'cq-001' ? { ...i, status: 'dismissed' } : i,
      );
    writeFileSync(path.join(dir, 'ideation.json'), JSON.stringify(saved));

    // Code quality is generated again; security is not.
    write('code_quality_ideas.json', { code_quality: [idea('cq-001', 'code_quality'), idea('cq-002', 'code_quality')] });
    syncIdeationFile(dir, ['code_quality']);

    const after = combined();
    const byId = Object.fromEntries(after.ideas.map((i: { id: string }) => [i.id, i]));
    expect(Object.keys(byId).sort()).toEqual(['cq-001', 'cq-002', 'sec-001']);
    expect(byId['sec-001']).toMatchObject({ status: 'archived', linked_task_id: '007-mfa' });
    expect(byId['cq-001'].status).toBe('dismissed'); // same id and title: state kept
    expect(byId['cq-002'].status).toBe('draft');
  });

  it('does not carry state onto a different idea that reuses an id', () => {
    write('code_quality_ideas.json', { code_quality: [idea('cq-001', 'code_quality', 'Old idea')] });
    syncIdeationFile(dir, 'all');
    const saved = combined();
    saved.ideas[0].status = 'dismissed';
    writeFileSync(path.join(dir, 'ideation.json'), JSON.stringify(saved));

    write('code_quality_ideas.json', { code_quality: [idea('cq-001', 'code_quality', 'New idea')] });
    syncIdeationFile(dir, ['code_quality']);
    expect(combined().ideas[0]).toMatchObject({ title: 'New idea', status: 'draft' });
  });

  // zeenha fork: ids are positional, so a regenerated category reuses
  // ci-001.. for different ideas. A converted idea used to vanish then.
  it('keeps a converted idea when the regenerated category reuses its id for another idea', () => {
    write('code_improvements_ideas.json', {
      code_improvements: [idea('ci-001', 'code_improvements', 'Send reminders to guests'), idea('ci-002', 'code_improvements', 'Other')],
    });
    syncIdeationFile(dir, 'all');
    const saved = combined();
    saved.ideas[0] = { ...saved.ideas[0], status: 'archived', linked_task_id: '027-send-reminders' };
    writeFileSync(path.join(dir, 'ideation.json'), JSON.stringify(saved));

    write('code_improvements_ideas.json', {
      code_improvements: [idea('ci-001', 'code_improvements', 'Cache the slot engine'), idea('ci-002', 'code_improvements', 'Other')],
    });
    syncIdeationFile(dir, ['code_improvements']);

    const after = combined().ideas as Array<{ id: string; title: string; status: string; linked_task_id?: string }>;
    const ids = after.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(after.find((i) => i.linked_task_id === '027-send-reminders')).toMatchObject({
      id: 'ci-001',
      title: 'Send reminders to guests',
      status: 'archived',
    });
    // The new idea is there too, under a free id.
    expect(after.find((i) => i.title === 'Cache the slot engine')).toMatchObject({ id: 'ci-001-2', status: 'draft' });
    expect(after.filter((i) => i.title === 'Other')).toHaveLength(1);
  });

  it('carries the saved id and state to a regenerated idea that moved position', () => {
    write('code_quality_ideas.json', { code_quality: [idea('cq-001', 'code_quality', 'A'), idea('cq-002', 'code_quality', 'B')] });
    syncIdeationFile(dir, 'all');
    const saved = combined();
    saved.ideas[0] = { ...saved.ideas[0], status: 'archived', linked_task_id: '030-a' };
    saved.ideas[1] = { ...saved.ideas[1], status: 'dismissed' };
    writeFileSync(path.join(dir, 'ideation.json'), JSON.stringify(saved));

    // Same ideas, other order; plus a new one.
    write('code_quality_ideas.json', {
      code_quality: [idea('cq-001', 'code_quality', 'B'), idea('cq-002', 'code_quality', 'C'), idea('cq-003', 'code_quality', 'A')],
    });
    syncIdeationFile(dir, ['code_quality']);

    const byTitle = Object.fromEntries(
      (combined().ideas as Array<{ id: string; title: string }>).map((i) => [i.title, i]),
    );
    expect(byTitle.A).toMatchObject({ id: 'cq-001', status: 'archived', linked_task_id: '030-a' });
    expect(byTitle.B).toMatchObject({ id: 'cq-002', status: 'dismissed' });
    expect(byTitle.C.id).not.toMatch(/^cq-00[12]$/);
    expect(combined().ideas).toHaveLength(3);
  });

  it('takes the newest file when two hold the same category, and skips invalid files', () => {
    write('ui_ux_improvements_ideas.json', { ui_ux_improvements: [idea('a', 'ui_ux_improvements')] }, 60);
    write('ui_ux_ideas.json', { ui_ux_improvements: [idea('b', 'ui_ux_improvements')] }, 0);
    writeFileSync(path.join(dir, 'broken_ideas.json'), '{ not json');
    expect(readIdeasByType(dir).get('ui_ux_improvements')?.map((i) => i.id)).toEqual(['b']);
  });
});
