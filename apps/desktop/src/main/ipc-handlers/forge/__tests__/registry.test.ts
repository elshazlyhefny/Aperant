/**
 * zeenha fork: the forge registry is the only place providers are known. A new
 * provider needs one implementation plus one registry entry.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import integrationCapabilities from '../../../../../../../guides/integration-capabilities.json';
import { notConfiguredBlockedReason } from '../../../../shared/types/pr-feedback';
import { jiraWriter } from '../../jira/jira-writeback';
import { loadPRFeedback } from '../../task/pr-feedback-source';
import { azureBoardsWriter } from '../azureboards-writer';
import { OUTCOME_WRITERS, createForgeRegistry, getForgeForPrUrl, getOutcomeWriter } from '../registry';
import type { Forge } from '../types';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false, on: vi.fn() } }));
vi.mock('../../../app-logger', () => ({ appLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../../jira/jira-config', () => ({ getJiraConfig: () => null }));
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

  // Resolve only the URL, without loading feedback or looking up configuration.
  it.each([
    ['azure-devops-services', 'https://dev.azure.com/org/project/_git/repo/pullrequest/7', 'azuredevops'],
    ['azure-devops-server', 'https://tfs.example.test/tfs/Collection/project/_git/repo/pullrequest/7', null],
    ['bitbucket-cloud', 'https://bitbucket.org/workspace/repo/pull-requests/7', 'bitbucket'],
    ['bitbucket-server', 'https://bitbucket.example.test/projects/PROJ/repos/repo/pull-requests/7/overview', null],
    ['bitbucket-data-center', 'https://bitbucket-dc.example.test/projects/PROJ/repos/repo/pull-requests/7/overview', null],
  ] as const)('matches the published edition support for %s', (id, url, provider) => {
    const resolved = getForgeForPrUrl(url);
    if (provider === null) {
      expect(resolved).toBeNull();
    } else {
      expect(resolved?.forge.providerId).toBe(provider);
      expect(resolved?.ref).toEqual({ provider, number: 7 });
    }
    const row = integrationCapabilities.find((row) => row.id === id);
    expect(row?.editionSupported).toBe(resolved !== null);
    expect(row?.prProviderId).toBe(provider ?? undefined);
  });
});

describe('getOutcomeWriter', () => {
  it('finds github, gitlab and linear writers', () => {
    expect(getOutcomeWriter('github')?.sourceType).toBe('github');
    expect(getOutcomeWriter('gitlab')?.sourceType).toBe('gitlab');
    expect(getOutcomeWriter('linear')?.settingKey).toBe('linear');
    expect(getOutcomeWriter('jira-unknown')).toBeUndefined();
  });

  it('finds the jira writer, which uses isEnabled instead of a settingKey', () => {
    expect(getOutcomeWriter('jira')?.sourceType).toBe('jira');
    expect(getOutcomeWriter('jira')).toBe(jiraWriter);
    expect(jiraWriter.settingKey).toBeUndefined();
    expect(typeof jiraWriter.isEnabled).toBe('function');
  });

  it('finds the azure boards writer; the azuredevops PRHost is not a writer', () => {
    expect(getOutcomeWriter('azure_boards')).toBe(azureBoardsWriter);
    expect(azureBoardsWriter.settingKey).toBe('azureboards');
    expect(getOutcomeWriter('azuredevops')).toBeUndefined();
  });

  it('a custom registry supports a writer with isEnabled', () => {
    const custom = {
      sourceType: 'custom',
      isEnabled: () => true,
      postOutcome: vi.fn(),
    };
    const registry = createForgeRegistry([], [custom]);
    expect(registry.getOutcomeWriter('custom')).toBe(custom);
    expect(registry.writers).toContain(custom);
  });
});

describe('published outcome write-back capabilities', () => {
  // Decision recorded in forge/README.md, section "Not planned: Bitbucket issue
  // writeback". If you add Bitbucket issue import, revisit it and update this test.
  it('matches the desktop writer registry, excluding Bitbucket and Azure DevOps PRs', () => {
    const publishedSourceTypes = integrationCapabilities
      .filter((row) => row.outcomeComments.desktop !== 'unsupported')
      .map((row) => row.sourceType)
      .sort();
    expect(getOutcomeWriter('bitbucket')).toBeUndefined();
    expect(getOutcomeWriter('azuredevops')).toBeUndefined();
    expect(OUTCOME_WRITERS.map((w) => w.sourceType).sort()).toEqual(publishedSourceTypes);
  });

  it('publishes only the optional review-ready transitions covered by the writer behavior tests', () => {
    const publishedTransitions = Object.fromEntries(
      integrationCapabilities
        .filter((row) => row.transition)
        .map((row) => [row.sourceType, row.transition]),
    );
    expect(publishedTransitions).toEqual({
      jira: { type: 'status', event: 'review_ready', surfaces: ['desktop', 'headless'] },
      azure_boards: { type: 'state', event: 'review_ready', surfaces: ['desktop', 'headless'] },
      linear: { type: 'state', event: 'review_ready', surfaces: ['desktop'] },
    });
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
    expect(notConfiguredBlockedReason('gitea')).toBe('not_configured');
    expect(notConfiguredBlockedReason('github')).toBe('no_github_config');
    expect(notConfiguredBlockedReason('bitbucket')).toBe('no_bitbucket_config');
    expect(notConfiguredBlockedReason('azuredevops')).toBe('no_azuredevops_config');
  });
});
