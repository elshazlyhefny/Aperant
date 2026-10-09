/**
 * zeenha fork: the generate handler must hand the request's style options to the
 * runner. They used to be dropped, so the format/audience/emoji/date the user
 * picked never reached the prompt.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));

vi.mock('../../project-store', () => ({
  projectStore: {
    getProject: () => ({ id: 'p1', name: 'Proj', path: '/tmp/proj', autoBuildPath: '.auto-claude' }),
    getTasks: () => [],
  },
}));

vi.mock('../../changelog-service', () => ({
  changelogService: {
    on: vi.fn(),
    off: vi.fn(),
    loadTaskSpecs: vi.fn(async () => []),
    getCommits: vi.fn(() => [{ hash: 'abc1234', subject: 'feat: x', body: '' }]),
    getBranchDiffCommits: vi.fn(() => []),
  },
}));

const mockGenerate = vi.fn();
vi.mock('../../ai/runners/changelog', () => ({
  generateChangelog: (...args: unknown[]) => mockGenerate(...args),
}));

import { IPC_CHANNELS } from '../../../shared/constants';
import { registerChangelogHandlers } from '../changelog-handlers';

describe('CHANGELOG_GENERATE', () => {
  beforeEach(() => {
    handlers.clear();
    mockGenerate.mockReset();
    mockGenerate.mockResolvedValue({ success: true, text: '## 1.0.0' });
    registerChangelogHandlers(() => null);
  });

  it('passes date, format, audience, emoji level and custom instructions to the runner', async () => {
    const handler = handlers.get(IPC_CHANNELS.CHANGELOG_GENERATE);
    expect(handler).toBeDefined();

    const result = await handler?.(
      {},
      {
        projectId: 'p1',
        sourceMode: 'git-history',
        gitHistory: { type: 'recent', count: 5 },
        version: '2.1.0',
        date: '2026-03-14',
        format: 'github-release',
        audience: 'technical',
        emojiLevel: 'medium',
        customInstructions: 'Keep it short.',
      },
    );
    expect(result).toEqual({ success: true });

    await vi.waitFor(() => expect(mockGenerate).toHaveBeenCalledOnce());
    expect(mockGenerate.mock.calls[0][0]).toMatchObject({
      projectName: 'Proj',
      version: '2.1.0',
      sourceMode: 'git-history',
      date: '2026-03-14',
      format: 'github-release',
      audience: 'technical',
      emojiLevel: 'medium',
      customInstructions: 'Keep it short.',
    });
  });
});
