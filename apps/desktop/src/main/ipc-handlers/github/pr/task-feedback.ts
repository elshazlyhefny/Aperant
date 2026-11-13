/**
 * zeenha fork: fetch the failing CI checks and unresolved review feedback of a
 * task's pull request so they can be sent back to the task's agent.
 *
 * Returns only the GitHub-derived pieces of PRFeedbackResult. The IPC handler
 * adds worktree, auth and follow-up eligibility fields.
 */

import { githubFetch, normalizeRepoReference } from "../utils";
import { githubGraphQL } from "./graphql";
import type { PRFeedbackItem, PRFeedbackResult } from "../../../../shared/types/pr-feedback";
import { stripAnsiCodes } from "../../../../shared/utils/ansi-sanitizer";

/** Max items returned per category. */
export const MAX_FEEDBACK_ITEMS = 50;
/** Max characters kept from any one item's summary. */
export const MAX_SUMMARY_LENGTH = 4000;
const MAX_TITLE_LENGTH = 300;
const MAX_THREAD_COMMENTS = 5;

const FAILED_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
]);

export type PRFeedbackErrorCode =
  | "invalid_repo"
  | "not_found"
  | "forbidden"
  | "unauthorized"
  | "github_error"
  | "gitlab_error";

/** Typed error so the IPC handler can map failures to a clear message. */
export class PRFeedbackError extends Error {
  constructor(
    public readonly code: PRFeedbackErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PRFeedbackError";
  }
}

export type PRFeedbackFetchResult = Pick<
  PRFeedbackResult,
  "prNumber" | "prUrl" | "prState" | "headRef" | "headSha" | "checks" | "threads" | "reviews"
>;

/**
 * Parse a PR number out of a pull request URL (github.com or GitHub Enterprise).
 * Returns null for anything that is not a plain `/<owner>/<repo>/pull/<n>` URL.
 */
export function parsePRNumberFromUrl(prUrl: string): number | null {
  if (typeof prUrl !== "string" || prUrl.length === 0 || prUrl.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(prUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const match = /^\/[^/]+\/[^/]+\/pull\/(\d{1,9})(?:\/[^/]*)*$/.exec(url.pathname);
  if (!match) return null;
  const num = Number.parseInt(match[1], 10);
  return num > 0 ? num : null;
}

/** Redact common credential shapes from third-party text before it reaches an agent. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted]")
    .replace(/\bglpat-[A-Za-z0-9_-]{20,}/g, "[redacted]")
    .replace(/\bgl[a-z]{2,4}-[A-Za-z0-9_-]{20,}/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, "Bearer [redacted]");
}

export function clip(
  text: string | null | undefined,
  max: number
): { text: string; truncated: boolean } {
  const clean = redactSecrets((text ?? "").trim());
  if (clean.length <= max) return { text: clean, truncated: false };
  return { text: `${clean.slice(0, max)}…`, truncated: true };
}

/**
 * Like clip, but keeps the END of the text (job logs matter at the end).
 * Strips ANSI escapes and redacts secrets first.
 */
export function clipTail(
  text: string | null | undefined,
  max: number
): { text: string; truncated: boolean } {
  const clean = redactSecrets(stripAnsiCodes(text ?? "").trim());
  if (clean.length <= max) return { text: clean, truncated: false };
  return { text: `…${clean.slice(clean.length - max)}`, truncated: true };
}

function mapGitHubError(error: unknown, what: string): PRFeedbackError {
  if (error instanceof PRFeedbackError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const status = /GitHub API error: (\d{3})/.exec(message)?.[1];
  if (status === "404") return new PRFeedbackError("not_found", `${what} was not found on GitHub`);
  if (status === "401") return new PRFeedbackError("unauthorized", "GitHub rejected the credentials");
  if (status === "403") {
    return new PRFeedbackError("forbidden", `Access to ${what} was denied (permissions or rate limit)`);
  }
  return new PRFeedbackError("github_error", `Failed to load ${what} from GitHub`);
}

interface RESTPullRequest {
  state: string;
  merged?: boolean;
  merged_at?: string | null;
  html_url?: string;
  head: { ref: string; sha: string };
}

interface RESTCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string | null;
  details_url?: string | null;
  output?: { title?: string | null; summary?: string | null; text?: string | null } | null;
}

interface RESTCombinedStatus {
  statuses?: Array<{
    id: number;
    context: string;
    state: string;
    description?: string | null;
    target_url?: string | null;
  }>;
}

function mapCheckRun(run: RESTCheckRun): PRFeedbackItem {
  const parts = [run.output?.title, run.output?.summary, run.output?.text]
    .map((p) => (p ?? "").trim())
    .filter(Boolean);
  const body = clip(parts.join("\n\n") || `Conclusion: ${run.conclusion}`, MAX_SUMMARY_LENGTH);
  return {
    id: `check:${run.id}`,
    kind: "check",
    title: clip(run.name, MAX_TITLE_LENGTH).text,
    summary: body.text,
    url: run.html_url ?? run.details_url ?? undefined,
    truncated: body.truncated,
  };
}

async function fetchFailedChecks(
  token: string,
  repo: string,
  sha: string
): Promise<PRFeedbackItem[]> {
  const runs = (await githubFetch(
    token,
    `/repos/${repo}/commits/${sha}/check-runs?per_page=100`
  )) as { check_runs?: RESTCheckRun[] };

  const items = (runs.check_runs ?? [])
    .filter(
      (r) => r.status === "completed" && r.conclusion != null && FAILED_CONCLUSIONS.has(r.conclusion)
    )
    .map(mapCheckRun);

  // Legacy commit statuses (not reported as check runs). Best effort.
  try {
    const combined = (await githubFetch(
      token,
      `/repos/${repo}/commits/${sha}/status?per_page=100`
    )) as RESTCombinedStatus;
    for (const s of combined.statuses ?? []) {
      if (s.state !== "failure" && s.state !== "error") continue;
      const body = clip(s.description || `State: ${s.state}`, MAX_SUMMARY_LENGTH);
      items.push({
        id: `check:status-${s.id}`,
        kind: "check",
        title: clip(s.context, MAX_TITLE_LENGTH).text,
        summary: body.text,
        url: s.target_url ?? undefined,
        truncated: body.truncated,
      });
    }
  } catch {
    // Legacy statuses are optional; check runs are authoritative.
  }

  return items.slice(0, MAX_FEEDBACK_ITEMS);
}

const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: ${MAX_THREAD_COMMENTS}) {
            nodes { author { login } body url }
          }
        }
      }
    }
  }
}
`;

interface GraphQLThreadsResponse {
  data?: {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            id: string;
            isResolved: boolean;
            isOutdated: boolean;
            path: string | null;
            line: number | null;
            comments: {
              nodes: Array<{ author: { login: string } | null; body: string; url?: string }>;
            };
          }>;
        };
      } | null;
    } | null;
  };
}

async function fetchUnresolvedThreads(
  token: string,
  owner: string,
  repo: string,
  prNumber: number
): Promise<PRFeedbackItem[]> {
  const items: PRFeedbackItem[] = [];
  let after: string | null = null;
  // Bounded pagination so a huge PR cannot loop forever.
  for (let page = 0; page < 10 && items.length < MAX_FEEDBACK_ITEMS; page++) {
    const response: GraphQLThreadsResponse = await githubGraphQL<GraphQLThreadsResponse>(
      token,
      REVIEW_THREADS_QUERY,
      { owner, repo, number: prNumber, after }
    );
    const threads = response.data?.repository?.pullRequest?.reviewThreads;
    if (!threads) {
      if (page === 0) throw new PRFeedbackError("not_found", "Pull request was not found on GitHub");
      break;
    }

    for (const t of threads.nodes) {
      if (t.isResolved) continue;
      const comments = t.comments.nodes;
      const first = comments[0];
      const rendered = comments
        .map((c) => `${c.author?.login ?? "unknown"}: ${(c.body ?? "").trim()}`)
        .join("\n\n");
      const body = clip(rendered, MAX_SUMMARY_LENGTH);
      const location = t.path ? `${t.path}${t.line ? `:${t.line}` : ""}` : "Review thread";
      items.push({
        id: `thread:${t.id}`,
        kind: "review_thread",
        title: clip(t.isOutdated ? `${location} (outdated)` : location, MAX_TITLE_LENGTH).text,
        summary: body.text,
        url: first?.url,
        path: t.path ?? undefined,
        line: t.line ?? undefined,
        author: first?.author?.login,
        truncated: body.truncated,
      });
      if (items.length >= MAX_FEEDBACK_ITEMS) break;
    }

    if (!threads.pageInfo.hasNextPage) break;
    after = threads.pageInfo.endCursor;
  }
  return items;
}

interface RESTReview {
  id: number;
  state: string;
  body?: string | null;
  html_url?: string;
  user?: { login: string } | null;
}

async function fetchChangesRequestedReviews(
  token: string,
  repo: string,
  prNumber: number
): Promise<PRFeedbackItem[]> {
  const reviews = (await githubFetch(
    token,
    `/repos/${repo}/pulls/${prNumber}/reviews?per_page=100`
  )) as RESTReview[];

  return (Array.isArray(reviews) ? reviews : [])
    .filter((r) => r.state === "CHANGES_REQUESTED" && (r.body ?? "").trim().length > 0)
    .slice(0, MAX_FEEDBACK_ITEMS)
    .map((r) => {
      const body = clip(r.body, MAX_SUMMARY_LENGTH);
      const author = r.user?.login;
      return {
        id: `review:${r.id}`,
        kind: "review" as const,
        title: clip(author ? `Changes requested by ${author}` : "Changes requested", MAX_TITLE_LENGTH)
          .text,
        summary: body.text,
        url: r.html_url,
        author,
        truncated: body.truncated,
      };
    });
}

/**
 * Fetch failing checks and unresolved review feedback for a pull request.
 * @throws PRFeedbackError for invalid repo, 401/403/404, and other GitHub failures.
 */
export async function fetchPRFeedback(
  config: { token: string; repo: string },
  prNumber: number
): Promise<PRFeedbackFetchResult> {
  const repo = normalizeRepoReference(config.repo);
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new PRFeedbackError("invalid_repo", "GitHub repository is not configured correctly");
  }
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new PRFeedbackError("not_found", "Invalid pull request number");
  }
  const [owner, name] = parts;

  try {
    const pr = (await githubFetch(
      config.token,
      `/repos/${repo}/pulls/${prNumber}`
    )) as RESTPullRequest;

    const prState: PRFeedbackResult["prState"] =
      pr.merged || pr.merged_at ? "merged" : pr.state === "open" ? "open" : "closed";

    const [checks, threads, reviews] = await Promise.all([
      fetchFailedChecks(config.token, repo, pr.head.sha),
      fetchUnresolvedThreads(config.token, owner, name, prNumber),
      fetchChangesRequestedReviews(config.token, repo, prNumber),
    ]);

    return {
      prNumber,
      prUrl: pr.html_url ?? `https://github.com/${repo}/pull/${prNumber}`,
      prState,
      headRef: pr.head.ref,
      headSha: pr.head.sha,
      checks,
      threads,
      reviews,
    };
  } catch (error) {
    throw mapGitHubError(error, `pull request #${prNumber}`);
  }
}
