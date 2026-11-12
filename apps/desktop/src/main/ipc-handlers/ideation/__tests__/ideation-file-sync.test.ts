import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { normalizeIdea, readIdeasByType, readIdeationFile, syncIdeationFile } from '../file-utils';

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
    // The new idea is there too, under the next number of its series that
    // neither a kept idea nor a later one of the batch (ci-002) holds.
    expect(after.find((i) => i.title === 'Cache the slot engine')).toMatchObject({ id: 'ci-003', status: 'draft' });
    expect(after.filter((i) => i.title === 'Other')).toEqual([expect.objectContaining({ id: 'ci-002' })]);
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

  it('reads a category file with a trailing comma', () => {
    const good = JSON.stringify({ code_quality: [idea('cq-001', 'code_quality')] });
    writeFileSync(path.join(dir, 'code_quality_ideas.json'), good.replace(/\]\}$/, '],}'));
    expect(readIdeasByType(dir).get('code_quality')?.map((i) => i.id)).toEqual(['cq-001']);
  });

  it('skips an unrepairable file while still returning a valid one', () => {
    writeFileSync(path.join(dir, 'broken_ideas.json'), '{{{ nope');
    write('code_quality_ideas.json', { code_quality: [idea('cq-001', 'code_quality')] });
    expect([...readIdeasByType(dir).keys()]).toEqual(['code_quality']);
  });
});

describe('one field convention in ideation.json', () => {
  it('turns camelCase keys into snake_case, the snake_case spelling winning', () => {
    const raw = { id: 'a', type: 'code_quality', title: 't', description: 'd', rationale: 'r', affectedFiles: ['x'], currentState: 'old', current_state: 'kept', taskId: '007-x', metrics: { lineCount: 3 } };
    const out = normalizeIdea(raw, '2026-10-26T00:00:00.000Z');
    expect(out).toMatchObject({ affected_files: ['x'], current_state: 'kept', linked_task_id: '007-x', metrics: { lineCount: 3 } });
    expect(Object.keys(out).filter((k) => /[A-Z]/.test(k))).toEqual([]);
  });

  it('maps taskId to linked_task_id, snake_case winning on conflict, with defaults', () => {
    const out = normalizeIdea({ id: 'a', type: 't', title: 'x', description: 'd', rationale: 'r', taskId: '1-a', filePath: 'camel', file_path: 'snake' }, 'now');
    expect(out).toMatchObject({ linked_task_id: '1-a', file_path: 'snake', status: 'draft', created_at: 'now' });
    expect(out).not.toHaveProperty('taskId');
    expect(out).not.toHaveProperty('filePath');
  });

  it('leaves a top-level possible_duplicate_of object intact', () => {
    const dup = { kind: 'task', id: '001-x', score: 0.8, title: 'X' };
    const out = normalizeIdea({ id: 'a', type: 't', title: 'x', description: 'd', rationale: 'r', possible_duplicate_of: dup }, 'now');
    expect(out.possible_duplicate_of).toEqual(dup);
  });

  it('fills a missing status and creation date, keeping ones that exist', () => {
    const base = { id: 'a', type: 'code_quality', title: 't', description: 'd', rationale: 'r' };
    expect(normalizeIdea(base, '2026-10-26T00:00:00.000Z')).toMatchObject({ status: 'draft', created_at: '2026-10-26T00:00:00.000Z' });
    expect(normalizeIdea({ ...base, status: 'archived', created_at: 'then' }, 'now')).toMatchObject({ status: 'archived', created_at: 'then' });
  });

  it('writes the category files and the ideas saved before it in snake_case', () => {
    writeFileSync(path.join(dir, 'ideation.json'), JSON.stringify({ ideas: [{ ...idea('perf-001', 'performance_optimizations'), affectedAreas: ['a'] }] }));
    write('security_hardening_ideas.json', { security_hardening: [{ id: 'sec-001', type: 'security_hardening', title: 'T', description: 'd', rationale: 'r', currentRisk: 'high' }] });

    syncIdeationFile(dir, ['security_hardening']);

    const ideas = combined().ideas;
    expect(ideas.find((i: { id: string }) => i.id === 'perf-001')).toMatchObject({ affected_areas: ['a'] });
    expect(ideas.find((i: { id: string }) => i.id === 'sec-001')).toMatchObject({ current_risk: 'high', status: 'draft' });
    expect(ideas.find((i: { id: string }) => i.id === 'sec-001').created_at).toEqual(expect.any(String));
    expect(JSON.stringify(ideas)).not.toMatch(/"(affectedAreas|currentRisk)"/);
  });
});

describe('ids and config after a sync', () => {
  it('numbers a colliding idea past every id in use, and keeps a non-numbered id unique', () => {
    writeFileSync(path.join(dir, 'ideation.json'), JSON.stringify({
      ideas: [
        { ...idea('sec-001', 'security_hardening', 'Old A'), status: 'archived' },
        { ...idea('sec-004', 'security_hardening', 'Old B'), status: 'archived' },
        { ...idea('custom', 'security_hardening', 'Old C'), status: 'archived' },
      ],
    }));
    write('security_hardening_ideas.json', { security_hardening: [idea('sec-001', 'security_hardening', 'New'), idea('custom', 'security_hardening', 'New C')] });

    syncIdeationFile(dir, ['security_hardening']);

    const ideas = combined().ideas as Array<{ id: string; title: string }>;
    expect(ideas.find((i) => i.title === 'New')?.id).toBe('sec-005');
    expect(ideas.find((i) => i.title === 'New C')?.id).toBe('custom-2');
  });

  it('adds a newly generated type to config.enabled_types', () => {
    writeFileSync(path.join(dir, 'ideation.json'), JSON.stringify({ config: { enabled_types: ['code_quality'] }, ideas: [idea('cq-001', 'code_quality')] }));
    write('performance_optimizations_ideas.json', { performance_optimizations: [idea('perf-001', 'performance_optimizations')] });

    syncIdeationFile(dir, ['performance_optimizations']);

    expect(combined().config.enabled_types).toEqual(['code_quality', 'performance_optimizations']);
  });
});

describe('possible_duplicate_of', () => {
  let project: string;
  let ideationDir: string;
  const full = (id: string, type: string, title: string, description: string, rationale = 'r') => ({
    id, type, title, description, rationale, status: 'draft',
  });
  const flagged = () => combined().ideas as Array<{ id: string; title: string; possible_duplicate_of?: { kind: string; id: string; score: number; title: string } }>;

  beforeEach(() => {
    project = mkdtempSync(path.join(tmpdir(), 'ideation-project-'));
    ideationDir = path.join(project, '.auto-claude', 'ideation');
    mkdirSync(ideationDir, { recursive: true });
    const specDir = path.join(project, '.auto-claude', 'specs', '038-low-stock-reorder');
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      path.join(specDir, 'spec.md'),
      '# Low-stock reorder drafts\n\n## Overview\nDraft stock reorder orders automatically for products whose inventory runs low, so the merchant can review the drafts.\n\n## Scope\nx\n',
    );
    dir = ideationDir;
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  const repeat = full(
    'feat-001', 'code_improvements', 'Automatic low-stock reorder drafts',
    'Draft stock reorder orders automatically for products whose inventory runs low so the merchant can review drafts.',
    'Inventory runs low often',
  );

  it('flags a reworded repeat of a task and keeps the idea', () => {
    write('a_ideas.json', { code_improvements: [repeat, full('feat-002', 'code_improvements', 'Zebra crossing theme', 'Colourful animated login screen background gradients')] });
    syncIdeationFile(ideationDir, 'all', 'ideation.json', { projectDir: project });
    const ideas = flagged();
    expect(ideas).toHaveLength(2);
    const hit = ideas.find((i) => i.id === 'feat-001')?.possible_duplicate_of;
    expect(hit?.kind).toBe('task');
    expect(hit?.id).toBe('038-low-stock-reorder');
    expect(hit?.score).toBeGreaterThanOrEqual(0.7);
    expect(hit?.title).toBe('Low-stock reorder drafts');
    expect(ideas.find((i) => i.id === 'feat-002')?.possible_duplicate_of).toBeUndefined();
  });

  it('flags a repeat of a dismissed idea of the same regenerated type', () => {
    writeFileSync(
      path.join(ideationDir, 'ideation.json'),
      JSON.stringify({ ideas: [{ ...full('old-001', 'code_improvements', 'Dark mode scheduler', 'Switch the application theme to dark mode automatically at sunset based on location'), status: 'dismissed' }] }),
    );
    write('a_ideas.json', { code_improvements: [full('new-001', 'code_improvements', 'Sunset dark mode scheduling', 'Switch the application theme to dark mode automatically at sunset based on location')] });
    syncIdeationFile(ideationDir, ['code_improvements'], 'ideation.json', { projectDir: project });
    const hit = flagged().find((i) => i.id === 'new-001')?.possible_duplicate_of;
    expect(hit?.kind).toBe('idea');
    expect(hit?.id).toBe('old-001');
  });

  it('flags nothing without projectDir', () => {
    write('a_ideas.json', { code_improvements: [repeat] });
    syncIdeationFile(ideationDir, 'all');
    expect(flagged()[0].possible_duplicate_of).toBeUndefined();
  });

  it('keeps an unchanged idea and clears a stale flag', () => {
    writeFileSync(
      path.join(ideationDir, 'ideation.json'),
      JSON.stringify({ ideas: [{ ...full('x-001', 'code_improvements', 'Zebra crossing theme', 'Colourful animated login screen background gradients'), possible_duplicate_of: { kind: 'task', id: 'gone', score: 0.9, title: 'Gone' } }] }),
    );
    write('a_ideas.json', { code_improvements: [full('x-001', 'code_improvements', 'Zebra crossing theme', 'Colourful animated login screen background gradients')] });
    syncIdeationFile(ideationDir, ['code_improvements'], 'ideation.json', { projectDir: project });
    const ideas = flagged();
    expect(ideas).toHaveLength(1);
    expect(ideas[0].id).toBe('x-001');
    expect(ideas[0].possible_duplicate_of).toBeUndefined();
  });
});
