/**
 * Unit tests for Bitbucket utils
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { Project } from '../../../../shared/types';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { getPath: () => '/tmp' } }));

import {
  sanitizeToken,
  sanitizeRepoRef,
  parseBitbucketRemoteUrl,
  getBitbucketConfig,
  getSafeNextEndpoint,
  createBitbucketPullRequest,
  findOpenPullRequestForBranch,
  BitbucketAPIError
} from '../utils';

describe('createBitbucketPullRequest / findOpenPullRequestForBranch', () => {
  const config = { username: 'alice', token: 'tok', repository: 'ws/repo' };
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  const jsonResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  it('POSTs the expected body and returns the PR', async () => {
    const pr = { id: 7, links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/7' } } };
    fetchMock.mockResolvedValue(jsonResponse(pr));
    const result = await createBitbucketPullRequest(config, {
      sourceBranch: 'feat', destinationBranch: 'main', title: 'T', description: 'D'
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      title: 'T',
      description: 'D',
      source: { branch: { name: 'feat' } },
      destination: { branch: { name: 'main' } }
    });
    expect(result.links?.html?.href).toBe('https://bitbucket.org/ws/repo/pull-requests/7');
  });

  it('surfaces a 400 as BitbucketAPIError', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, statusText: 'Bad Request', text: async () => 'nope' });
    await expect(
      createBitbucketPullRequest(config, { sourceBranch: 'a', destinationBranch: 'b', title: 't', description: '' })
    ).rejects.toMatchObject({ name: 'BitbucketAPIError', statusCode: 400 });
  });

  it('find returns the first value', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ values: [{ id: 1 }, { id: 2 }] }));
    expect(await findOpenPullRequestForBranch(config, 'feat')).toEqual({ id: 1 });
  });

  it('find returns null when none', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ values: [] }));
    expect(await findOpenPullRequestForBranch(config, 'feat')).toBeNull();
  });

  it('find URL-encodes q and escapes quotes/backslashes', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ values: [] }));
    await findOpenPullRequestForBranch(config, 'a"b\\c');
    const url = fetchMock.mock.calls[0][0] as string;
    const q = new URL(url).searchParams.get('q');
    expect(q).toBe('source.branch.name="a\\"b\\\\c" AND state="OPEN"');
    expect(url).toContain('pagelen=1');
    expect(url).not.toContain(' ');
    expect(url).not.toContain('"');
  });
});

describe('sanitizeToken', () => {
  it('strips control characters and trims', () => {
    expect(sanitizeToken('  ab\ncd\x00ef\x7f ')).toBe('abcdef');
  });
  it('returns null for empty input', () => {
    expect(sanitizeToken(undefined)).toBeNull();
    expect(sanitizeToken('  \n ')).toBeNull();
  });
  it('caps length at 512', () => {
    expect(sanitizeToken('a'.repeat(600))?.length).toBe(512);
  });
});

describe('sanitizeRepoRef', () => {
  it('accepts workspace/repo_slug', () => {
    expect(sanitizeRepoRef('my-ws/my_repo.v2')).toBe('my-ws/my_repo.v2');
  });
  it('strips control characters', () => {
    expect(sanitizeRepoRef('ws/\nrepo')).toBe('ws/repo');
  });
  it.each(['', 'justone', 'a/b/c', '../x/y', 'ws/re po', 'ws/repo?x=1', '/repo', 'ws/'])(
    'rejects %j',
    (value) => {
      expect(sanitizeRepoRef(value)).toBeNull();
    }
  );
  it('rejects overly long refs', () => {
    expect(sanitizeRepoRef(`ws/${'a'.repeat(300)}`)).toBeNull();
  });
});

describe('parseBitbucketRemoteUrl', () => {
  it('parses ssh', () => {
    expect(parseBitbucketRemoteUrl('git@bitbucket.org:ws/repo.git')).toEqual({
      workspace: 'ws', repoSlug: 'repo', fullName: 'ws/repo'
    });
  });
  it('parses https', () => {
    expect(parseBitbucketRemoteUrl('https://bitbucket.org/ws/repo.git')?.fullName).toBe('ws/repo');
  });
  it('parses https with user', () => {
    expect(parseBitbucketRemoteUrl('https://alice@bitbucket.org/ws/repo.git')?.fullName).toBe('ws/repo');
  });
  it('parses without .git suffix', () => {
    expect(parseBitbucketRemoteUrl('https://bitbucket.org/ws/repo')?.repoSlug).toBe('repo');
  });
  it('returns null for other hosts or empty', () => {
    expect(parseBitbucketRemoteUrl('git@github.com:ws/repo.git')).toBeNull();
    expect(parseBitbucketRemoteUrl('')).toBeNull();
  });
});

describe('getSafeNextEndpoint', () => {
  it('accepts next on the API origin', () => {
    expect(getSafeNextEndpoint('https://api.bitbucket.org/2.0/repositories/a/b/pullrequests?page=2'))
      .toBe('/repositories/a/b/pullrequests?page=2');
  });
  it('rejects foreign origins', () => {
    expect(getSafeNextEndpoint('https://evil.example.com/2.0/x')).toBeNull();
    expect(getSafeNextEndpoint(undefined)).toBeNull();
  });
});

describe('BitbucketAPIError', () => {
  it('carries status code', () => {
    expect(new BitbucketAPIError('x', 404).statusCode).toBe(404);
  });
});

describe('getBitbucketConfig', () => {
  let dir: string;
  const makeProject = (env: string): Project => {
    dir = mkdtempSync(path.join(tmpdir(), 'bb-'));
    mkdirSync(path.join(dir, '.auto-claude'));
    writeFileSync(path.join(dir, '.auto-claude', '.env'), env);
    return { id: 'p', name: 'p', path: dir, autoBuildPath: '.auto-claude' } as unknown as Project;
  };

  beforeEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('returns config when complete', async () => {
    const project = makeProject('BITBUCKET_USERNAME=alice\nBITBUCKET_TOKEN=tok\nBITBUCKET_REPOSITORY=ws/repo\n');
    expect(await getBitbucketConfig(project)).toEqual({ username: 'alice', token: 'tok', repository: 'ws/repo' });
  });
  it('returns null when disabled', async () => {
    const project = makeProject('BITBUCKET_ENABLED=false\nBITBUCKET_USERNAME=a\nBITBUCKET_TOKEN=t\nBITBUCKET_REPOSITORY=ws/repo\n');
    expect(await getBitbucketConfig(project)).toBeNull();
  });
  it('returns null when incomplete or invalid repo', async () => {
    expect(await getBitbucketConfig(makeProject('BITBUCKET_USERNAME=a\nBITBUCKET_REPOSITORY=ws/repo\n'))).toBeNull();
    expect(await getBitbucketConfig(makeProject('BITBUCKET_USERNAME=a\nBITBUCKET_TOKEN=t\nBITBUCKET_REPOSITORY=bad\n'))).toBeNull();
  });
  it('returns null without autoBuildPath', async () => {
    expect(await getBitbucketConfig({ id: 'p', path: '/tmp' } as unknown as Project)).toBeNull();
  });
});
