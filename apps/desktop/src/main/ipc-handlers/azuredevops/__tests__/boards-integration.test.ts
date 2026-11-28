import { describe, it, expect, assert, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createSpecFromWorkItem, findExistingBoardsSpecs } from '../boards-spec';
import type { AzureBoardsWorkItemData } from '../boards-client';
import { readIssueRefs } from '../../../ai/runners/commit-message';
import { readSourceIssueLines } from '../../../ai/runners/github/pr-creator';

const LOCALES = path.resolve(__dirname, '../../../../shared/i18n/locales');

function flatten(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    flatten(v, prefix ? `${prefix}.${k}` : k)
  );
}

function readBoards(lang: string): unknown {
  const json = JSON.parse(readFileSync(path.join(LOCALES, lang, 'azuredevops.json'), 'utf-8'));
  return json.boards;
}

describe('Azure Boards end-to-end consistency', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = mkdtempSync(path.join(tmpdir(), 'boards-int-'));
    mkdirSync(path.join(projectDir, '.auto-claude', 'specs'), { recursive: true });
  });
  afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

  it('an imported work item yields AB#<id> closing lines', async () => {
    const workItem: AzureBoardsWorkItemData = {
      id: 77,
      title: 'Add export',
      workItemType: 'User Story',
      state: 'New',
      areaPath: 'Proj',
      tags: [],
      description: '<p>Do it</p>',
      acceptanceCriteria: '',
      reproSteps: '',
      url: 'https://dev.azure.com/acme/Proj/_workitems/edit/77',
    };
    const config = { organization: 'acme', project: 'Proj', pat: 'x' } as never;
    const r = await createSpecFromWorkItem({ path: projectDir, autoBuildPath: '.auto-claude' }, config, workItem.id, workItem);
    assert(r.kind === 'created');

    expect(readIssueRefs(r.specDir)).toEqual([{ kind: 'azure_boards', ref: '77' }]);
    expect(readSourceIssueLines(projectDir, projectDir, r.specId)).toEqual(['AB#77']);
    expect(readSourceIssueLines(projectDir, projectDir, r.specId, 'azuredevops')).toEqual(['AB#77']);
  });

  // zeenha fork: overlapping imports and retries needed three concurrency fixes; this pins them together.
  it('overlapping concurrent imports and a retry of only the failed items never duplicate a spec', async () => {
    const project = { path: projectDir, autoBuildPath: '.auto-claude' };
    const config = { organization: 'acme', project: 'Proj', pat: 'x' } as never;
    const specsDir = path.join(projectDir, '.auto-claude', 'specs');
    const workItem = (id: number): AzureBoardsWorkItemData => ({
      id,
      title: `Item ${id}`,
      workItemType: 'Task',
      state: 'New',
      areaPath: 'Proj',
      tags: [],
      description: '<p>Body</p>',
      acceptanceCriteria: '',
      reproSteps: '',
      url: `https://dev.azure.com/acme/Proj/_workitems/edit/${id}`,
    });

    // Mirrors the import handler: items run in order, each failure is reported per item.
    type Outcome = { id: number; status: 'imported' | 'skipped' | 'failed'; specId?: string };
    const importBatch = async (ids: number[], missing: number[] = []): Promise<Outcome[]> => {
      const outcomes: Outcome[] = [];
      for (const id of ids) {
        try {
          const r = await createSpecFromWorkItem(project, config, id, missing.includes(id) ? undefined : workItem(id));
          outcomes.push({ id, status: r.kind === 'created' ? 'imported' : 'skipped', specId: r.specId });
        } catch {
          outcomes.push({ id, status: 'failed' });
        }
      }
      return outcomes;
    };

    // Item 5 is omitted by Azure in both batches; items 2 and 3 overlap.
    const [a, b] = await Promise.all([importBatch([1, 2, 3, 5], [5]), importBatch([3, 2, 4, 5], [5])]);
    const firstPass = [...a, ...b];
    for (const id of [2, 3]) {
      const both = firstPass.filter(o => o.id === id);
      expect(both.map(o => o.status).sort()).toEqual(['imported', 'skipped']);
      expect(new Set(both.map(o => o.specId)).size).toBe(1);
    }
    const failedIds = [...new Set(firstPass.filter(o => o.status === 'failed').map(o => o.id))];
    expect(failedIds).toEqual([5]);
    expect(readdirSync(specsDir)).toHaveLength(4);

    // Retrying only the failed ids, twice at once, creates each exactly once.
    const retries = (await Promise.all([importBatch(failedIds), importBatch(failedIds)])).flat();
    expect(retries.map(o => o.status).sort()).toEqual(['imported', 'skipped']);
    expect(new Set(retries.map(o => o.specId)).size).toBe(1);

    const specs = readdirSync(specsDir);
    expect(specs).toHaveLength(5);
    expect(new Set(specs.map(name => name.split('-')[0])).size).toBe(5);
    const byItem = findExistingBoardsSpecs(specsDir, 'acme', 'Proj');
    expect([...byItem.keys()].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(byItem.values()).size).toBe(5);
  });

  it('en and fr boards key trees are identical', () => {
    const en = flatten(readBoards('en')).sort();
    const fr = flatten(readBoards('fr')).sort();
    expect(en.length).toBeGreaterThan(0);
    expect(fr).toEqual(en);
  });

  it('new boards modules never reference the PAT env name or log the pat', () => {
    const dir = path.resolve(__dirname, '..');
    for (const f of readdirSync(dir).filter(n => /^boards-.*\.ts$/.test(n))) {
      const src = readFileSync(path.join(dir, f), 'utf-8');
      expect(src, f).not.toMatch(/AZURE_DEVOPS_PAT/);
      expect(src, f).not.toMatch(/console\./);
      expect(src, f).not.toMatch(/debugLog\([^)]*pat/i);
    }
  });
});
