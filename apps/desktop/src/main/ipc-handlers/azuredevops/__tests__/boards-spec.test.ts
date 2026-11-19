import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createSpecFromWorkItem, findExistingBoardsSpecs } from '../boards-spec';
import type { AzureBoardsWorkItemData } from '../boards-client';

const PAT = 'SECRET-PAT-VALUE-123';

function item(overrides: Partial<AzureBoardsWorkItemData> = {}): AzureBoardsWorkItemData {
  return {
    id: 42,
    title: 'Fix login',
    workItemType: 'Bug',
    state: 'Active',
    areaPath: 'Proj\\Web',
    tags: ['a', 'b'],
    description: '',
    acceptanceCriteria: '<p>Works</p>',
    reproSteps: '<p>Click login</p>',
    url: 'https://dev.azure.com/acme/Proj/_workitems/edit/42',
    ...overrides,
  };
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]
  );
}

describe('boards-spec', () => {
  let projectDir: string;
  const config = { organization: 'acme', project: 'Proj', pat: PAT } as never;

  beforeEach(() => {
    projectDir = mkdtempSync(path.join(tmpdir(), 'boards-spec-'));
    mkdirSync(path.join(projectDir, '.auto-claude', 'specs'), { recursive: true });
  });
  afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

  it('writes metadata, uses repro steps for empty bug description and never writes the PAT', async () => {
    const result = await createSpecFromWorkItem({ path: projectDir, autoBuildPath: '.auto-claude' }, config, item());
    expect(result.metadata).toMatchObject({
      sourceType: 'azure_boards',
      azureBoardsWorkItemId: 42,
      azureBoardsOrganization: 'acme',
      azureBoardsProject: 'Proj',
      category: 'bug_fix',
    });
    expect(result.description).toContain('**Azure Boards Work Item:** [AB#42]');
    expect(result.description).toContain('Click login');
    expect(result.description).toContain('## Acceptance Criteria');

    for (const f of walk(projectDir)) {
      expect(readFileSync(f, 'utf-8')).not.toContain(PAT);
    }
  });

  it('omits empty sections and maps non-bugs to feature', async () => {
    const r = await createSpecFromWorkItem(
      { path: projectDir, autoBuildPath: '.auto-claude' },
      config,
      item({ workItemType: 'Task', acceptanceCriteria: '', reproSteps: '' })
    );
    expect(r.metadata.category).toBe('feature');
    expect(r.description).not.toContain('## Description');
    expect(r.description).not.toContain('## Acceptance Criteria');
  });

  it('dedupe finds already imported items case-insensitively and ignores bad metadata', async () => {
    const project = { path: projectDir, autoBuildPath: '.auto-claude' };
    const r = await createSpecFromWorkItem(project, config, item());
    const specsDir = path.join(projectDir, '.auto-claude', 'specs');
    mkdirSync(path.join(specsDir, 'broken'));
    writeFileSync(path.join(specsDir, 'broken', 'task_metadata.json'), '{nope', 'utf-8');

    const found = findExistingBoardsSpecs(specsDir, 'ACME', 'proj');
    expect(found.get(42)).toBe(r.specId);
    expect(findExistingBoardsSpecs(specsDir, 'other', 'Proj').size).toBe(0);
  });
});
