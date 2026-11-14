/**
 * zeenha fork: the forge registry is the only place providers are known. A new
 * provider needs one implementation plus one registry entry.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { notConfiguredBlockedReason } from '../../../../shared/types/pr-feedback';
import { loadPRFeedback } from '../../task/pr-feedback-source';
import { createForgeRegistry, getForgeForPrUrl, getOutcomeWriter } from '../registry';
import type { Forge } from '../types';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false, on: vi.fn() } }));
vi.mock('../../../app-logger', () => ({ appLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../../linear-client', () => ({ getLinearApiKey: () => null, linearGraphQL: vi.fn() }));

const cfg = vi.hoisted(() => ({
  github: { token: 't', repo: 'o/r' } as { token: string; repo: string } | null,
  gitlab: { token: 't', instanceUrl: 'https://gitlab.com', project: 'g/r' } as {
    token: string;
    instanceUrl: string;
    project: string;
  } | null,
}));
const feedbackError = vi.hoisted(() => ({ throwError: false }));

vi.mock('../../github/utils', () => ({
  getGitHubConfig: () => cfg.github,
  githubFetch: vi.fn(),
  normalizeRepoReference: (r: string) => r,
}));

vi.mock('../../github/pr/task-feedback', () => {
  class PRFeedbackError extends Error {}
  return {
    PRFeedbackError,
    parsePRNumberFromUrl: (u: string) => {
      const m = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)$/.exec(u);
      return m ? Number(m[1]) : null;
    },
    fetchPRFeedback: async () => {
      if (feedbackError.throwError) throw new PRFeedbackError('boom');
      return { prNumber: 7, checks: [], threads: [], reviews: [] };
    },
  };
});

vi.mock('../../gitlab/utils', () => ({
  GitLabAPIError: class extends Error {},
  getGitLabConfig: async () => cfg.gitlab,
  gitlabFetch: vi.fn(),
  encodeProjectPath: (p: string) => p,
  normalizeProjectReference: (p: string) => p,
}));

vi.mock('../../gitlab/mr-feedback', () => {
  const parse = (u: string) => {
    try {
      const m = /^\/((?:[^/]+\/)*[^/]+)\/-\/merge_requests\/(\d+)$/.exec(new URL(u).pathname);
      return m ? { iid: Number(m[2]), projectPath: m[1] } : null;
    } catch {
      return null;
    }
  };
  return {
    parseMergeRequestUrl: parse,
    parseMRIidFromUrl: (u: string) => parse(u)?.iid ?? null,
    fetchMRFeedback: async () => ({ prNumber: 7, checks: [], threads: [], reviews: [] }),
  };
});

const project = { id: 'p', path: '/tmp/p', autoBuildPath: '.auto-claude' } as never;
const GH = 'https://github.com/o/r/pull/7';
const GL = 'https://gitlab.com/g/r/-/merge_requests/7';

beforeEach(() => {
  cfg.github = { token: 't', repo: 'o/r' };
  cfg.gitlab = { token: 't', instanceUrl: 'https://gitlab.com', project: 'g/r' };
  feedbackError.throwError = false;
});

describe('getForgeForPrUrl', () => {
  it('resolves GitHub and GitLab URLs and rejects junk', () => {
    const gh = getForgeForPrUrl(GH);
    expect(gh?.forge.providerId).toBe('github');
    expect(gh?.ref).toEqual({ provider: 'github', number: 7 });
    const gl = getForgeForPrUrl(GL);
    expect(gl?.forge.providerId).toBe('gitlab');
    expect(gl?.ref).toEqual({ provider: 'gitlab', number: 7 });
    expect(getForgeForPrUrl('not a url')).toBeNull();
    expect(getForgeForPrUrl('https://example.com/x')).toBeNull();
  });
});

describe('getOutcomeWriter', () => {
  it('finds github, gitlab and linear writers', () => {
    expect(getOutcomeWriter('github')?.sourceType).toBe('github');
    expect(getOutcomeWriter('gitlab')?.sourceType).toBe('gitlab');
    expect(getOutcomeWriter('linear')?.settingKey).toBe('linear');
    expect(getOutcomeWriter('jira-unknown')).toBeUndefined();
  });
});

describe('a new provider needs one implementation and one registry entry', () => {
  it('resolves, loads feedback and finds the writer for a fake bitbucket forge', async () => {
    const postOutcome = vi.fn();
    const bitbucket: Forge = {
      providerId: 'bitbucket',
      sourceType: 'bitbucket',
      settingKey: 'github',
      notConfiguredMessage: 'Bitbucket is not configured.',
      resolvePR: (url) => {
        const m = /^https:\/\/bitbucket\.org\/[^/]+\/[^/]+\/pull-requests\/(\d+)$/.exec(url);
        return m ? { provider: 'bitbucket', number: Number(m[1]) } : null;
      },
      loadFeedback: async () => ({
        ok: true,
        fetched: { prNumber: 3, checks: [], threads: [], reviews: [] } as never,
      }),
      postOutcome,
    };
    const registry = createForgeRegistry([bitbucket]);
    const url = 'https://bitbucket.org/w/r/pull-requests/3';
    const found = registry.getForgeForPrUrl(url);
    if (!found) throw new Error('bitbucket URL not resolved');
    expect(found.ref).toEqual({ provider: 'bitbucket', number: 3 });
    const loaded = await found.forge.loadFeedback(project, url, found.ref);
    expect(loaded.ok).toBe(true);
    expect(registry.getOutcomeWriter('bitbucket')).toBe(bitbucket);
    expect(registry.getForgeForPrUrl(GH)).toBeNull();
  });
});

describe('loadPRFeedback', () => {
  it('reports not_configured with the provider when config is missing', async () => {
    cfg.github = null;
    expect(await loadPRFeedback(project, GH, { provider: 'github', number: 7 })).toMatchObject({
      ok: false,
      code: 'not_configured',
      provider: 'github',
    });
    cfg.gitlab = null;
    expect(await loadPRFeedback(project, GL, { provider: 'gitlab', number: 7 })).toMatchObject({
      ok: false,
      code: 'not_configured',
      provider: 'gitlab',
    });
  });

  it('reports fetch_failed when the forge throws PRFeedbackError', async () => {
    feedbackError.throwError = true;
    expect(await loadPRFeedback(project, GH, { provider: 'github', number: 7 })).toMatchObject({
      ok: false,
      code: 'fetch_failed',
    });
  });

  it('reports fetch_failed for an unknown provider', async () => {
    expect(await loadPRFeedback(project, GH, { provider: 'nope', number: 7 })).toMatchObject({
      ok: false,
      code: 'fetch_failed',
    });
  });
});

describe('not_configured IPC code', () => {
  it('maps an unlisted provider to the generic code', () => {
    expect(notConfiguredBlockedReason('bitbucket')).toBe('not_configured');
    expect(notConfiguredBlockedReason('github')).toBe('no_github_config');
  });
});
