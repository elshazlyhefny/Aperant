/**
 * zeenha fork: push a PR follow-up to the PR branch, but only after QA approved it.
 *
 * Runs from the agentManager 'exit' event for qa-process. It acts only when the
 * task's worktree spec dir holds a PR_FOLLOWUP.json marker with status 'running',
 * so tasks without a marker are never affected. Nothing is pushed unless:
 * - the QA run exited cleanly and wrote a FRESH approved qa_signoff,
 * - the worktree is on exactly auto-claude/<specId> and descends from the
 *   reviewed revision, with no uncommitted work,
 * - the PR is still open on that branch at the reviewed revision, and the
 *   remote branch and push destination still match what was reviewed.
 * An exact lease protects against simultaneous remote branch updates.
 * Stale outcomes leave local work in place for review.
 */

import path from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { AUTO_BUILD_PATHS, getSpecsDir } from '../../../shared/constants';
import type { Project, Task } from '../../../shared/types';
import { findTaskWorktree } from '../../worktree-paths';
import { getToolPath } from '../../cli-tool-manager';
import { getIsolatedGitEnv } from '../../utils/git-isolation';
import { taskStateManager } from '../../task-state-manager';
import { pushBranchFastForward, type FastForwardPushResult } from '../../ai/runners/github/pr-creator';
import { loadPRFeedback, resolvePRRef } from './pr-feedback-source';
import { isVerifiableRevision, sameRevision, shortRevision } from './pr-revision-guard';
import { updateTaskStatusAfterPRCreation } from './worktree-pr';

const MARKER_FILE = 'PR_FOLLOWUP.json';
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const STALE_GUIDANCE =
  'Your local commits are kept in the worktree. Refresh the PR feedback, review the new revision, then send feedback again or push by hand. Nothing was pushed.';

export type PRFollowUpFinalStatus = 'failed' | 'no_changes' | 'pushed' | 'push_failed' | 'stale';

export interface PRFollowUpOutcome {
  status: PRFollowUpFinalStatus;
  reason?: string;
  headSha?: string;
}

interface Marker {
  version?: number;
  prUrl: string;
  prNumber: number;
  branch: string;
  headShaAtStart: string;
  reviewedHeadSha?: string;
  pushRemote?: { name: string; url: string };
  qaSignoffBefore: string | null;
  status: string;
  [key: string]: unknown;
}

export interface PRFollowUpFinalizerDeps {
  readFile(filePath: string): string | null;
  writeFile(filePath: string, content: string): void;
  /** Runs git in cwd and returns stdout; throws on failure. */
  git(args: string[], cwd: string): Promise<string>;
  pushFastForward(worktreePath: string, branch: string, expectedRemoteSha: string): Promise<FastForwardPushResult>;
  findWorktree(projectPath: string, specId: string): string | null;
  getPRState(project: Project, prNumber: number, prUrl: string): Promise<{ state: string; headRef: string; headSha: string }>;
  persistPRDone(
    specDir: string,
    worktreePath: string,
    prUrl: string,
    autoBuildPath: string | undefined,
    specId: string
  ): Promise<void>;
  markDone(taskId: string, task: Task, project: Project): void;
  notify(taskId: string, outcome: PRFollowUpOutcome): void;
}

export interface FinalizePRFollowUpArgs {
  taskId: string;
  exitCode: number | null;
  project: Project;
  task: Task;
  deps: PRFollowUpFinalizerDeps;
}

async function gitAsync(args: string[], cwd: string): Promise<string> {
  // ls-remote can wait on the network; do not block the Electron main process.
  const { stdout } = await promisify(execFile)(getToolPath('git'), args, {
    cwd,
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...getIsolatedGitEnv(), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
  return stdout;
}

export function createDefaultFinalizerDeps(
  notify: (taskId: string, outcome: PRFollowUpOutcome) => void
): PRFollowUpFinalizerDeps {
  return {
    readFile: (p) => {
      try {
        return existsSync(p) ? readFileSync(p, 'utf-8') : null;
      } catch {
        return null;
      }
    },
    writeFile: (p, c) => writeFileSync(p, c, 'utf-8'),
    git: gitAsync,
    pushFastForward: (wt, branch, sha) => pushBranchFastForward(wt, getToolPath('git'), branch, sha),
    findWorktree: findTaskWorktree,
    // The marker URL decides which forge can verify the PR head.
    getPRState: async (project, _prNumber, prUrl) => {
      const ref = resolvePRRef(prUrl);
      if (!ref) throw new Error('The pull request link is not valid');
      const result = await loadPRFeedback(project, prUrl, ref);
      if (!result.ok) throw new Error(result.error);
      return { state: result.fetched.prState, headRef: result.fetched.headRef, headSha: result.fetched.headSha };
    },
    persistPRDone: async (specDir, wt, prUrl, autoBuildPath, specId) => {
      await updateTaskStatusAfterPRCreation(specDir, wt, prUrl, autoBuildPath, specId, () => {});
    },
    markDone: (taskId, task, project) => {
      taskStateManager.handleManualStatusChange(taskId, 'done', task, project);
    },
    notify,
  };
}

function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** True when the signoff is approved and differs from the one recorded at start. */
function isFreshApproval(planText: string | null, before: string | null): boolean {
  const plan = parseJson<{ qa_signoff?: { status?: unknown } | null }>(planText);
  const signoff = plan?.qa_signoff;
  if (!signoff || typeof signoff !== 'object') return false;
  if (JSON.stringify(signoff) === before) return false;
  return signoff.status === 'approved' || signoff.status === 'passed';
}

/** `git status --porcelain` lines that are not Aperant's own task files. */
function dirtyWork(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter((l) => l.trim() !== '')
    .filter((l) => {
      const p = l.slice(3).replace(/^"/, '');
      return p !== '.auto-claude' && !p.startsWith('.auto-claude/');
    });
}

export async function finalizePRFollowUp(args: FinalizePRFollowUpArgs): Promise<PRFollowUpOutcome | null> {
  const { taskId, exitCode, project, task, deps } = args;

  const worktreePath = deps.findWorktree(project.path, task.specId);
  if (!worktreePath) return null;
  const specDir = path.join(worktreePath, getSpecsDir(project.autoBuildPath), task.specId);
  const markerPath = path.join(specDir, MARKER_FILE);
  const marker = parseJson<Marker>(deps.readFile(markerPath));
  if (!marker || marker.status !== 'running') return null;

  const finish = (status: PRFollowUpFinalStatus, extra: Partial<PRFollowUpOutcome> = {}): PRFollowUpOutcome => {
    const outcome: PRFollowUpOutcome = { status, ...extra };
    try {
      deps.writeFile(
        markerPath,
        JSON.stringify(
          { ...marker, status, finishedAt: new Date().toISOString(), ...(extra.reason ? { reason: extra.reason } : {}), ...(extra.headSha ? { headShaAfter: extra.headSha } : {}) },
          null,
          2
        )
      );
    } catch {
      // Marker update is best effort; the outcome is still reported.
    }
    try {
      deps.notify(taskId, outcome);
    } catch {
      // Notification failure must not affect the result.
    }
    return outcome;
  };

  // 1. QA must have exited cleanly with a fresh approval.
  if (exitCode !== 0) {
    return finish('failed', { reason: `QA did not finish cleanly (exit code ${exitCode ?? 'none'}). Nothing was pushed.` });
  }
  const planText = deps.readFile(path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN));
  if (!isFreshApproval(planText, marker.qaSignoffBefore ?? null)) {
    return finish('failed', { reason: 'QA did not approve the follow-up changes. Nothing was pushed.' });
  }

  // 2. Verify the worktree state.
  const expectedBranch = `auto-claude/${task.specId}`;
  const reviewed = marker.reviewedHeadSha ?? marker.headShaAtStart;
  let reviewedFull: string;
  let headSha: string | undefined;
  const stale = (reason: string): PRFollowUpOutcome =>
    finish('stale', { reason: `${reason} ${STALE_GUIDANCE}`, ...(headSha ? { headSha } : {}) });
  try {
    const branch = (await deps.git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath)).trim();
    if (branch !== expectedBranch || marker.branch !== expectedBranch) {
      return finish('failed', { reason: `The worktree is not on ${expectedBranch}. Nothing was pushed.` });
    }
    headSha = (await deps.git(['rev-parse', 'HEAD'], worktreePath)).trim();
    const missingRevision = 'The reviewed revision could not be verified in the worktree.';
    if (!isVerifiableRevision(reviewed)) return stale(missingRevision);
    try {
      reviewedFull = (await deps.git(['rev-parse', '--verify', `${reviewed}^{commit}`], worktreePath)).trim();
    } catch {
      return stale(missingRevision);
    }
    if (!FULL_SHA.test(reviewedFull) || !sameRevision(reviewed, reviewedFull)) return stale(missingRevision);
    try {
      await deps.git(['merge-base', '--is-ancestor', reviewedFull, 'HEAD'], worktreePath);
    } catch {
      return stale('Local history does not fast-forward from the reviewed revision.');
    }
    const dirty = dirtyWork(await deps.git(['status', '--porcelain'], worktreePath));
    if (dirty.length > 0) {
      return finish('failed', { reason: 'The worktree has uncommitted changes. Commit or discard them, then use Create PR to push. Nothing was pushed.' });
    }
  } catch (err) {
    return finish('failed', { reason: `Could not inspect the worktree: ${err instanceof Error ? err.message : String(err)}. Nothing was pushed.` });
  }

  // 3. The PR and the remote branch must still be at the reviewed revision.
  const unverifiedPRHead = "Could not verify the pull request's current revision.";
  try {
    const pr = await deps.getPRState(project, marker.prNumber, marker.prUrl);
    if (pr.state !== 'open') {
      return finish('failed', { reason: 'The pull request is no longer open. Nothing was pushed.' });
    }
    if (pr.headRef !== expectedBranch) {
      return finish('failed', { reason: 'The pull request branch changed. Nothing was pushed.' });
    }
    if (!isVerifiableRevision(pr.headSha)) return stale(unverifiedPRHead);
    if (!sameRevision(pr.headSha, reviewedFull)) {
      return stale(`The pull request revision changed from ${shortRevision(reviewed)} to ${shortRevision(pr.headSha)}.`);
    }
  } catch {
    return stale(unverifiedPRHead);
  }

  const changedPushDestination = 'The push destination of the worktree changed (or was not recorded).';
  if (!marker.pushRemote?.url) return stale(changedPushDestination);
  try {
    const pushUrl = (await deps.git(['remote', 'get-url', '--push', 'origin'], worktreePath)).trim();
    if (pushUrl !== marker.pushRemote.url) return stale(changedPushDestination);
  } catch {
    return stale(changedPushDestination);
  }

  const ref = `refs/heads/${expectedBranch}`;
  const changedRemote = 'The branch on the remote is no longer at the reviewed revision.';
  let remoteSha: string;
  try {
    const output = await deps.git(['ls-remote', 'origin', ref], worktreePath);
    const refs = output.trim().split(/\r?\n/).map((line) => line.split('\t'));
    const matchingRefs = refs.filter((fields) => fields.length === 2 && fields[1] === ref);
    if (matchingRefs.length !== 1) return stale(changedRemote);
    remoteSha = matchingRefs[0][0];
    if (remoteSha.toLowerCase() !== reviewedFull.toLowerCase()) return stale(changedRemote);
  } catch {
    return stale(changedRemote);
  }

  // 4. Nothing new to push.
  if (headSha === reviewedFull) {
    return finish('no_changes', { reason: 'QA approved, but the agent made no new commits. Nothing was pushed.', headSha });
  }

  // 5. Push, then restore the PR-open representation.
  const push = await deps.pushFastForward(worktreePath, expectedBranch, remoteSha);
  if (!push.ok) {
    if (push.stale) return stale('The branch no longer allows a fast-forward push from the reviewed revision.');
    return finish('push_failed', { reason: push.error, headSha });
  }

  try {
    await deps.persistPRDone(specDir, worktreePath, marker.prUrl, project.autoBuildPath, task.specId);
    deps.markDone(taskId, task, project);
  } catch {
    // The push already succeeded; the status can be restored by the next refresh.
  }
  return finish('pushed', { headSha });
}
