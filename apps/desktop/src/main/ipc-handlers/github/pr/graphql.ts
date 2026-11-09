/**
 * GitHub GraphQL helpers for listing pull requests.
 */

import { normalizeRepoReference } from "../utils";
import { debugLog } from "./shared";
import type { PRData, PRListResult } from "./types";

/**
 * GraphQL response type for PR list query
 * Note: repository can be null if the repo doesn't exist or user lacks access
 */
interface GraphQLPRNode {
  number: number;
  title: string;
  body: string | null;
  state: string;
  author: { login: string } | null;
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  assignees: { nodes: Array<{ login: string }> };
  createdAt: string;
  updatedAt: string;
  url: string;
}

interface GraphQLPRListResponse {
  data: {
    repository: {
      pullRequests: {
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
        nodes: GraphQLPRNode[];
      };
    } | null;
  };
  errors?: Array<{ message: string }>;
}

/**
 * Maps a GraphQL PR node to the frontend PRData format.
 * Shared between listPRs and listMorePRs handlers.
 */
export function mapGraphQLPRToData(pr: GraphQLPRNode): PRData {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    state: pr.state.toLowerCase(),
    author: { login: pr.author?.login ?? "unknown" },
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    assignees: pr.assignees.nodes.map((a) => ({ login: a.login })),
    files: [],
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    htmlUrl: pr.url,
  };
}

/**
 * Make a GraphQL request to GitHub API
 */
export async function githubGraphQL<T>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  // CodeQL: file data in outbound request - validate token is a non-empty string before use
  // lgtm[js/file-access-to-http] - Official GitHub GraphQL API endpoint
  const safeToken = typeof token === 'string' && token.length > 0 ? token : '';
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${safeToken}`,
      "Content-Type": "application/json",
      "User-Agent": "Aperant",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    // Log detailed error for debugging, throw generic message for safety
    console.error(`GitHub GraphQL HTTP error: ${response.status} ${response.statusText}`);
    throw new Error("Failed to connect to GitHub API");
  }

  const result = await response.json() as T & { errors?: Array<{ message: string }> };

  // Check for GraphQL-level errors
  if (result.errors && result.errors.length > 0) {
    // Log detailed errors for debugging, throw generic message for safety
    console.error(`GitHub GraphQL errors: ${result.errors.map(e => e.message).join(", ")}`);
    throw new Error("GitHub API request failed");
  }

  return result;
}

/**
 * GraphQL query to fetch PRs with diff stats
 */
export const LIST_PRS_QUERY = `
query($owner: String!, $repo: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: $first, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        body
        state
        author { login }
        headRefName
        baseRefName
        additions
        deletions
        changedFiles
        assignees(first: 10) { nodes { login } }
        createdAt
        updatedAt
        url
      }
    }
  }
}
`;

/**
 * Shared helper to fetch PRs via GraphQL API.
 * Used by both listPRs and listMorePRs handlers to avoid code duplication.
 */
export async function fetchPRsFromGraphQL(
  config: { token: string; repo: string },
  cursor: string | null,
  debugContext: string
): Promise<PRListResult> {
  // Parse owner/repo from config - must be exactly "owner/repo" format
  const normalizedRepo = normalizeRepoReference(config.repo);
  const repoParts = normalizedRepo.split("/");
  if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
    debugLog("Invalid repo format - expected 'owner/repo'", {
      repo: config.repo,
      normalized: normalizedRepo,
      context: debugContext,
    });
    return { prs: [], hasNextPage: false, endCursor: null };
  }
  const [owner, repo] = repoParts;

  try {
    // Use GraphQL API to get PRs with diff stats (REST list endpoint doesn't include them)
    // Fetches up to 100 open PRs (GitHub GraphQL max per request)
    const response = await githubGraphQL<GraphQLPRListResponse>(
      config.token,
      LIST_PRS_QUERY,
      {
        owner,
        repo,
        first: 100, // GitHub GraphQL max is 100
        after: cursor,
      }
    );

    // Handle case where repository doesn't exist or user lacks access
    if (!response.data.repository) {
      debugLog("Repository not found or access denied", { owner, repo, context: debugContext });
      return { prs: [], hasNextPage: false, endCursor: null };
    }

    const { nodes: prNodes, pageInfo } = response.data.repository.pullRequests;

    debugLog(`Fetched PRs via GraphQL (${debugContext})`, {
      count: prNodes.length,
      hasNextPage: pageInfo.hasNextPage,
      endCursor: pageInfo.endCursor,
    });
    return {
      prs: prNodes.map(mapGraphQLPRToData),
      hasNextPage: pageInfo.hasNextPage,
      endCursor: pageInfo.endCursor,
    };
  } catch (error) {
    debugLog(`Failed to fetch PRs (${debugContext})`, {
      error: error instanceof Error ? error.message : error,
    });
    return { prs: [], hasNextPage: false, endCursor: null };
  }
}
