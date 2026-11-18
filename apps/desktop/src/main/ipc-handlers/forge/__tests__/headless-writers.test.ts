/**
 * zeenha fork: the headless writers load without Electron and return an
 * awaitable promise that resolves even when the network call fails.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '../../../../shared/constants/config';
import type { Project } from '../../../../shared/types';
import { createHeadlessWriters } from '../headless-writers';

const settings = DEFAULT_APP_SETTINGS.issueWriteback;

describe('createHeadlessWriters', () => {
  let dir: string;
  const makeProject = (env: string): Project => {
    mkdirSync(path.join(dir, '.auto-claude'), { recursive: true });
    writeFileSync(path.join(dir, '.auto-claude', '.env'), env);
    return { id: 'p', name: 'p', path: dir, autoBuildPath: '.auto-claude' } as Project;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'headless-writers-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('lists github, gitlab, linear, jira and azure boards writers', () => {
    expect(createHeadlessWriters({}).map((w) => w.sourceType)).toEqual(['github', 'gitlab', 'linear', 'jira', 'azure_boards']);
  });

  it('github postOutcome resolves when fetch throws, using the env token fallback', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    const project = makeProject('GITHUB_REPO=o/r\n');
    const writer = createHeadlessWriters({ GH_TOKEN: 'tok' })[0];
    const result = writer.postOutcome({
      meta: { githubIssueNumber: 5, githubUrl: 'https://github.com/o/r/issues/5' },
      project,
      event: 'task_completed' as never,
      text: 'done',
      settings,
    });
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalled();
  });

  it('gitlab postOutcome resolves when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const project = makeProject('GITLAB_PROJECT=g/r\n');
    const writer = createHeadlessWriters({ GITLAB_TOKEN: 'tok' })[1];
    const result = writer.postOutcome({
      meta: { gitlabIssueIid: 3, gitlabUrl: 'https://gitlab.com/g/r/-/issues/3' },
      project,
      event: 'task_completed' as never,
      text: 'done',
      settings,
    });
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });

  it('azure boards postOutcome resolves when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const project = makeProject(
      'AZURE_DEVOPS_ORGANIZATION=org\nAZURE_DEVOPS_PROJECT=proj\nAZURE_DEVOPS_REPOSITORY=repo\nAZURE_DEVOPS_PAT=tok\n'
    );
    const writer = createHeadlessWriters({})[4];
    const result = writer.postOutcome({
      meta: {
        sourceType: 'azure_boards',
        azureBoardsWorkItemId: 5,
        azureBoardsOrganization: 'org',
        azureBoardsProject: 'proj',
      },
      project,
      event: 'task_completed' as never,
      text: 'done',
      settings,
    });
    await expect(result).resolves.toBeUndefined();
  });

  it('returns nothing when the task has no matching issue metadata', () => {
    const writer = createHeadlessWriters({})[0];
    expect(
      writer.postOutcome({ meta: {}, project: makeProject(''), event: 'task_completed' as never, text: 'x', settings })
    ).toBeUndefined();
  });
});
