/**
 * zeenha fork: push a PR follow-up to the PR branch, but only after QA approved it.
 *
 * Runs from the agentManager 'exit' event for qa-process. It acts only when the
 * task's worktree spec dir holds a PR_FOLLOWUP.json marker with status 'running',
 * so tasks without a marker are never affected. Nothing is pushed unless:
 * - the QA run exited cleanly and wrote a FRESH approved qa_signoff,
 * - the worktree is on exactly auto-claude/<specId> and descends from the SHA
 *   the follow-up started at, with no uncommitted work,
 * - the PR is still open and its head ref is that same branch.
 */

import path from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { AUTO_BUILD_PATHS, getSpecsDir } from '../../../shared/constants';
import type { Project, Task } from '../../../shared/types';
import { findTaskWorktree } from '../../worktree-paths';
import { getToolPath } from '../../cli-tool-manager';
import { getIsolatedGitEnv } from '../../utils/git-isolation';
import { taskStateManager } from '../../task-state-manager';
import { pushBranch } from '../../ai/runners/github/pr-creator';
import { getGitHubConfig } from '../github/utils';
import { fetchPRFeedback } from '../github/pr/task-feedback';
import { updateTaskStatusAfterPRCreation } from './worktree-pr';

const MARKER_FILE = 'PR_FOLLOWUP.json';

export type PRFollowUpFinalStatus = 'failed' | 'no_changes' | 'pushed' | 'push_failed';

export interface PRFollowUpOutcome {
  status: PRFollowUpFinalStatus;
  reason?: string;
  headSha?: string;
}

interface Marker {
  prUrl: string;
  prNumber: number;
  branch: string;
  headShaAtStart: string;
  qaSignoffBefore: string | null;
  status: string;
  [key: string]: unknown;
}

export interface PRFollowUpFinalizerDeps {
  readFile(filePath: string): string | null;
  writeFile(filePath: string, content: string): void;
  /** Runs git in cwd and returns stdout; throws on failure. */
  git(args: string[], cwd: string): Promise<string>;
  /** Returns an error string, or undefined on success. */
  pushBranch(worktreePath: string, branch: string): Promise<string | undefined>;
  findWorktree(projectPath: string, specId: string): string | null;
  getPRState(project: Project, prNumber: number): Promise<{ state: string; headRef: string }>;
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

function gitAsync(args: string[], cwd: string): Promise<string> {
  return Promise.resolve().then(() =>
    execFileSync(getToolPath('git'), args, {
      cwd,
      encoding: 'utf-8',
      timeout: 30000,
      env: getIsolatedGitEnv(),
    })
  );
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
    pushBranch: (wt, branch) => pushBranch(wt, getToolPath('git'), branch),
    findWorktree: findTaskWorktree,
    getPRState: async (project, prNumber) => {
      const config = getGitHubConfig(project);
      if (!config) throw new Error('GitHub is not configured for this project');
      const fetched = await fetchPRFeedback(config, prNumber);
      return { state: fetched.prState, headRef: fetched.headRef };
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
  let headSha: string;
  try {
    const branch = (await deps.git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath)).trim();
    if (branch !== expectedBranch || marker.branch !== expectedBranch) {
      return finish('failed', { reason: `The worktree is not on ${expectedBranch}. Nothing was pushed.` });
    }
    headSha = (await deps.git(['rev-parse', 'HEAD'], worktreePath)).trim();
    if (headSha !== marker.headShaAtStart) {
      try {
        await deps.git(['merge-base', '--is-ancestor', marker.headShaAtStart, 'HEAD'], worktreePath);
      } catch {
        return finish('failed', { reason: 'The branch no longer descends from the commit the follow-up started at. Nothing was pushed.' });
      }
    }
    const dirty = dirtyWork(await deps.git(['status', '--porcelain'], worktreePath));
    if (dirty.length > 0) {
      return finish('failed', { reason: 'The worktree has uncommitted changes. Commit or discard them, then use Create PR to push. Nothing was pushed.' });
    }
  } catch (err) {
    return finish('failed', { reason: `Could not inspect the worktree: ${err instanceof Error ? err.message : String(err)}. Nothing was pushed.` });
  }

  // 3. The PR must still be open on the same branch.
  try {
    const pr = await deps.getPRState(project, marker.prNumber);
    if (pr.state !== 'open') {
      return finish('failed', { reason: 'The pull request is no longer open. Nothing was pushed.' });
    }
    if (pr.headRef !== expectedBranch) {
      return finish('failed', { reason: 'The pull request branch changed. Nothing was pushed.' });
    }
  } catch (err) {
    return finish('failed', { reason: `Could not check the pull request: ${err instanceof Error ? err.message : String(err)}. Nothing was pushed.` });
  }

  // 4. Nothing new to push.
  if (headSha === marker.headShaAtStart) {
    return finish('no_changes', { reason: 'QA approved, but the agent made no new commits. Nothing was pushed.', headSha });
  }

  // 5. Push, then restore the PR-open representation.
  const pushError = await deps.pushBranch(worktreePath, expectedBranch);
  if (pushError) {
    return finish('push_failed', { reason: pushError, headSha });
  }

  try {
    await deps.persistPRDone(specDir, worktreePath, marker.prUrl, project.autoBuildPath, task.specId);
    deps.markDone(taskId, task, project);
  } catch {
    // The push already succeeded; the status can be restored by the next refresh.
  }
  return finish('pushed', { headSha });
}
