import { describe, expect, it, vi } from 'vitest';
import type { ImplementationPlan } from '../../shared/types';
import { mapPersistedTaskFields, parseSpecMarkdown } from '../task-record-fields';
import { TASK_RECORD_FIXTURES } from './fixtures/task-record-fixtures';

const NOW = Date.UTC(2025, 0, 1);

function deepFreeze(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
}

describe('mapPersistedTaskFields', () => {
  it.each(TASK_RECORD_FIXTURES)('$name', ({ specId, plan, requirements, specMd, expected }) => {
    const parsedPlan = (typeof plan === 'string' ? JSON.parse(plan) : (plan ?? null)) as ImplementationPlan | null;
    const fields = mapPersistedTaskFields({
      specId,
      plan: parsedPlan,
      requirements,
      getSpecMarkdown: () => (specMd === undefined ? undefined : parseSpecMarkdown(specMd)),
      now: NOW,
    });

    expect(fields.status).toBe(expected.status);
    expect(fields.reviewReason).toBe(expected.reviewReason);
    expect(fields.title).toBe(expected.title);
    expect(fields.description).toBe(expected.description);
    expect(fields.subtasks.map(({ id }) => id)).toEqual(expected.subtaskIds);
    if (expected.subtaskFiles) {
      expect(Object.fromEntries(fields.subtasks.map(({ id, files }) => [id, files]))).toEqual(expected.subtaskFiles);
    }
    if (expected.createdAt) expect(fields.createdAt.toISOString()).toBe(expected.createdAt);
    if (expected.updatedAt) expect(fields.updatedAt.toISOString()).toBe(expected.updatedAt);
  });

  it('maps an unreadable plan to human review without using Markdown for the title', () => {
    const getSpecMarkdown = vi.fn(() => ({ title: 'Markdown Title', overview: 'Markdown overview' }));
    const input = {
      specId: '001-unreadable',
      plan: null,
      planUnreadable: true,
      getSpecMarkdown,
      now: NOW,
    };

    expect(mapPersistedTaskFields({ ...input, requirements: { task_description: 'Original request' } })).toMatchObject({
      status: 'human_review',
      reviewReason: 'errors',
      title: '001-unreadable',
      description: 'Original request',
    });
    expect(getSpecMarkdown).not.toHaveBeenCalled();

    expect(mapPersistedTaskFields(input)).toMatchObject({
      title: '001-unreadable',
      description: 'Markdown overview',
    });
    expect(getSpecMarkdown).toHaveBeenCalledTimes(1);
  });

  it('shares a single Markdown read between the description and title fallbacks', () => {
    const getSpecMarkdown = vi.fn(() => ({ title: 'Markdown Title', overview: 'Markdown overview' }));
    const fields = mapPersistedTaskFields({ specId: '001-fallbacks', plan: null, getSpecMarkdown, now: NOW });

    expect(fields).toMatchObject({ title: 'Markdown Title', description: 'Markdown overview' });
    expect(getSpecMarkdown).toHaveBeenCalledTimes(1);
  });

  it('does not read Markdown when neither field needs a fallback', () => {
    const getSpecMarkdown = vi.fn();
    const fields = mapPersistedTaskFields({
      specId: '001-no-fallbacks',
      plan: { feature: 'Plan Feature' } as ImplementationPlan,
      requirements: { task_description: 'Original request' },
      getSpecMarkdown,
      now: NOW,
    });

    expect(fields).toMatchObject({ title: 'Plan Feature', description: 'Original request' });
    expect(getSpecMarkdown).not.toHaveBeenCalled();
  });

  it('does not mutate cached plan or requirements objects', () => {
    const plan = {
      feature: 'Plan Feature',
      status: 'queued',
      phases: [
        {
          subtasks: [
            {
              id: 'task-1',
              title: 'First subtask',
              description: 'Update the mapper',
              status: 'pending',
              files_to_modify: ['mapper.ts'],
            },
          ],
        },
      ],
    };
    const requirements = { task_description: '  Original request  ' };
    deepFreeze(plan);
    deepFreeze(requirements);

    const fields = mapPersistedTaskFields({
      specId: '001-frozen-inputs',
      plan: plan as unknown as ImplementationPlan,
      requirements,
      getSpecMarkdown: () => undefined,
      now: NOW,
    });

    expect(fields.description).toBe('Original request');
    expect(fields.subtasks).toEqual([
      {
        id: 'task-1',
        title: 'First subtask',
        description: 'Update the mapper',
        status: 'pending',
        files: ['mapper.ts'],
      },
    ]);
  });

  it.each([NOW, new Date(NOW)])('uses now (%s) when the plan has no timestamps', (now) => {
    const fields = mapPersistedTaskFields({
      specId: '001-no-timestamps',
      plan: { feature: 'Plan Feature' } as ImplementationPlan,
      getSpecMarkdown: () => undefined,
      now,
    });

    expect(fields.createdAt).toEqual(new Date(NOW));
    expect(fields.updatedAt).toEqual(new Date(NOW));
  });

  it('treats inherited object keys as unknown statuses', () => {
    const fields = mapPersistedTaskFields({
      specId: '001-unknown-status',
      plan: { status: 'constructor' } as unknown as ImplementationPlan,
      getSpecMarkdown: () => undefined,
      now: NOW,
    });

    expect(fields.status).toBe('backlog');
  });
});

describe('parseSpecMarkdown', () => {
  it('keeps hashes inside code in the Overview and stops at the next heading', () => {
    const overview = 'Some code:\n\n```python\nif ready:\n    # Keep this comment\n    print("#")\n```';
    const markdown = `# Title\n\n## Overview\n\n${overview}\n\n### Next section\n\nNot part of the overview.`;

    expect(parseSpecMarkdown(markdown)).toEqual({ title: 'Title', overview });
  });

  it.each(['', 'Specification: ', 'Quick Spec: '])('extracts the title with prefix %j', (prefix) => {
    expect(parseSpecMarkdown(`# ${prefix}Real Title  `)).toEqual({ title: 'Real Title' });
  });
});
