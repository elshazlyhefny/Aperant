import { describe, it, expect, assert, beforeEach, afterEach } from 'vitest';
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
  const config = { organization: 'acme', project: 'Proj', pat: PAT };

  beforeEach(() => {
    projectDir = mkdtempSync(path.join(tmpdir(), 'boards-spec-'));
    mkdirSync(path.join(projectDir, '.auto-claude', 'specs'), { recursive: true });
  });
  afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

  it('publishes the initial spec files on return, uses bug repro steps, and never writes the PAT', async () => {
    const result = await createSpecFromWorkItem({ path: projectDir, autoBuildPath: '.auto-claude' }, config, 42, item());
    assert(result.kind === 'created');
    expect(result.metadata).toMatchObject({
      sourceType: 'azure_boards',
      azureBoardsWorkItemId: 42,
      azureBoardsOrganization: 'acme',
      azureBoardsProject: 'Proj',
      azureBoardsUrl: item().url,
      category: 'bug_fix',
    });
    expect(result.description).toContain('**Azure Boards Work Item:** [AB#42]');
    expect(result.description).toContain('Click login');
    expect(result.description).toContain('## Acceptance Criteria');

    expect(JSON.parse(readFileSync(path.join(result.specDir, 'implementation_plan.json'), 'utf-8'))).toMatchObject({
      feature: 'Fix login',
      description: result.description,
      status: 'pending',
      phases: [],
    });
    expect(JSON.parse(readFileSync(path.join(result.specDir, 'requirements.json'), 'utf-8'))).toEqual({
      task_description: result.description,
      workflow_type: 'feature',
    });
    expect(JSON.parse(readFileSync(path.join(result.specDir, 'task_metadata.json'), 'utf-8'))).toEqual(result.metadata);

    for (const f of walk(projectDir)) {
      expect(readFileSync(f, 'utf-8')).not.toContain(PAT);
    }
  });

  it('reuses the original spec without changing its files in a custom auto-build path', async () => {
    const project = { path: projectDir, autoBuildPath: 'custom-build' };
    const specsDir = path.join(projectDir, 'custom-build', 'specs');
    const original = await createSpecFromWorkItem(project, config, 42, item());
    assert(original.kind === 'created');
    expect(original.specDir).toBe(path.join(specsDir, original.specId));
    const snapshot = () => walk(original.specDir).sort().map(file => [file, readFileSync(file)]);
    const originalFiles = snapshot();

    const reimport = await createSpecFromWorkItem(
      project,
      { organization: ' ACME ', project: ' pRoJ ' },
      42,
      item({ title: 'Renamed work item' })
    );

    expect(reimport).toEqual({ kind: 'existing', specId: original.specId });
    expect(readdirSync(specsDir)).toEqual([original.specId]);
    expect(readdirSync(path.join(projectDir, '.auto-claude', 'specs'))).toEqual([]);
    expect(snapshot()).toEqual(originalFiles);
  });

  it.each([
    { organization: 'other', project: 'Proj' },
    { organization: 'acme', project: 'OtherProject' },
  ])('creates a new spec for the same ID in $organization/$project', async (otherConfig) => {
    const project = { path: projectDir, autoBuildPath: '.auto-claude' };
    const original = await createSpecFromWorkItem(project, config, 42, item());
    assert(original.kind === 'created');

    const other = await createSpecFromWorkItem(project, otherConfig, 42, item());
    assert(other.kind === 'created');
    expect(other.specId).not.toBe(original.specId);
    const specsDir = path.join(projectDir, '.auto-claude', 'specs');
    expect(findExistingBoardsSpecs(specsDir, config.organization, config.project).get(42)).toBe(original.specId);
    expect(findExistingBoardsSpecs(specsDir, otherConfig.organization, otherConfig.project).get(42)).toBe(other.specId);
  });

  it('omits empty sections and maps non-bugs to feature', async () => {
    const r = await createSpecFromWorkItem(
      { path: projectDir, autoBuildPath: '.auto-claude' },
      config,
      42,
      item({ workItemType: 'Task', acceptanceCriteria: '', reproSteps: '' })
    );
    assert(r.kind === 'created');
    expect(r.metadata.category).toBe('feature');
    expect(r.description).not.toContain('## Description');
    expect(r.description).not.toContain('## Acceptance Criteria');
  });

  it('dedupe finds already imported items case-insensitively and ignores bad metadata', async () => {
    const project = { path: projectDir, autoBuildPath: '.auto-claude' };
    const r = await createSpecFromWorkItem(project, config, 42, item());
    assert(r.kind === 'created');
    const specsDir = path.join(projectDir, '.auto-claude', 'specs');
    mkdirSync(path.join(specsDir, 'broken'));
    writeFileSync(path.join(specsDir, 'broken', 'task_metadata.json'), '{nope', 'utf-8');

    const found = findExistingBoardsSpecs(specsDir, 'ACME', 'proj');
    expect(found.get(42)).toBe(r.specId);
    expect(findExistingBoardsSpecs(specsDir, 'other', 'Proj').size).toBe(0);
  });
});
