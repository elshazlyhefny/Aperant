/**
 * zeenha fork: the Azure Boards writer resolves only after its requests finish.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const addWorkItemComment = vi.fn();
const setWorkItemState = vi.fn();
const warnLog = vi.fn();

vi.mock('../../azuredevops/work-item-client', async (orig) => ({
  ...(await orig<typeof import('../../azuredevops/work-item-client')>()),
  addWorkItemComment: (...a: unknown[]) => addWorkItemComment(...a),
  setWorkItemState: (...a: unknown[]) => setWorkItemState(...a)
}));
vi.mock('../../../log-port', () => ({
  appLogPort: { warn: (...a: unknown[]) => warnLog(...a), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { createAzureBoardsWriter } from '../azureboards-writer';
import { AzureDevOpsAPIError } from '../../azuredevops/utils';

const cfg = { organization: 'Acme', project: 'My Proj', repository: 'r', pat: 'SECRET-PAT' };
const meta = {
  sourceType: 'azure_boards',
  azureBoardsWorkItemId: 42,
  azureBoardsOrganization: 'acme',
  azureBoardsProject: 'my proj'
} as never;
const settings = { azureBoardsTransitionOnReview: true, azureBoardsTransitionStateName: 'Resolved' } as never;
const project = { path: '/p' } as never;
const base = { meta, project, event: 'review_ready' as const, text: 'a <b>\nc', settings };
const writer = (getConfig: () => Promise<unknown> = async () => cfg) =>
  createAzureBoardsWriter(getConfig as never);

beforeEach(() => {
  addWorkItemComment.mockReset().mockResolvedValue(undefined);
  setWorkItemState.mockReset().mockResolvedValue(undefined);
  warnLog.mockReset();
});

describe('createAzureBoardsWriter', () => {
  it('posts escaped comment and transitions on review_ready, after both finish', async () => {
    let done = false;
    setWorkItemState.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      done = true;
    });
    await writer().postOutcome(base);
    expect(done).toBe(true);
    expect(addWorkItemComment).toHaveBeenCalledWith(cfg, 42, 'a &lt;b&gt;<br>c');
    expect(setWorkItemState).toHaveBeenCalledWith(cfg, 42, 'Resolved');
  });

  it('does not transition on failed or without switch/name', async () => {
    await writer().postOutcome({ ...base, event: 'failed' });
    await writer().postOutcome({ ...base, settings: { ...(settings as object), azureBoardsTransitionOnReview: false } as never });
    await writer().postOutcome({ ...base, settings: { ...(settings as object), azureBoardsTransitionStateName: '  ' } as never });
    expect(addWorkItemComment).toHaveBeenCalledTimes(3);
    expect(setWorkItemState).not.toHaveBeenCalled();
  });

  it('still comments when the transition 400s, and still transitions when the comment fails', async () => {
    setWorkItemState.mockRejectedValue(new AzureDevOpsAPIError('bad body SECRET-PAT', 400));
    await writer().postOutcome(base);
    expect(addWorkItemComment).toHaveBeenCalledTimes(1);
    addWorkItemComment.mockRejectedValue(new AzureDevOpsAPIError('bad body SECRET-PAT', 500));
    setWorkItemState.mockResolvedValue(undefined);
    await writer().postOutcome(base);
    expect(setWorkItemState).toHaveBeenCalledTimes(2);
    expect(warnLog).toHaveBeenCalledTimes(2);
    const logged = warnLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('SECRET-PAT');
    expect(logged).not.toContain('bad body');
  });

  it('skips on org/project mismatch, missing config, bad id and pr_opened', async () => {
    await writer().postOutcome({ ...base, meta: { ...(meta as object), azureBoardsOrganization: 'evil' } as never });
    await writer().postOutcome({ ...base, meta: { ...(meta as object), azureBoardsProject: undefined } as never });
    await writer(async () => null).postOutcome(base);
    await writer().postOutcome({ ...base, meta: { ...(meta as object), azureBoardsWorkItemId: 0 } as never });
    await writer().postOutcome({ ...base, meta: { ...(meta as object), azureBoardsWorkItemId: '42' } as never });
    await writer().postOutcome({ ...base, event: 'pr_opened' as never });
    expect(addWorkItemComment).not.toHaveBeenCalled();
    expect(setWorkItemState).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    addWorkItemComment.mockRejectedValue(new Error('x'));
    setWorkItemState.mockRejectedValue(new Error('x'));
    await expect(Promise.resolve(writer().postOutcome(base))).resolves.toBeUndefined();
    const throwing = writer(async () => {
      throw new Error('y');
    });
    await expect(Promise.resolve(throwing.postOutcome(base))).resolves.toBeUndefined();
    const syncThrow = writer(() => {
      throw new Error('z');
    });
    await expect(Promise.resolve(syncThrow.postOutcome(base))).resolves.toBeUndefined();
  });
});
