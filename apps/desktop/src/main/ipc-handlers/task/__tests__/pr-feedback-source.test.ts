/**
 * zeenha fork: resolvePRRef picks the code host from a task's PR/MR URL.
 */
import { describe, expect, it, vi } from 'vitest';
import { resolvePRRef } from '../pr-feedback-source';

vi.mock('../../github/utils', () => ({ getGitHubConfig: () => null }));
vi.mock('../../gitlab/utils', () => ({ getGitLabConfig: async () => null, normalizeProjectReference: (p: string) => p }));
vi.mock('../../bitbucket/utils', () => ({ getBitbucketConfig: async () => null }));
vi.mock('../../azuredevops/utils', () => ({ getAzureDevOpsConfig: async () => null }));

describe('resolvePRRef', () => {
  it('resolves GitHub pull request URLs', () => {
    expect(resolvePRRef('https://github.com/o/r/pull/12')).toEqual({ provider: 'github', number: 12 });
  });

  it('resolves GitLab merge request URLs', () => {
    expect(resolvePRRef('https://gitlab.com/g/r/-/merge_requests/5')).toEqual({ provider: 'gitlab', number: 5 });
  });

  it('resolves Bitbucket pull request URLs', () => {
    expect(resolvePRRef('https://bitbucket.org/ws/repo/pull-requests/9')).toEqual({ provider: 'bitbucket', number: 9 });
    expect(resolvePRRef('https://bitbucket.org/ws/repo/pull-requests/9/diff')).toEqual({ provider: 'bitbucket', number: 9 });
  });

  it('resolves Azure DevOps pull request URLs', () => {
    expect(resolvePRRef('https://dev.azure.com/org/proj/_git/repo/pullrequest/14')).toEqual({
      provider: 'azuredevops',
      number: 14,
    });
    expect(resolvePRRef('https://org.visualstudio.com/proj/_git/repo/pullrequest/14')).toEqual({
      provider: 'azuredevops',
      number: 14,
    });
  });

  it.each([
    'https://dev.azure.com/org/proj/_git/repo/pullrequest/abc',
    'http://dev.azure.com/org/proj/_git/repo/pullrequest/14',
    'https://example.com/not-a-pr',
    'not a url',
    '',
    'https://bitbucket.org/ws/repo/pull-requests/abc',
    'https://bitbucket.org/ws/repo/commits/abc',
    'http://bitbucket.org/ws/repo/pull-requests/9',
    'https://evil.example/ws/repo/pull-requests/9',
  ])('returns null for %j', (url) => {
    expect(resolvePRRef(url)).toBeNull();
  });
});
