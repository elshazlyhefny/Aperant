/**
 * GitHub issue-related IPC handlers
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult, GitHubIssue, GitHubIssuesCursor, PaginatedIssuesResult } from '../../../shared/types';
import { projectStore } from '../../project-store';
import { getGitHubConfig, githubFetch, normalizeRepoReference } from './utils';
import type { GitHubAPIIssue, GitHubAPIComment } from './types';
import { debugLog } from '../../../shared/utils/debug-logger';

// Pagination constants
const ISSUES_PER_PAGE = 50;           // Target number of issues per page (after filtering PRs)
const GITHUB_API_PER_PAGE = 100;      // GitHub API's max items per request
const MAX_PAGES_PAGINATED = 5;        // Max API pages fetched per request in paginated mode (not an absolute depth)
const MAX_PAGES_FETCH_ALL = 30;       // Max API pages to fetch in fetchAll mode

/**
 * Transform GitHub API issue to application format
 */
function transformIssue(issue: GitHubAPIIssue, repoFullName: string): GitHubIssue {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    assignees: issue.assignees.map(a => ({
      login: a.login,
      avatarUrl: a.avatar_url
    })),
    author: {
      login: issue.user.login,
      avatarUrl: issue.user.avatar_url
    },
    milestone: issue.milestone,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at,
    commentsCount: issue.comments,
    url: issue.url,
    htmlUrl: issue.html_url,
    repoFullName
  };
}

/**
 * Get list of issues from repository with pagination support
 *
 * Paginated mode (default): returns up to 50 issues, resuming from `cursor`
 * (a raw API page + offset). Returns `nextCursor` (null at the end of the repo)
 * so infinite scroll never re-downloads earlier pages.
 * fetchAll = true: Returns ALL issues (for search functionality)
 *
 * Note: GitHub's /issues endpoint returns both issues and PRs mixed together,
 * so we need to over-fetch and filter to get enough actual issues per page.
 */
export function registerGetIssues(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_GET_ISSUES,
    async (
      _,
      projectId: string,
      state: 'open' | 'closed' | 'all' = 'open',
      cursor?: GitHubIssuesCursor | null,
      fetchAll: boolean = false
    ): Promise<IPCResult<PaginatedIssuesResult>> => {
      debugLog('[GitHub Issues] getIssues handler called', { projectId, state, cursor, fetchAll });

      const project = projectStore.getProject(projectId);
      if (!project) {
        debugLog('[GitHub Issues] Project not found:', projectId);
        return { success: false, error: 'Project not found' };
      }

      const config = getGitHubConfig(project);
      if (!config) {
        debugLog('[GitHub Issues] No GitHub config found for project');
        return { success: false, error: 'No GitHub token or repository configured' };
      }

      try {
        const normalizedRepo = normalizeRepoReference(config.repo);
        if (!normalizedRepo) {
          return {
            success: false,
            error: 'Invalid repository format. Use owner/repo or GitHub URL.'
          };
        }

        debugLog('[GitHub Issues] Fetching issues from:', normalizedRepo, 'state:', state);

        if (fetchAll) {
          // Fetch ALL issues (for search functionality)
          const allIssues: GitHubAPIIssue[] = [];
          let apiPage = 1;

          while (apiPage <= MAX_PAGES_FETCH_ALL) {
            debugLog('[GitHub Issues] Fetching page', apiPage, '(fetchAll mode)');

            const pageIssues = await githubFetch(
              config.token,
              `/repos/${normalizedRepo}/issues?state=${state}&per_page=${GITHUB_API_PER_PAGE}&sort=updated&page=${apiPage}`
            );

            if (!Array.isArray(pageIssues) || pageIssues.length === 0) {
              break;
            }

            allIssues.push(...pageIssues);

            if (pageIssues.length < GITHUB_API_PER_PAGE) {
              break;
            }

            apiPage++;
          }

          const issuesOnly = allIssues.filter((issue: GitHubAPIIssue) => !issue.pull_request);
          const result: GitHubIssue[] = issuesOnly.map((issue: GitHubAPIIssue) =>
            transformIssue(issue, normalizedRepo)
          );

          debugLog('[GitHub Issues] fetchAll complete:', result.length, 'issues');
          return { success: true, data: { issues: result, hasMore: false, nextCursor: null } };
        }

        // Paginated fetching, resumed from a cursor. The cursor points at the raw
        // GitHub item (API page + offset) after the last one the renderer received,
        // so earlier pages are never downloaded again.
        const rawApiPage = cursor?.apiPage;
        const rawOffset = cursor?.offset;
        const validCursor =
          Number.isInteger(rawApiPage) && (rawApiPage as number) >= 1 &&
          Number.isInteger(rawOffset) && (rawOffset as number) >= 0;
        let apiPage = validCursor ? (rawApiPage as number) : 1;
        let offset = validCursor ? (rawOffset as number) : 0;

        const collectedIssues: GitHubAPIIssue[] = [];
        let nextCursor: GitHubIssuesCursor | null = null;
        let pagesFetched = 0;

        while (collectedIssues.length < ISSUES_PER_PAGE) {
          if (pagesFetched >= MAX_PAGES_PAGINATED) {
            // Per-request cap hit (e.g. many PRs in a row): return what we have and
            // advance the cursor so the next call makes progress.
            nextCursor = { apiPage, offset: 0 };
            break;
          }

          debugLog('[GitHub Issues] Fetching API page', apiPage, 'offset', offset, 'collected so far:', collectedIssues.length);

          const pageItems = await githubFetch(
            config.token,
            `/repos/${normalizedRepo}/issues?state=${state}&per_page=${GITHUB_API_PER_PAGE}&sort=updated&page=${apiPage}`
          );
          pagesFetched++;

          if (!Array.isArray(pageItems) || pageItems.length === 0) {
            debugLog('[GitHub Issues] End of issues (empty or unexpected response)');
            nextCursor = null;
            break;
          }

          const fullPage = pageItems.length >= GITHUB_API_PER_PAGE;
          let stoppedAt = -1;
          for (let i = offset; i < pageItems.length; i++) {
            const item = pageItems[i] as GitHubAPIIssue;
            if (item.pull_request) continue;
            collectedIssues.push(item);
            if (collectedIssues.length >= ISSUES_PER_PAGE) {
              stoppedAt = i;
              break;
            }
          }

          debugLog('[GitHub Issues] API page', apiPage, ':', pageItems.length, 'items, collected', collectedIssues.length);

          if (stoppedAt >= 0 && stoppedAt + 1 < pageItems.length) {
            nextCursor = { apiPage, offset: stoppedAt + 1 };
            break;
          }

          if (!fullPage) {
            nextCursor = null; // short page: end of the repository's issues
            break;
          }

          apiPage++;
          offset = 0;
          if (stoppedAt >= 0) {
            nextCursor = { apiPage, offset: 0 };
            break;
          }
        }

        const hasMore = nextCursor !== null;
        const result: GitHubIssue[] = collectedIssues.map((issue: GitHubAPIIssue) =>
          transformIssue(issue, normalizedRepo)
        );

        debugLog('[GitHub Issues] Returning', result.length, 'issues, hasMore:', hasMore, 'nextCursor:', nextCursor);
        return { success: true, data: { issues: result, hasMore, nextCursor } };
      } catch (error) {
        debugLog('[GitHub Issues] Error fetching issues:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch issues'
        };
      }
    }
  );
}

/**
 * Get a single issue by number
 */
export function registerGetIssue(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_GET_ISSUE,
    async (_, projectId: string, issueNumber: number): Promise<IPCResult<GitHubIssue>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const config = getGitHubConfig(project);
      if (!config) {
        return { success: false, error: 'No GitHub token or repository configured' };
      }

      try {
        const normalizedRepo = normalizeRepoReference(config.repo);
        if (!normalizedRepo) {
          return {
            success: false,
            error: 'Invalid repository format. Use owner/repo or GitHub URL.'
          };
        }

        const issue = await githubFetch(
          config.token,
          `/repos/${normalizedRepo}/issues/${issueNumber}`
        ) as GitHubAPIIssue;

        const result = transformIssue(issue, normalizedRepo);

        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch issue'
        };
      }
    }
  );
}

/**
 * Get comments for a specific issue
 */
export function registerGetIssueComments(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_GET_ISSUE_COMMENTS,
    async (_, projectId: string, issueNumber: number): Promise<IPCResult<GitHubAPIComment[]>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const config = getGitHubConfig(project);
      if (!config) {
        return { success: false, error: 'No GitHub token or repository configured' };
      }

      try {
        const normalizedRepo = normalizeRepoReference(config.repo);
        if (!normalizedRepo) {
          return {
            success: false,
            error: 'Invalid repository format. Use owner/repo or GitHub URL.'
          };
        }

        const comments = await githubFetch(
          config.token,
          `/repos/${normalizedRepo}/issues/${issueNumber}/comments`
        ) as GitHubAPIComment[];

        return { success: true, data: comments };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch issue comments'
        };
      }
    }
  );
}

/**
 * Register all issue-related handlers
 */
export function registerIssueHandlers(): void {
  registerGetIssues();
  registerGetIssue();
  registerGetIssueComments();
}
