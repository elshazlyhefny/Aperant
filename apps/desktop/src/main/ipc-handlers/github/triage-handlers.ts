/**
 * GitHub Issue Triage IPC handlers
 *
 * Handles AI-powered issue triage:
 * 1. Detect duplicates, spam, feature creep
 * 2. Suggest labels and priority
 * 3. Apply labels to issues
 */

import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import {
  IPC_CHANNELS,
  DEFAULT_FEATURE_MODELS,
  DEFAULT_FEATURE_THINKING,
} from '../../../shared/constants';
import { getGitHubConfig, githubFetch } from './utils';
import { readSettingsFile } from '../../settings-utils';
import type {
  Project,
  AppSettings,
  GitHubTriageCategory,
  GitHubTriageConfig,
  GitHubTriageResult,
  GitHubTriageProgress,
  GitHubTriageApplyResult,
} from '../../../shared/types';
import { createContextLogger } from './utils/logger';
import { withProjectOrNull } from './utils/project-middleware';
import { createIPCCommunicators } from './utils/ipc-communicator';
import {
  triageBatchIssues,
  type GitHubIssue as TriageGitHubIssue,
  type TriageResult as EngineTriageResult,
  type TriageFailure as EngineTriageFailure,
  type TriageOutcome as EngineTriageOutcome,
} from '../../ai/runners/github/triage-engine';
import type { ModelShorthand, ThinkingLevel } from '../../ai/config/types';

// Debug logging
const { debug: debugLog } = createContextLogger('GitHub Triage');

// The shapes live in shared/types so the preload and renderer use the same ones.
export type TriageCategory = GitHubTriageCategory;
export type TriageResult = GitHubTriageResult;
export type TriageConfig = GitHubTriageConfig;
export type TriageProgress = GitHubTriageProgress;

const DEFAULT_TRIAGE_CONFIG: TriageConfig = {
  enabled: false,
  duplicateThreshold: 0.8,
  spamThreshold: 0.75,
  featureCreepThreshold: 0.7,
  enableComments: false,
};

/** Shown whenever triage needs GitHub and the project has no usable configuration. */
export const GITHUB_NOT_CONFIGURED_MESSAGE =
  'GitHub is not configured for this project: set the repository and a token (or sign in with the GitHub CLI) in the project\'s GitHub settings.';

/** Projects with a triage run in flight; a second run would race on the same result files. */
const runningProjects = new Set<string>();

/**
 * Get the GitHub directory for a project
 */
function getGitHubDir(project: Project): string {
  return path.join(project.path, '.auto-claude', 'github');
}

function isThreshold(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * zeenha fork: the config arrives from the renderer, so it is checked before it
 * is written; a malformed one is refused rather than half-saved.
 */
export function sanitizeTriageConfig(input: unknown): TriageConfig | null {
  if (!input || typeof input !== 'object') return null;
  const c = input as Record<string, unknown>;
  if (typeof c.enabled !== 'boolean' || typeof c.enableComments !== 'boolean') return null;
  if (!isThreshold(c.duplicateThreshold) || !isThreshold(c.spamThreshold) || !isThreshold(c.featureCreepThreshold)) {
    return null;
  }
  return {
    enabled: c.enabled,
    duplicateThreshold: c.duplicateThreshold,
    spamThreshold: c.spamThreshold,
    featureCreepThreshold: c.featureCreepThreshold,
    enableComments: c.enableComments,
  };
}

/**
 * Get triage config for a project
 */
function getTriageConfig(project: Project): TriageConfig {
  const configPath = path.join(getGitHubDir(project), 'config.json');

  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return {
      enabled: typeof data.triage_enabled === 'boolean' ? data.triage_enabled : DEFAULT_TRIAGE_CONFIG.enabled,
      duplicateThreshold: isThreshold(data.duplicate_threshold)
        ? data.duplicate_threshold
        : DEFAULT_TRIAGE_CONFIG.duplicateThreshold,
      spamThreshold: isThreshold(data.spam_threshold) ? data.spam_threshold : DEFAULT_TRIAGE_CONFIG.spamThreshold,
      featureCreepThreshold: isThreshold(data.feature_creep_threshold)
        ? data.feature_creep_threshold
        : DEFAULT_TRIAGE_CONFIG.featureCreepThreshold,
      enableComments:
        typeof data.enable_triage_comments === 'boolean'
          ? data.enable_triage_comments
          : DEFAULT_TRIAGE_CONFIG.enableComments,
    };
  } catch {
    // Defaults if the file doesn't exist or is invalid
    return { ...DEFAULT_TRIAGE_CONFIG };
  }
}

/**
 * Save triage config for a project
 */
function saveTriageConfig(project: Project, config: TriageConfig): void {
  const githubDir = getGitHubDir(project);
  fs.mkdirSync(githubDir, { recursive: true });

  const configPath = path.join(githubDir, 'config.json');
  let existingConfig: Record<string, unknown> = {};

  try {
    existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    // Use empty config if file doesn't exist or is invalid
  }

  const updatedConfig = {
    ...existingConfig,
    triage_enabled: config.enabled,
    duplicate_threshold: config.duplicateThreshold,
    spam_threshold: config.spamThreshold,
    feature_creep_threshold: config.featureCreepThreshold,
    enable_triage_comments: config.enableComments,
  };

  fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2), 'utf-8');
}

function triageResultPath(project: Project, issueNumber: number): string {
  return path.join(getGitHubDir(project), 'issues', `triage_${issueNumber}.json`);
}

/**
 * Get saved triage results for a project
 */
function getTriageResults(project: Project): TriageResult[] {
  const issuesDir = path.join(getGitHubDir(project), 'issues');
  const results: TriageResult[] = [];

  try {
    const files = fs.readdirSync(issuesDir);

    for (const file of files) {
      if (file.startsWith('triage_') && file.endsWith('.json')) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(issuesDir, file), 'utf-8'));
          results.push({
            issueNumber: data.issue_number,
            repo: data.repo,
            category: data.category,
            confidence: data.confidence,
            labelsToAdd: data.labels_to_add ?? [],
            labelsToRemove: data.labels_to_remove ?? [],
            isDuplicate: data.is_duplicate ?? false,
            duplicateOf: data.duplicate_of ?? undefined,
            isSpam: data.is_spam ?? false,
            isFeatureCreep: data.is_feature_creep ?? false,
            suggestedBreakdown: data.suggested_breakdown ?? [],
            priority: data.priority ?? 'medium',
            comment: data.comment ?? undefined,
            triagedAt: data.triaged_at ?? new Date().toISOString(),
            labelsAppliedAt: data.labels_applied_at ?? undefined,
          });
        } catch {
          // Skip invalid files
        }
      }
    }
  } catch {
    // Return empty array if directory doesn't exist
    return [];
  }

  return results.sort(
    (a, b) => new Date(b.triagedAt).getTime() - new Date(a.triagedAt).getTime(),
  );
}

/**
 * Save a single triage result to disk in the format expected by getTriageResults().
 */
function saveTriageResultToDisk(project: Project, result: TriageResult): void {
  const issuesDir = path.join(getGitHubDir(project), 'issues');
  fs.mkdirSync(issuesDir, { recursive: true });

  const data = {
    issue_number: result.issueNumber,
    repo: result.repo,
    category: result.category,
    confidence: result.confidence,
    labels_to_add: result.labelsToAdd,
    labels_to_remove: result.labelsToRemove,
    is_duplicate: result.isDuplicate,
    duplicate_of: result.duplicateOf ?? null,
    is_spam: result.isSpam,
    is_feature_creep: result.isFeatureCreep,
    suggested_breakdown: result.suggestedBreakdown,
    priority: result.priority,
    comment: result.comment ?? null,
    triaged_at: result.triagedAt,
    labels_applied_at: result.labelsAppliedAt ?? null,
  };

  fs.writeFileSync(triageResultPath(project, result.issueNumber), JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Get GitHub Issues model and thinking settings from app settings.
 * Returns the model shorthand (for TypeScript engine) and thinkingLevel.
 */
function getGitHubIssuesSettings(): { modelShorthand: ModelShorthand; thinkingLevel: ThinkingLevel } {
  const rawSettings = readSettingsFile();

  const featureModels = rawSettings?.featureModels ?? DEFAULT_FEATURE_MODELS;
  const featureThinking = rawSettings?.featureThinking ?? DEFAULT_FEATURE_THINKING;

  const modelShorthand = (featureModels.githubIssues ??
    DEFAULT_FEATURE_MODELS.githubIssues) as ModelShorthand;
  const thinkingLevel = (featureThinking.githubIssues ??
    DEFAULT_FEATURE_THINKING.githubIssues) as ThinkingLevel;

  debugLog('GitHub Issues settings', { modelShorthand, thinkingLevel });

  return { modelShorthand, thinkingLevel };
}

/**
 * Convert engine TriageResult to handler TriageResult format.
 *
 * zeenha fork: the configured thresholds were stored and never read. A
 * duplicate / spam / feature-creep flag now stands only when the AI's
 * confidence reaches that flag's threshold.
 */
function convertEngineResult(
  engineResult: EngineTriageResult,
  repo: string,
  config: TriageConfig,
): TriageResult {
  const confidence = engineResult.confidence;
  const isDuplicate = engineResult.isDuplicate && confidence >= config.duplicateThreshold;
  return {
    issueNumber: engineResult.issueNumber,
    repo,
    category: engineResult.category as TriageCategory,
    confidence,
    labelsToAdd: engineResult.labelsToAdd,
    labelsToRemove: engineResult.labelsToRemove,
    isDuplicate,
    duplicateOf: isDuplicate ? (engineResult.duplicateOf ?? undefined) : undefined,
    isSpam: engineResult.isSpam && confidence >= config.spamThreshold,
    isFeatureCreep: engineResult.isFeatureCreep && confidence >= config.featureCreepThreshold,
    suggestedBreakdown: engineResult.suggestedBreakdown,
    priority: engineResult.priority as 'high' | 'medium' | 'low',
    comment: engineResult.comment ?? undefined,
    triagedAt: new Date().toISOString(),
  };
}

/**
 * zeenha fork: local guard rather than the engine's `isTriageFailure`, so a
 * module mock of the engine that omits it cannot turn every outcome into a
 * "result".
 */
function isEngineFailure(outcome: EngineTriageOutcome): outcome is EngineTriageFailure {
  return (outcome as EngineTriageFailure).failed === true;
}

/** Outcome of a triage run: what was triaged, and which issues failed. */
interface TriageRunOutcome {
  results: TriageResult[];
  failedIssueNumbers: number[];
}

/** Positive integers only, de-duplicated; anything else from the renderer is dropped. */
function validIssueNumbers(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.filter((n): n is number => Number.isInteger(n) && n > 0))];
}

type GitHubApiIssue = {
  number: number;
  title: string;
  body?: string;
  user: { login: string };
  created_at: string;
  labels?: Array<{ name: string }>;
  pull_request?: unknown;
};

function toTriageIssue(issue: GitHubApiIssue): TriageGitHubIssue {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    author: { login: issue.user.login },
    createdAt: issue.created_at,
    labels: issue.labels,
  };
}

/**
 * Run the TypeScript triage engine on a set of issues.
 */
async function runTriage(
  project: Project,
  issueNumbers: number[] | null,
  mainWindow: BrowserWindow,
): Promise<TriageRunOutcome> {
  const { sendProgress } = createIPCCommunicators<TriageProgress, TriageResult[]>(
    mainWindow,
    {
      progress: IPC_CHANNELS.GITHUB_TRIAGE_PROGRESS,
      error: IPC_CHANNELS.GITHUB_TRIAGE_ERROR,
      complete: IPC_CHANNELS.GITHUB_TRIAGE_COMPLETE,
    },
    project.id,
  );

  const config = getGitHubConfig(project);
  if (!config) {
    throw new Error(GITHUB_NOT_CONFIGURED_MESSAGE);
  }
  const triageConfig = getTriageConfig(project);

  const { modelShorthand, thinkingLevel } = getGitHubIssuesSettings();

  debugLog('Starting TypeScript triage', { modelShorthand, thinkingLevel });

  // Fetch issues from GitHub API
  sendProgress({
    phase: 'fetching',
    progress: 10,
    message: 'Fetching issues from GitHub...',
    totalIssues: 0,
    processedIssues: 0,
  });

  let issuesToTriage: TriageGitHubIssue[];
  const unfetched: number[] = [];

  if (issueNumbers && issueNumbers.length > 0) {
    // Fetch specific issues
    const fetchedIssues = await Promise.all(
      issueNumbers.map(async (n): Promise<TriageGitHubIssue | null> => {
        try {
          const issue = (await githubFetch(config.token, `/repos/${config.repo}/issues/${n}`)) as GitHubApiIssue;
          // A pull request is not an issue to triage.
          return issue.pull_request ? null : toTriageIssue(issue);
        } catch {
          unfetched.push(n);
          return null;
        }
      }),
    );
    issuesToTriage = fetchedIssues.filter((i): i is TriageGitHubIssue => i !== null);
    // zeenha fork: issues that could not be fetched used to vanish, and a run
    // where none could be fetched reported "Triaged 0 issues".
    if (issuesToTriage.length === 0 && unfetched.length > 0) {
      throw new Error(`Could not fetch issue(s) ${formatIssueNumbers(unfetched.sort((a, b) => a - b))} from ${config.repo}`);
    }
  } else {
    // Fetch open issues (up to 100)
    const issues = (await githubFetch(
      config.token,
      `/repos/${config.repo}/issues?state=open&per_page=100`,
    )) as GitHubApiIssue[];

    // Filter out pull requests (GitHub API includes PRs in /issues)
    issuesToTriage = issues.filter((i) => !i.pull_request).map(toTriageIssue);
  }

  const totalIssues = issuesToTriage.length;
  debugLog('Issues to triage', { count: totalIssues });

  if (totalIssues === 0) {
    return { results: [], failedIssueNumbers: unfetched };
  }

  sendProgress({
    phase: 'analyzing',
    progress: 20,
    message: `Triaging ${totalIssues} issues...`,
    totalIssues,
    processedIssues: 0,
  });

  // Run triage engine
  const engineResults = await triageBatchIssues(
    issuesToTriage,
    { repo: config.repo, model: modelShorthand, thinkingLevel },
    (update) => {
      sendProgress({
        phase: 'analyzing',
        progress: 20 + Math.round(update.progress * 0.7),
        message: update.message,
        totalIssues,
        processedIssues: Math.round((update.progress / 100) * totalIssues),
      });
    },
  );

  // Convert and save results to disk.
  // zeenha fork: a failed issue is never saved (it used to be written as a
  // FEATURE at confidence 0 and reported as triaged).
  const results: TriageResult[] = [];
  const failures: EngineTriageFailure[] = [];
  for (const outcome of engineResults) {
    if (isEngineFailure(outcome)) {
      failures.push(outcome);
      continue;
    }
    const result = convertEngineResult(outcome, config.repo, triageConfig);
    results.push(result);
    saveTriageResultToDisk(project, result);
  }

  const failedIssueNumbers = [...unfetched, ...failures.map((f) => f.issueNumber)].sort((a, b) => a - b);
  if (failures.length > 0 && results.length === 0) {
    throw new Error(
      `Triage failed for all ${failures.length} issue(s) (${formatIssueNumbers(failures.map((f) => f.issueNumber))}): ${failures[0].error.slice(0, 200)}`,
    );
  }

  debugLog('Triage completed, results saved', { count: results.length, failedIssueNumbers });
  return { results, failedIssueNumbers };
}

function formatIssueNumbers(numbers: number[]): string {
  return numbers.map((n) => `#${n}`).join(', ');
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/** Every label defined in the repository, keyed by lower-case name (GitHub label names are case-insensitive). */
async function fetchRepoLabels(token: string, repo: string): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  for (let page = 1; page <= 10; page++) {
    const batch = (await githubFetch(token, `/repos/${repo}/labels?per_page=100&page=${page}`)) as Array<{
      name: string;
    }>;
    for (const label of batch) labels.set(label.name.toLowerCase(), label.name);
    if (batch.length < 100) break;
  }
  return labels;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && /GitHub API error: 404\b/.test(error.message);
}

/**
 * Write one issue's suggested labels to GitHub.
 *
 * zeenha fork: through the REST API with the project's own token and
 * repository, the same ones triage read the issue with. It used to shell out
 * to `gh issue edit` in the project directory, which edits whatever repository
 * and account the gh CLI resolves there, never removed labels, and aborted the
 * remaining issues at the first one that failed.
 *
 * Only labels that already exist in the repository are added; the rest are
 * reported as skipped, never created.
 */
async function applyLabelsToIssue(
  token: string,
  repo: string,
  result: TriageResult,
  repoLabels: Map<string, string>,
): Promise<{ added: string[]; removed: string[]; skipped: string[] }> {
  const skipped: string[] = [];
  const known = (name: string): string | null => {
    const canonical = repoLabels.get(name.toLowerCase());
    if (!canonical) skipped.push(name);
    return canonical ?? null;
  };
  const toRemove = [...new Set(result.labelsToRemove.map(known).filter((l): l is string => l !== null))];
  const removing = new Set(toRemove.map((l) => l.toLowerCase()));
  const toAdd = [
    ...new Set(
      result.labelsToAdd
        .map(known)
        .filter((l): l is string => l !== null && !removing.has(l.toLowerCase())),
    ),
  ];

  if (toAdd.length > 0) {
    await githubFetch(token, `/repos/${repo}/issues/${result.issueNumber}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: toAdd }),
    });
  }

  const removed: string[] = [];
  for (const label of toRemove) {
    try {
      await githubFetch(token, `/repos/${repo}/issues/${result.issueNumber}/labels/${encodeURIComponent(label)}`, {
        method: 'DELETE',
      });
      removed.push(label);
    } catch (error) {
      // The label is not on the issue: nothing to remove.
      if (!isNotFound(error)) throw error;
    }
  }

  return { added: toAdd, removed, skipped: [...new Set(skipped)] };
}

/**
 * Register triage-related handlers
 */
export function registerTriageHandlers(getMainWindow: () => BrowserWindow | null): void {
  debugLog('Registering Triage handlers');

  // Get triage config
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_TRIAGE_GET_CONFIG,
    async (_, projectId: string): Promise<TriageConfig | null> => {
      debugLog('getTriageConfig handler called', { projectId });
      return withProjectOrNull(projectId, async (project) => {
        const config = getTriageConfig(project);
        debugLog('Triage config loaded', { enabled: config.enabled });
        return config;
      });
    },
  );

  // Save triage config
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_TRIAGE_SAVE_CONFIG,
    async (_, projectId: string, input: unknown): Promise<boolean> => {
      const config = sanitizeTriageConfig(input);
      if (!config) {
        debugLog('saveTriageConfig refused an invalid config', { projectId });
        return false;
      }
      debugLog('saveTriageConfig handler called', { projectId, enabled: config.enabled });
      const result = await withProjectOrNull(projectId, async (project) => {
        saveTriageConfig(project, config);
        debugLog('Triage config saved');
        return true;
      });
      return result ?? false;
    },
  );

  // Get triage results
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_TRIAGE_GET_RESULTS,
    async (_, projectId: string): Promise<TriageResult[]> => {
      debugLog('getTriageResults handler called', { projectId });
      const result = await withProjectOrNull(projectId, async (project) => {
        const results = getTriageResults(project);
        debugLog('Triage results loaded', { count: results.length });
        return results;
      });
      return result ?? [];
    },
  );

  // Run triage
  ipcMain.on(
    IPC_CHANNELS.GITHUB_TRIAGE_RUN,
    async (_, projectId: string, issueNumbers?: unknown) => {
      debugLog('runTriage handler called', { projectId, issueNumbers });
      const mainWindow = getMainWindow();
      if (!mainWindow) {
        debugLog('No main window available');
        return;
      }

      const { sendProgress, sendError, sendComplete } = createIPCCommunicators<TriageProgress, TriageResult[]>(
        mainWindow,
        {
          progress: IPC_CHANNELS.GITHUB_TRIAGE_PROGRESS,
          error: IPC_CHANNELS.GITHUB_TRIAGE_ERROR,
          complete: IPC_CHANNELS.GITHUB_TRIAGE_COMPLETE,
        },
        projectId,
      );

      // zeenha fork: a second run for the same project raced the first on the
      // same result files and interleaved its progress events.
      if (runningProjects.has(projectId)) {
        sendError('Triage is already running for this project');
        return;
      }
      runningProjects.add(projectId);

      try {
        const ran = await withProjectOrNull(projectId, async (project) => {
          debugLog('Starting triage');
          sendProgress({
            phase: 'fetching',
            progress: 5,
            message: 'Starting triage...',
            totalIssues: 0,
            processedIssues: 0,
          });

          const requested = validIssueNumbers(issueNumbers);
          const { results, failedIssueNumbers } = await runTriage(
            project,
            requested.length > 0 ? requested : null,
            mainWindow,
          );

          debugLog('Triage completed', { resultsCount: results.length, failedIssueNumbers });
          // zeenha fork: name the issues that could not be triaged.
          const failedNote =
            failedIssueNumbers.length > 0
              ? `; could not triage ${failedIssueNumbers.length} issue(s): ${formatIssueNumbers(failedIssueNumbers)}`
              : '';
          sendProgress({
            phase: 'complete',
            progress: 100,
            message:
              results.length === 0 && failedIssueNumbers.length === 0
                ? 'No open issues to triage'
                : `Triaged ${results.length} issues${failedNote}`,
            totalIssues: results.length,
            processedIssues: results.length,
          });

          sendComplete(results);
          return true;
        });
        // zeenha fork: an unknown project used to end the run with no event at
        // all, leaving the renderer waiting forever.
        if (ran === null) {
          sendError('Project not found');
        }
      } catch (error) {
        debugLog('Triage failed', { error: error instanceof Error ? error.message : error });
        sendError(error instanceof Error ? error.message : 'Failed to run triage');
      } finally {
        runningProjects.delete(projectId);
      }
    },
  );

  // Apply labels to issues
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_TRIAGE_APPLY_LABELS,
    async (_, projectId: string, issueNumbersInput: unknown): Promise<GitHubTriageApplyResult> => {
      debugLog('applyTriageLabels handler called', { projectId, issueNumbers: issueNumbersInput });
      const refused = (error: string): GitHubTriageApplyResult => ({ success: false, error, applied: [], failed: [] });

      const issueNumbers = validIssueNumbers(issueNumbersInput);
      // Anything dropped by validation (not a positive integer, or repeated) refuses the whole request.
      if (
        issueNumbers.length === 0 ||
        !Array.isArray(issueNumbersInput) ||
        issueNumbers.length !== issueNumbersInput.length
      ) {
        return refused('Invalid issue numbers');
      }

      const outcome = await withProjectOrNull(projectId, async (project): Promise<GitHubTriageApplyResult> => {
        const config = getGitHubConfig(project);
        if (!config) {
          debugLog('No GitHub config found');
          return refused(GITHUB_NOT_CONFIGURED_MESSAGE);
        }

        let repoLabels: Map<string, string>;
        try {
          repoLabels = await fetchRepoLabels(config.token, config.repo);
        } catch (error) {
          return refused(`Could not read the labels of ${config.repo}: ${errorMessage(error)}`);
        }

        const byNumber = new Map(getTriageResults(project).map((r) => [r.issueNumber, r]));
        const applied: GitHubTriageApplyResult['applied'] = [];
        const failed: GitHubTriageApplyResult['failed'] = [];

        // One issue failing does not stop the others: each is reported.
        for (const issueNumber of issueNumbers) {
          const result = byNumber.get(issueNumber);
          if (!result) {
            failed.push({ issueNumber, error: 'No triage result for this issue; run triage first' });
            continue;
          }
          try {
            const done = await applyLabelsToIssue(config.token, config.repo, result, repoLabels);
            saveTriageResultToDisk(project, { ...result, labelsAppliedAt: new Date().toISOString() });
            applied.push({ issueNumber, ...done });
            debugLog('Labels applied', { issueNumber, added: done.added, removed: done.removed, skipped: done.skipped });
          } catch (error) {
            failed.push({ issueNumber, error: errorMessage(error) });
            debugLog('Failed to apply labels', { issueNumber, error: errorMessage(error) });
          }
        }

        return { success: true, applied, failed };
      });
      return outcome ?? refused('Project not found');
    },
  );

  debugLog('Triage handlers registered');
}
