import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    expect(off.issue).toEqual({ github: false, gitlab: false, linear: false });
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
});

describe('writebackEventForOutcome', () => {
  it('maps each outcome kind', () => {
    expect(writebackEventForOutcome({ kind: 'success', exitCode: 0, prUrl: 'x' } as RunOutcome)).toBe('review_ready');
    expect(writebackEventForOutcome({ kind: 'qa_failed', exitCode: 2 })).toBe('blocked');
    expect(writebackEventForOutcome({ kind: 'error', exitCode: 1 })).toBe('failed');
  });
});

describe('reportOutcomeToSource', () => {
  it('does not dispatch when everything is off', async () => {
    const dispatchIssue = vi.fn();
    const dispatchJira = vi.fn();
    await reportOutcomeToSource({
      settings: off, project, specDirs: [dir], event: 'review_ready', title: 't', dispatchIssue, dispatchJira
    });
    expect(dispatchIssue).not.toHaveBeenCalled();
    expect(dispatchJira).not.toHaveBeenCalled();
  });

  it('calls both dispatchers with metadata from the first spec dir that has it', async () => {
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(path.join(b, 'task_metadata.json'), JSON.stringify({ sourceType: 'github', n: 'b' }));
    const dispatchIssue = vi.fn().mockResolvedValue(undefined);
    const dispatchJira = vi.fn().mockResolvedValue(undefined);
    await reportOutcomeToSource({
      settings: on, project, specDirs: [a, b], event: 'blocked', title: 'T', prUrl: 'u',
      env: {}, dispatchIssue, dispatchJira
    });
    expect(dispatchIssue).toHaveBeenCalledTimes(1);
    expect(dispatchJira).toHaveBeenCalledTimes(1);
    const arg = dispatchIssue.mock.calls[0][0];
    expect(arg.meta).toEqual({ sourceType: 'github', n: 'b' });
    expect(arg.event).toBe('blocked');
    expect(arg.title).toBe('T');
    expect(arg.settings).toBe(on.issue);
    expect(arg.writers.map((w: { sourceType: string }) => w.sourceType)).toEqual(['github', 'gitlab', 'linear']);
    expect(dispatchJira.mock.calls[0][0].meta).toEqual({ sourceType: 'github', n: 'b' });
    expect(dispatchJira.mock.calls[0][0].settings).toBe(on.jira);
  });

  it('never throws when a dispatcher throws, and still calls the other', async () => {
    const dispatchIssue = vi.fn().mockRejectedValue(new Error('boom secret'));
    const dispatchJira = vi.fn().mockImplementation(() => {
      throw new Error('boom');
    });
    const warn = vi.fn();
    await expect(
      reportOutcomeToSource({
        settings: on, project, specDirs: [dir], event: 'failed', title: 't', env: {}, dispatchIssue, dispatchJira, warn
      })
    ).resolves.toBeUndefined();
    expect(dispatchJira).toHaveBeenCalled();
    for (const [message] of warn.mock.calls) expect(message).not.toContain('secret');
  });
});
