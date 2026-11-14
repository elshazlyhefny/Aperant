/**
 * Unit tests for Azure DevOps utils
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { Project } from '../../../../shared/types';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { getPath: () => '/tmp' } }));

import {
  getAzureDevOpsConfig,
  azureDevOpsFetch,
  azureDevOpsFetchText,
  createAzureDevOpsPullRequest,
  findOpenPullRequestForBranch,
  buildPullRequestWebUrl,
  parseAzureDevOpsRemoteUrl,
  azureDevOpsRemoteMatchesConfig,
  AzureDevOpsAPIError
} from '../utils';

const config = { organization: 'org', project: 'My Project', repository: 'my repo', pat: 'secret-pat' };
const fetchMock = vi.fn();
const jsonResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

describe('getAzureDevOpsConfig', () => {
  let dir: string;
  const makeProject = (env: string): Project => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(path.join(tmpdir(), 'ado-'));
    mkdirSync(path.join(dir, '.auto-claude'));
    writeFileSync(path.join(dir, '.auto-claude', '.env'), env);
    return { id: 'p', name: 'p', path: dir, autoBuildPath: '.auto-claude' } as unknown as Project;
  };
  const full =
    'AZURE_DEVOPS_ORGANIZATION=org\nAZURE_DEVOPS_PROJECT=My Project\nAZURE_DEVOPS_REPOSITORY=repo\nAZURE_DEVOPS_PAT=pat\n';

  it('returns config when complete', async () => {
    expect(await getAzureDevOpsConfig(makeProject(full))).toEqual({
      organization: 'org', project: 'My Project', repository: 'repo', pat: 'pat'
    });
  });
  it('returns null when disabled (case-insensitive)', async () => {
    expect(await getAzureDevOpsConfig(makeProject(`AZURE_DEVOPS_ENABLED=False\n${full}`))).toBeNull();
  });
  it('returns null when a key is missing', async () => {
    expect(await getAzureDevOpsConfig(makeProject(full.replace('AZURE_DEVOPS_PAT=pat\n', '')))).toBeNull();
    expect(await getAzureDevOpsConfig(makeProject(full.replace('AZURE_DEVOPS_PROJECT=My Project\n', '')))).toBeNull();
  });
  it('rejects invalid values', async () => {
    expect(await getAzureDevOpsConfig(makeProject(full.replace('org', 'bad org')))).toBeNull();
    expect(await getAzureDevOpsConfig(makeProject(full.replace('repo', 'a/b')))).toBeNull();
    expect(await getAzureDevOpsConfig(makeProject(full.replace('My Project', 'x'.repeat(300))))).toBeNull();
  });
  it('sanitises whitespace and caps PAT length', async () => {
    const env = `AZURE_DEVOPS_ORGANIZATION=  org  \nAZURE_DEVOPS_PROJECT= P \nAZURE_DEVOPS_REPOSITORY=r\nAZURE_DEVOPS_PAT=${'a'.repeat(600)}\n`;
    const result = await getAzureDevOpsConfig(makeProject(env));
    expect(result?.organization).toBe('org');
    expect(result?.project).toBe('P');
    expect(result?.pat.length).toBe(512);
  });
  it('returns null without autoBuildPath', async () => {
    expect(await getAzureDevOpsConfig({ id: 'p', path: '/tmp' } as unknown as Project)).toBeNull();
  });
});

describe('azureDevOpsFetch', () => {
  it('builds an encoded URL with api-version and an empty-username Basic header', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await azureDevOpsFetch(config, '/git/repositories/x');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://dev.azure.com/org/My%20Project/_apis/git/repositories/x?api-version=7.1');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from(':secret-pat').toString('base64')}`);
  });
  it('appends api-version with & when a query exists', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await azureDevOpsFetch(config, '/x?a=1');
    expect(fetchMock.mock.calls[0][0]).toContain('/x?a=1&api-version=7.1');
  });
  it.each(['//evil.com/x', 'git/x', 'https://evil.com'])('rejects endpoint %j', async (endpoint) => {
    await expect(azureDevOpsFetch(config, endpoint)).rejects.toThrow('relative path');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('errors carry status and clipped body but never the PAT or headers', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => 'x'.repeat(1000) });
    const err = await azureDevOpsFetch(config, '/x').catch((e: unknown) => e) as AzureDevOpsAPIError;
    expect(err).toBeInstanceOf(AzureDevOpsAPIError);
    expect(err.statusCode).toBe(401);
    expect(err.message.length).toBeLessThan(600);
    expect(err.message).not.toContain('secret-pat');
    expect(err.message).not.toContain('Basic');
  });
  it('maps abort to status 0', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    fetchMock.mockRejectedValue(abort);
    await expect(azureDevOpsFetch(config, '/x')).rejects.toMatchObject({ name: 'AzureDevOpsAPIError', statusCode: 0 });
  });
  it('fetchText returns text with text/plain accept', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'log' });
    expect(await azureDevOpsFetchText(config, '/x')).toBe('log');
    expect(fetchMock.mock.calls[0][1].headers.Accept).toBe('text/plain');
  });
});

describe('createAzureDevOpsPullRequest / findOpenPullRequestForBranch', () => {
  it('POSTs the expected body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ pullRequestId: 7 }));
    const result = await createAzureDevOpsPullRequest(config, {
      sourceBranch: 'feat', targetBranch: 'main', title: 'T', description: 'D', isDraft: true
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://dev.azure.com/org/My%20Project/_apis/git/repositories/my%20repo/pullrequests?api-version=7.1');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      sourceRefName: 'refs/heads/feat',
      targetRefName: 'refs/heads/main',
      title: 'T',
      description: 'D',
      isDraft: true
    });
    expect(result.pullRequestId).toBe(7);
  });
  it('find queries active PRs by encoded source ref', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ value: [{ pullRequestId: 1 }, { pullRequestId: 2 }] }));
    expect(await findOpenPullRequestForBranch(config, 'feat/x y')).toEqual({ pullRequestId: 1 });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get('searchCriteria.status')).toBe('active');
    expect(url.searchParams.get('searchCriteria.sourceRefName')).toBe('refs/heads/feat/x y');
    expect(url.searchParams.get('api-version')).toBe('7.1');
  });
  it('find returns null when none', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ value: [] }));
    expect(await findOpenPullRequestForBranch(config, 'feat')).toBeNull();
  });
});

describe('buildPullRequestWebUrl', () => {
  it('encodes segments', () => {
    expect(buildPullRequestWebUrl(config, 42)).toBe(
      'https://dev.azure.com/org/My%20Project/_git/my%20repo/pullrequest/42'
    );
  });
});

describe('parseAzureDevOpsRemoteUrl', () => {
  const expected = { organization: 'org', project: 'proj', repository: 'repo' };
  it.each([
    'https://dev.azure.com/org/proj/_git/repo',
    'https://dev.azure.com/org/proj/_git/repo.git',
    'https://org@dev.azure.com/org/proj/_git/repo',
    'git@ssh.dev.azure.com:v3/org/proj/repo',
    'https://org.visualstudio.com/proj/_git/repo',
    'https://org.visualstudio.com/DefaultCollection/proj/_git/repo',
    'org@vs-ssh.visualstudio.com:v3/org/proj/repo'
  ])('parses %s', (url) => {
    expect(parseAzureDevOpsRemoteUrl(url)).toEqual(expected);
  });
  it('percent-decodes names', () => {
    expect(parseAzureDevOpsRemoteUrl('https://dev.azure.com/org/My%20Project/_git/my%20repo')).toEqual({
      organization: 'org', project: 'My Project', repository: 'my repo'
    });
    expect(parseAzureDevOpsRemoteUrl('git@ssh.dev.azure.com:v3/org/My%20Project/my%20repo')?.project).toBe('My Project');
  });
  it('returns null for anything else', () => {
    expect(parseAzureDevOpsRemoteUrl('')).toBeNull();
    expect(parseAzureDevOpsRemoteUrl('git@github.com:a/b.git')).toBeNull();
    expect(parseAzureDevOpsRemoteUrl('https://dev.azure.com/org/proj')).toBeNull();
    expect(parseAzureDevOpsRemoteUrl('https://dev.azure.com/org/%E0%A4%A/_git/repo')).toBeNull();
  });
});

describe('azureDevOpsRemoteMatchesConfig', () => {
  it('compares case-insensitively', () => {
    expect(
      azureDevOpsRemoteMatchesConfig('https://dev.azure.com/ORG/my project/_git/MY REPO'.replace(/ /g, '%20'), config)
    ).toBe(true);
  });
  it('rejects mismatches and non-azure remotes', () => {
    expect(azureDevOpsRemoteMatchesConfig('https://dev.azure.com/other/p/_git/r', config)).toBe(false);
    expect(azureDevOpsRemoteMatchesConfig('git@github.com:a/b.git', config)).toBe(false);
  });
});
