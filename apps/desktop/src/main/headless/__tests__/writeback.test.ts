import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryReceiptRecorder } from '../../delivery-receipts';
import type { Project } from '../../../shared/types';
import type { RunOutcome } from '../outcome';
import {
  isWritebackEnabled,
  reportOutcomeToSource,
  resolveHeadlessWritebackSettings,
  writebackEventForOutcome
} from '../writeback';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'headless-writeback-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const project = { id: 'p', name: 'P', path: '/tmp/p' } as unknown as Project;
const off = resolveHeadlessWritebackSettings({});
const on = resolveHeadlessWritebackSettings({ writeback: { github: true, jira: { enabled: true } } });

describe('resolveHeadlessWritebackSettings', () => {
  it('is all off by default with Jira defaults filled in', () => {
    expect(off.issue).toEqual({
      github: false,
      gitlab: false,
      linear: false,
      linearTransitionOnReview: false,
      linearTransitionStateName: 'In Review',
      azureboards: false,
      azureBoardsTransitionOnReview: false,
      azureBoardsTransitionStateName: 'Resolved'
    });
    expect(off.jira).toEqual({
      enabled: false,
      comment: true,
      transitionOnReview: false,
      transitionStatusName: 'In Review'
    });
    expect(isWritebackEnabled(off)).toBe(false);
  });

  it('applies configured values', () => {
    const s = resolveHeadlessWritebackSettings({
      writeback: { linear: true, jira: { enabled: true, transitionOnReview: true, transitionStatusName: 'QA' } }
    });
    expect(s.issue.linear).toBe(true);
    expect(s.jira).toEqual({ enabled: true, comment: true, transitionOnReview: true, transitionStatusName: 'QA' });
    expect(isWritebackEnabled(s)).toBe(true);
  });

  it('maps the Azure Boards block and enables write-back on its own', () => {
    const s = resolveHeadlessWritebackSettings({
      writeback: { azureBoards: { enabled: true, transitionOnReview: true, transitionStateName: ' Done ' } }
    });
    expect(s.issue.azureboards).toBe(true);
    expect(s.issue.azureBoardsTransitionOnReview).toBe(true);
    expect(s.issue.azureBoardsTransitionStateName).toBe('Done');
    expect(s.issue.github).toBe(false);
    expect(isWritebackEnabled(s)).toBe(true);
  });
});

describe('writebackEventForOutcome', () => {
  it('maps each outcome kind', () => {
    expect(writebackEventForOutcome({ kind: 'success', exitCode: 0, prUrl: 'x' } as RunOutcome)).toBe('review_ready');
    expect(writebackEventForOutcome({ kind: 'qa_failed', exitCode: 2 })).toBe('blocked');
    expect(writebackEventForOutcome({ kind: 'error', exitCode: 1 })).toBe('failed');
    // zeenha fork: an account pause is never written back, and never as failed.
    expect(writebackEventForOutcome({ kind: 'error', exitCode: 1, accountPaused: true })).toBeNull();
  });
});

describe('reportOutcomeToSource', () => {
  it('does not dispatch when everything is off', async () => {
    const dispatchIssue = vi.fn();
    await reportOutcomeToSource({
      settings: off, project, specDirs: [dir], event: 'review_ready', title: 't', dispatchIssue
    });
    expect(dispatchIssue).not.toHaveBeenCalled();
  });

  it('dispatches once with metadata from the first spec dir that has it, Jira included in the writers', async () => {
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(path.join(b, 'task_metadata.json'), JSON.stringify({ sourceType: 'github', n: 'b' }));
    const dispatchIssue = vi.fn().mockResolvedValue(undefined);
    const recorder = createDeliveryReceiptRecorder(dir, '001-demo');
    await reportOutcomeToSource({
      recorder, settings: on, project, specDirs: [a, b], event: 'blocked', title: 'T', prUrl: 'u',
      env: {}, dispatchIssue
    });
    expect(dispatchIssue).toHaveBeenCalledTimes(1);
    const arg = dispatchIssue.mock.calls[0][0];
    expect(arg.recorder).toBe(recorder);
    expect(arg.meta).toEqual({ sourceType: 'github', n: 'b' });
    expect(arg.event).toBe('blocked');
    expect(arg.title).toBe('T');
    expect(arg.raw).toEqual({ issueWriteback: on.issue, jiraWriteback: on.jira });
    expect(arg.writers.map((w: { sourceType: string }) => w.sourceType)).toEqual(['github', 'gitlab', 'linear', 'jira', 'azure_boards']);
  });

  it('dispatches when only Azure Boards is on, with the settings in raw', async () => {
    const azure = resolveHeadlessWritebackSettings({ writeback: { azureBoards: { enabled: true } } });
    const dispatchIssue = vi.fn().mockResolvedValue(undefined);
    await reportOutcomeToSource({
      settings: azure, project, specDirs: [dir], event: 'review_ready', title: 't', env: {}, dispatchIssue
    });
    expect(dispatchIssue).toHaveBeenCalledTimes(1);
    const arg = dispatchIssue.mock.calls[0][0];
    expect(arg.raw.issueWriteback.azureboards).toBe(true);
    expect(arg.writers.map((w: { sourceType: string }) => w.sourceType)).toContain('azure_boards');
  });

  it('never throws when the dispatcher throws', async () => {
    const dispatchIssue = vi.fn().mockImplementation(() => {
      throw new Error('boom secret');
    });
    const warn = vi.fn();
    await expect(
      reportOutcomeToSource({
        settings: on, project, specDirs: [dir], event: 'failed', title: 't', env: {}, dispatchIssue, warn
      })
    ).resolves.toBeUndefined();
    expect(dispatchIssue).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    for (const [message] of warn.mock.calls) expect(message).not.toContain('secret');
  });
});
