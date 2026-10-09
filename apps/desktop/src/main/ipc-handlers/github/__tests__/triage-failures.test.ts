/**
 * zeenha fork: the triage handler used to save every engine outcome as a
 * triage result and report the run complete, so a failed batch looked
 * triaged (as "feature"). Failed issues are not saved, are named, and a run
 * in which every issue failed reports an error.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../shared/constants';

const listeners = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<void>>());
const sent = vi.hoisted(() => ({
  progress: vi.fn(),
  complete: vi.fn(),
  error: vi.fn(),
}));
const mockTriageBatchIssues = vi.hoisted(() => vi.fn());
const projectRef = vi.hoisted(() => ({ current: null as null | { id: string; path: string } }));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: (channel: string, fn: (...args: unknown[]) => Promise<void>) => listeners.set(channel, fn),
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
  getGitHubConfig: () => ({ token: 't', repo: 'o/r' }),
  githubFetch: vi.fn(async () => [
    { number: 1, title: 'a', user: { login: 'u' }, created_at: 'x' },
    { number: 2, title: 'b', user: { login: 'u' }, created_at: 'x' },
  ]),
}));
vi.mock('../../../settings-utils', () => ({ readSettingsFile: () => ({}) }));
vi.mock('../../../env-utils', () => ({ getAugmentedEnv: () => ({}) }));
vi.mock('../utils/logger', () => ({ createContextLogger: () => ({ debug: vi.fn() }) }));
// Deliberately only triageBatchIssues: the handler must not depend on any
// other runtime export of the engine to tell a failure from a result.
vi.mock('../../../ai/runners/github/triage-engine', () => ({
  triageBatchIssues: (...args: unknown[]) => mockTriageBatchIssues(...args),
}));

import { registerTriageHandlers } from '../triage-handlers';

const success = (issueNumber: number) => ({
  issueNumber,
  repo: 'o/r',
  category: 'bug',
  confidence: 0.9,
  labelsToAdd: [],
  labelsToRemove: [],
  isDuplicate: false,
  duplicateOf: null,
  isSpam: false,
  isFeatureCreep: false,
  suggestedBreakdown: [],
  priority: 'high',
  comment: null,
});
const failure = (issueNumber: number) => ({ issueNumber, repo: 'o/r', failed: true, error: '429 rate limit' });

let dir: string;
const issuesDir = () => path.join(dir, '.auto-claude', 'github', 'issues');
const savedFiles = () => (fs.existsSync(issuesDir()) ? fs.readdirSync(issuesDir()).sort() : []);

async function run() {
  registerTriageHandlers(() => ({}) as never);
  const listener = listeners.get(IPC_CHANNELS.GITHUB_TRIAGE_RUN);
  if (!listener) throw new Error('triage run listener not registered');
  await listener({}, 'p1');
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-failures-'));
  projectRef.current = { id: 'p1', path: dir };
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('triage handler with failed issues', () => {
  it('reports an error and saves nothing when every issue failed', async () => {
    mockTriageBatchIssues.mockResolvedValue([failure(1), failure(2)]);

    await run();

    expect(sent.complete).not.toHaveBeenCalled();
    expect(sent.error).toHaveBeenCalledTimes(1);
    expect(sent.error.mock.calls[0][0]).toMatch(/Triage failed for all 2 issue\(s\) \(#1, #2\): 429 rate limit/);
    expect(savedFiles()).toEqual([]);
  });

  it('saves only the triaged issues and names the ones that failed', async () => {
    mockTriageBatchIssues.mockResolvedValue([success(1), failure(2)]);

    await run();

    expect(sent.error).not.toHaveBeenCalled();
    expect(savedFiles()).toEqual(['triage_1.json']);
    const results = sent.complete.mock.calls[0][0] as Array<{ issueNumber: number }>;
    expect(results.map((r) => r.issueNumber)).toEqual([1]);
    const completeProgress = sent.progress.mock.calls.map((c) => c[0]).find((p) => p.phase === 'complete');
    expect(completeProgress.message).toBe('Triaged 1 issues; could not triage 1 issue(s): #2');
  });

  it('saves and completes normally when nothing failed', async () => {
    mockTriageBatchIssues.mockResolvedValue([success(1), success(2)]);

    await run();

    expect(sent.error).not.toHaveBeenCalled();
    expect(savedFiles()).toEqual(['triage_1.json', 'triage_2.json']);
    const completeProgress = sent.progress.mock.calls.map((c) => c[0]).find((p) => p.phase === 'complete');
    expect(completeProgress.message).toBe('Triaged 2 issues');
  });
});
