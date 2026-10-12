/**
 * zeenha fork: GitHub issue triage handlers, now reachable from the app.
 *
 * GitHub is mocked at githubFetch, so every request the handlers would send to
 * the real repository is visible here: the label writes above all, because
 * they change the user's repository.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../shared/constants';

type Fn = (...args: unknown[]) => Promise<unknown>;
const handlers = vi.hoisted(() => new Map<string, Fn>());
const listeners = vi.hoisted(() => new Map<string, Fn>());
const sent = vi.hoisted(() => ({ progress: vi.fn(), complete: vi.fn(), error: vi.fn() }));
const mockTriageBatchIssues = vi.hoisted(() => vi.fn());
const mockGithubFetch = vi.hoisted(() => vi.fn());
const githubConfig = vi.hoisted(() => ({ current: { token: 'tok', repo: 'o/r' } as null | { token: string; repo: string } }));
const projectRef = vi.hoisted(() => ({ current: null as null | { id: string; path: string } }));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Fn) => handlers.set(channel, fn),
    on: (channel: string, fn: Fn) => listeners.set(channel, fn),
  },
}));
vi.mock('../utils/ipc-communicator', () => ({
  createIPCCommunicators: () => ({
    sendProgress: sent.progress,
    sendComplete: sent.complete,
    sendError: sent.error,
  }),
}));
vi.mock('../utils/project-middleware', () => ({
  withProjectOrNull: async (_id: string, handler: (p: unknown) => Promise<unknown>) =>
    projectRef.current ? handler(projectRef.current) : null,
}));
vi.mock('../utils', () => ({
  getGitHubConfig: () => githubConfig.current,
  githubFetch: (...args: unknown[]) => mockGithubFetch(...args),
}));
vi.mock('../../../settings-utils', () => ({ readSettingsFile: () => ({}) }));
vi.mock('../utils/logger', () => ({ createContextLogger: () => ({ debug: vi.fn() }) }));
vi.mock('../../../ai/runners/github/triage-engine', () => ({
  triageBatchIssues: (...args: unknown[]) => mockTriageBatchIssues(...args),
}));

import { GITHUB_NOT_CONFIGURED_MESSAGE, registerTriageHandlers } from '../triage-handlers';

registerTriageHandlers(() => ({}) as never);

const invoke = (channel: string, ...args: unknown[]) => {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return fn({}, ...args);
};
const runTriage = (...args: unknown[]) => {
  const fn = listeners.get(IPC_CHANNELS.GITHUB_TRIAGE_RUN);
  if (!fn) throw new Error('no run listener');
  return fn({}, ...args);
};

let dir: string;
const githubDir = () => path.join(dir, '.auto-claude', 'github');
const readJson = (file: string) => JSON.parse(fs.readFileSync(path.join(githubDir(), file), 'utf-8'));

function writeResult(issueNumber: number, overrides: Record<string, unknown> = {}) {
  fs.mkdirSync(path.join(githubDir(), 'issues'), { recursive: true });
  fs.writeFileSync(
    path.join(githubDir(), 'issues', `triage_${issueNumber}.json`),
    JSON.stringify({
      issue_number: issueNumber,
      repo: 'o/r',
      category: 'bug',
      confidence: 0.9,
      labels_to_add: ['bug'],
      labels_to_remove: [],
      triaged_at: '2026-10-01T00:00:00.000Z',
      ...overrides,
    }),
  );
}

const engineResult = (issueNumber: number, overrides: Record<string, unknown> = {}) => ({
  issueNumber,
  repo: 'o/r',
  category: 'duplicate',
  confidence: 0.85,
  labelsToAdd: [],
  labelsToRemove: [],
  isDuplicate: true,
  duplicateOf: 7,
  isSpam: true,
  isFeatureCreep: true,
  suggestedBreakdown: [],
  priority: 'low',
  comment: null,
  ...overrides,
});

const openIssues = [
  { number: 1, title: 'a', user: { login: 'u' }, created_at: 'x' },
  { number: 2, title: 'pr', user: { login: 'u' }, created_at: 'x', pull_request: {} },
];

/** Repository labels, then 200s for every write. */
function githubWith(labels: string[], overrides: (endpoint: string, init?: RequestInit) => unknown = () => undefined) {
  mockGithubFetch.mockImplementation(async (_token: string, endpoint: string, init?: RequestInit) => {
    const custom = overrides(endpoint, init);
    if (custom !== undefined) return custom instanceof Error ? Promise.reject(custom) : custom;
    if (endpoint.startsWith('/repos/o/r/labels')) return labels.map((name) => ({ name }));
    return [];
  });
}
const writes = () =>
  mockGithubFetch.mock.calls
    .filter(([, , init]) => init && (init as RequestInit).method)
    .map(([, endpoint, init]) => ({ method: (init as RequestInit).method, endpoint, body: (init as RequestInit).body }));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-triage-'));
  projectRef.current = { id: 'p1', path: dir };
  githubConfig.current = { token: 'tok', repo: 'o/r' };
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
  mockGithubFetch.mockReset();
  mockTriageBatchIssues.mockReset();
});

describe('triage config', () => {
  it('returns the defaults when nothing is saved', async () => {
    expect(await invoke(IPC_CHANNELS.GITHUB_TRIAGE_GET_CONFIG, 'p1')).toEqual({
      enabled: false,
      duplicateThreshold: 0.8,
      spamThreshold: 0.75,
      featureCreepThreshold: 0.7,
      enableComments: false,
    });
  });

  it('saves a valid config and keeps the other keys of config.json', async () => {
    fs.mkdirSync(githubDir(), { recursive: true });
    fs.writeFileSync(path.join(githubDir(), 'config.json'), JSON.stringify({ auto_fix_enabled: true }));
    const config = { enabled: true, duplicateThreshold: 0.9, spamThreshold: 0.5, featureCreepThreshold: 0.6, enableComments: false };

    expect(await invoke(IPC_CHANNELS.GITHUB_TRIAGE_SAVE_CONFIG, 'p1', config)).toBe(true);

    expect(readJson('config.json')).toMatchObject({ auto_fix_enabled: true, triage_enabled: true, duplicate_threshold: 0.9, spam_threshold: 0.5 });
    expect(await invoke(IPC_CHANNELS.GITHUB_TRIAGE_GET_CONFIG, 'p1')).toEqual(config);
  });

  it.each([
    ['a threshold above 1', { duplicateThreshold: 1.5 }],
    ['a negative threshold', { spamThreshold: -0.1 }],
    ['a threshold that is not a number', { featureCreepThreshold: '0.7' }],
    ['a flag that is not a boolean', { enabled: 'yes' }],
  ])('refuses %s and writes nothing', async (_name, bad) => {
    const config = { enabled: true, duplicateThreshold: 0.9, spamThreshold: 0.5, featureCreepThreshold: 0.6, enableComments: false, ...bad };

    expect(await invoke(IPC_CHANNELS.GITHUB_TRIAGE_SAVE_CONFIG, 'p1', config)).toBe(false);
    expect(fs.existsSync(path.join(githubDir(), 'config.json'))).toBe(false);
  });

  it('reads the saved results newest first, with when their labels were applied', async () => {
    writeResult(1, { triaged_at: '2026-10-01T00:00:00.000Z' });
    writeResult(2, { triaged_at: '2026-10-02T00:00:00.000Z', labels_applied_at: '2026-10-03T00:00:00.000Z' });

    const results = (await invoke(IPC_CHANNELS.GITHUB_TRIAGE_GET_RESULTS, 'p1')) as Array<Record<string, unknown>>;

    expect(results.map((r) => r.issueNumber)).toEqual([2, 1]);
    expect(results[0].labelsAppliedAt).toBe('2026-10-03T00:00:00.000Z');
    expect(results[1].labelsAppliedAt).toBeUndefined();
  });
});

describe('triage run', () => {
  it('reports an unknown project instead of ending without an event', async () => {
    projectRef.current = null;

    await runTriage('nope');

    expect(sent.error).toHaveBeenCalledWith('Project not found');
    expect(sent.complete).not.toHaveBeenCalled();
  });

  it('says how to configure GitHub when the project has no configuration', async () => {
    githubConfig.current = null;

    await runTriage('p1');

    expect(sent.error).toHaveBeenCalledWith(GITHUB_NOT_CONFIGURED_MESSAGE);
    expect(mockGithubFetch).not.toHaveBeenCalled();
  });

  it('reports a GitHub API failure as the run error', async () => {
    mockGithubFetch.mockRejectedValue(new Error('GitHub API error: 401 - Bad credentials'));

    await runTriage('p1');

    expect(sent.error).toHaveBeenCalledWith('GitHub API error: 401 - Bad credentials');
    expect(sent.complete).not.toHaveBeenCalled();
  });

  it('completes with no results, without calling the AI, when there are no open issues', async () => {
    mockGithubFetch.mockResolvedValue([openIssues[1]]);

    await runTriage('p1');

    expect(mockTriageBatchIssues).not.toHaveBeenCalled();
    expect(sent.complete).toHaveBeenCalledWith([]);
    const last = sent.progress.mock.calls.at(-1)?.[0];
    expect(last).toMatchObject({ phase: 'complete', message: 'No open issues to triage' });
  });

  it('fails when none of the requested issues could be fetched', async () => {
    mockGithubFetch.mockRejectedValue(new Error('GitHub API error: 404 - Not Found'));

    await runTriage('p1', [5, 3]);

    expect(sent.error).toHaveBeenCalledWith('Could not fetch issue(s) #3, #5 from o/r');
    expect(mockTriageBatchIssues).not.toHaveBeenCalled();
  });

  it('names a requested issue it could not fetch beside the ones it triaged', async () => {
    mockGithubFetch.mockImplementation(async (_t: string, endpoint: string) => {
      if (endpoint.endsWith('/issues/3')) throw new Error('GitHub API error: 404 - Not Found');
      return openIssues[0];
    });
    mockTriageBatchIssues.mockResolvedValue([engineResult(1)]);

    await runTriage('p1', [1, 3]);

    const last = sent.progress.mock.calls.at(-1)?.[0];
    expect(last.message).toBe('Triaged 1 issues; could not triage 1 issue(s): #3');
  });

  it('keeps a flag only when the confidence reaches its configured threshold', async () => {
    fs.mkdirSync(githubDir(), { recursive: true });
    fs.writeFileSync(
      path.join(githubDir(), 'config.json'),
      JSON.stringify({ duplicate_threshold: 0.9, spam_threshold: 0.85, feature_creep_threshold: 0.86 }),
    );
    mockGithubFetch.mockResolvedValue(openIssues);
    mockTriageBatchIssues.mockResolvedValue([engineResult(1, { confidence: 0.85 })]);

    await runTriage('p1');

    const saved = readJson('issues/triage_1.json');
    // 0.85 < 0.9: not a duplicate, and the duplicate target goes with the flag.
    expect(saved.is_duplicate).toBe(false);
    expect(saved.duplicate_of).toBeNull();
    // 0.85 >= 0.85: spam stands (the threshold itself counts).
    expect(saved.is_spam).toBe(true);
    // 0.85 < 0.86
    expect(saved.is_feature_creep).toBe(false);
  });

  it('keeps every flag at or above the default thresholds', async () => {
    mockGithubFetch.mockResolvedValue(openIssues);
    mockTriageBatchIssues.mockResolvedValue([engineResult(1, { confidence: 0.85 })]);

    await runTriage('p1');

    const saved = readJson('issues/triage_1.json');
    expect(saved).toMatchObject({ is_duplicate: true, duplicate_of: 7, is_spam: true, is_feature_creep: true });
    // The pull request in /issues is never triaged.
    expect((mockTriageBatchIssues.mock.calls[0][0] as Array<{ number: number }>).map((i) => i.number)).toEqual([1]);
  });

  it('refuses a second run for the same project while one is in flight', async () => {
    mockGithubFetch.mockResolvedValue(openIssues);
    let finish: (v: unknown) => void = () => {};
    mockTriageBatchIssues.mockReturnValue(new Promise((resolve) => { finish = resolve; }));

    const first = runTriage('p1');
    await vi.waitFor(() => expect(mockTriageBatchIssues).toHaveBeenCalled());
    await runTriage('p1');

    expect(sent.error).toHaveBeenCalledWith('Triage is already running for this project');
    finish([engineResult(1)]);
    await first;
    expect(sent.complete).toHaveBeenCalledTimes(1);

    // The guard is released afterwards.
    mockTriageBatchIssues.mockResolvedValue([engineResult(1)]);
    sent.error.mockClear();
    await runTriage('p1');
    expect(sent.error).not.toHaveBeenCalled();
    expect(sent.complete).toHaveBeenCalledTimes(2);
  });
});

describe('applying triage labels', () => {
  it('adds only labels the repository has, removes the requested ones, and records it', async () => {
    writeResult(1, { labels_to_add: ['BUG', 'priority: high', 'not-a-label'], labels_to_remove: ['needs triage', 'ghost'] });
    githubWith(['bug', 'priority: high', 'needs triage']);

    const result = await invoke(IPC_CHANNELS.GITHUB_TRIAGE_APPLY_LABELS, 'p1', [1]);

    expect(result).toEqual({
      success: true,
      applied: [{ issueNumber: 1, added: ['bug', 'priority: high'], removed: ['needs triage'], skipped: ['ghost', 'not-a-label'] }],
      failed: [],
    });
    expect(writes()).toEqual([
      { method: 'POST', endpoint: '/repos/o/r/issues/1/labels', body: JSON.stringify({ labels: ['bug', 'priority: high'] }) },
      { method: 'DELETE', endpoint: '/repos/o/r/issues/1/labels/needs%20triage', body: undefined },
    ]);
    expect(readJson('issues/triage_1.json').labels_applied_at).toEqual(expect.any(String));
  });

  it('sends no POST when no suggested label exists in the repository', async () => {
    writeResult(1, { labels_to_add: ['made-up'] });
    githubWith(['bug']);

    const result = (await invoke(IPC_CHANNELS.GITHUB_TRIAGE_APPLY_LABELS, 'p1', [1])) as { applied: unknown[] };

    expect(writes()).toEqual([]);
    expect(result.applied).toEqual([{ issueNumber: 1, added: [], removed: [], skipped: ['made-up'] }]);
  });

  it('treats removing a label the issue no longer has as done', async () => {
    writeResult(1, { labels_to_add: [], labels_to_remove: ['bug'] });
    githubWith(['bug'], (endpoint, init) =>
      init?.method === 'DELETE' ? new Error('GitHub API error: 404 - Label does not exist') : undefined,
    );

    const result = (await invoke(IPC_CHANNELS.GITHUB_TRIAGE_APPLY_LABELS, 'p1', [1])) as { applied: unknown[]; failed: unknown[] };

    expect(result.failed).toEqual([]);
    expect(result.applied).toEqual([{ issueNumber: 1, added: [], removed: [], skipped: [] }]);
  });

  it('carries on after one issue fails and reports each outcome', async () => {
    writeResult(1);
    writeResult(2);
    githubWith(['bug'], (endpoint) =>
      endpoint === '/repos/o/r/issues/1/labels' ? new Error('GitHub API error: 403 - Resource not accessible') : undefined,
    );

    const result = (await invoke(IPC_CHANNELS.GITHUB_TRIAGE_APPLY_LABELS, 'p1', [1, 9, 2])) as {
      success: boolean;
      applied: Array<{ issueNumber: number }>;
      failed: Array<{ issueNumber: number; error: string }>;
    };

    expect(result.success).toBe(true);
    expect(result.applied.map((a) => a.issueNumber)).toEqual([2]);
    expect(result.failed).toEqual([
      { issueNumber: 1, error: 'GitHub API error: 403 - Resource not accessible' },
      { issueNumber: 9, error: 'No triage result for this issue; run triage first' },
    ]);
    expect(readJson('issues/triage_1.json').labels_applied_at).toBeUndefined();
  });

  it.each([
    ['an empty list', []],
    ['a non-integer', [1.5]],
    ['zero', [0]],
    ['a string', ['1']],
    ['a duplicate', [1, 1]],
    ['not a list', 1],
  ])('refuses %s before touching GitHub', async (_name, input) => {
    writeResult(1);

    const result = await invoke(IPC_CHANNELS.GITHUB_TRIAGE_APPLY_LABELS, 'p1', input);

    expect(result).toEqual({ success: false, error: 'Invalid issue numbers', applied: [], failed: [] });
    expect(mockGithubFetch).not.toHaveBeenCalled();
  });

  it('refuses without a GitHub configuration', async () => {
    writeResult(1);
    githubConfig.current = null;

    const result = await invoke(IPC_CHANNELS.GITHUB_TRIAGE_APPLY_LABELS, 'p1', [1]);

    expect(result).toEqual({ success: false, error: GITHUB_NOT_CONFIGURED_MESSAGE, applied: [], failed: [] });
    expect(mockGithubFetch).not.toHaveBeenCalled();
  });

  it('refuses an unknown project', async () => {
    projectRef.current = null;

    expect(await invoke(IPC_CHANNELS.GITHUB_TRIAGE_APPLY_LABELS, 'nope', [1])).toMatchObject({ success: false, error: 'Project not found' });
  });

  it('writes nothing when the repository labels cannot be read', async () => {
    writeResult(1);
    mockGithubFetch.mockRejectedValue(new Error('GitHub API error: 500 - oops'));

    const result = await invoke(IPC_CHANNELS.GITHUB_TRIAGE_APPLY_LABELS, 'p1', [1]);

    expect(result).toMatchObject({ success: false, error: 'Could not read the labels of o/r: GitHub API error: 500 - oops' });
    expect(writes()).toEqual([]);
  });

  it('reads every page of repository labels', async () => {
    writeResult(1, { labels_to_add: ['label-150'] });
    const all = Array.from({ length: 150 }, (_, i) => ({ name: `label-${i + 1}` }));
    mockGithubFetch.mockImplementation(async (_t: string, endpoint: string) => {
      const page = /&page=(\d+)/.exec(endpoint);
      if (page) return all.slice((Number(page[1]) - 1) * 100, Number(page[1]) * 100);
      return [];
    });

    const result = (await invoke(IPC_CHANNELS.GITHUB_TRIAGE_APPLY_LABELS, 'p1', [1])) as { applied: Array<{ added: string[] }> };

    expect(result.applied[0].added).toEqual(['label-150']);
  });
});
