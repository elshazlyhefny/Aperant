import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../utils", () => ({
  githubFetch: vi.fn(),
  normalizeRepoReference: (r: string) => r,
}));
vi.mock("../graphql", () => ({
  githubGraphQL: vi.fn(),
}));

import { githubFetch } from "../../utils";
import { githubGraphQL } from "../graphql";
import {
  fetchPRFeedback,
  parsePRNumberFromUrl,
  PRFeedbackError,
  MAX_FEEDBACK_ITEMS,
  MAX_SUMMARY_LENGTH,
} from "../task-feedback";

const mockFetch = vi.mocked(githubFetch);
const mockGraphQL = vi.mocked(githubGraphQL);
const TOKEN = "ghp_SECRETTOKEN1234567890abcdef";
const config = { token: TOKEN, repo: "o/r" };

const pr = { state: "open", html_url: "https://github.com/o/r/pull/7", head: { ref: "feat", sha: "abc" } };

function setup(opts: {
  pr?: unknown;
  runs?: unknown[];
  statuses?: unknown[];
  reviews?: unknown[];
  threads?: unknown[];
}) {
  mockFetch.mockImplementation(async (_t: string, endpoint: string) => {
    if (endpoint.includes("/check-runs")) return { check_runs: opts.runs ?? [] };
    if (endpoint.includes("/status")) return { statuses: opts.statuses ?? [] };
    if (endpoint.includes("/reviews")) return opts.reviews ?? [];
    return opts.pr ?? pr;
  });
  mockGraphQL.mockResolvedValue({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: opts.threads ?? [],
          },
        },
      },
    },
  });
}

const run = (id: number, conclusion: string | null, status = "completed", extra = {}) => ({
  id,
  name: `job-${id}`,
  status,
  conclusion,
  html_url: `https://github.com/o/r/runs/${id}`,
  output: { title: "T", summary: "S", text: null },
  ...extra,
});

const thread = (id: string, isResolved: boolean, body = "fix this") => ({
  id,
  isResolved,
  isOutdated: false,
  path: "src/a.ts",
  line: 12,
  comments: { nodes: [{ author: { login: "alice" }, body, url: "https://x/c" }] },
});

describe("parsePRNumberFromUrl", () => {
  it("parses github.com and enterprise PR URLs", () => {
    expect(parsePRNumberFromUrl("https://github.com/o/r/pull/42")).toBe(42);
    expect(parsePRNumberFromUrl("https://github.com/o/r/pull/42/files")).toBe(42);
    expect(parsePRNumberFromUrl("https://ghe.corp.example/o/r/pull/9")).toBe(9);
  });

  it("rejects non-PR and malicious URLs", () => {
    expect(parsePRNumberFromUrl("https://github.com/o/r/issues/42")).toBeNull();
    expect(parsePRNumberFromUrl("https://github.com/o/r/pull/abc")).toBeNull();
    expect(parsePRNumberFromUrl("https://github.com/o/r/pull/0")).toBeNull();
    expect(parsePRNumberFromUrl("javascript:alert(1)//o/r/pull/1")).toBeNull();
    expect(parsePRNumberFromUrl("file:///o/r/pull/1")).toBeNull();
    expect(parsePRNumberFromUrl("https://user:pw@evil.com/o/r/pull/1")).toBeNull();
    expect(parsePRNumberFromUrl("https://evil.com/?x=/o/r/pull/1")).toBeNull();
    expect(parsePRNumberFromUrl("not a url")).toBeNull();
    expect(parsePRNumberFromUrl("")).toBeNull();
  });
});

describe("fetchPRFeedback", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockGraphQL.mockReset();
  });

  it("returns only failed checks, with stable ids", async () => {
    setup({
      runs: [
        run(1, "failure"),
        run(2, "success"),
        run(3, "skipped"),
        run(4, null, "in_progress"),
        run(5, "timed_out"),
        run(6, "cancelled"),
        run(7, "action_required"),
        run(8, "startup_failure"),
        run(9, "neutral"),
      ],
      statuses: [
        { id: 100, context: "ci/legacy", state: "failure", description: "broke" },
        { id: 101, context: "ci/ok", state: "success" },
        { id: 102, context: "ci/pending", state: "pending" },
      ],
    });
    const first = await fetchPRFeedback(config, 7);
    expect(first.checks.map((c) => c.id)).toEqual([
      "check:1",
      "check:5",
      "check:6",
      "check:7",
      "check:8",
      "check:status-100",
    ]);
    expect(first.checks[0]).toMatchObject({ kind: "check", title: "job-1", truncated: false });
    const second = await fetchPRFeedback(config, 7);
    expect(second.checks.map((c) => c.id)).toEqual(first.checks.map((c) => c.id));
  });

  it("returns PR meta and maps merged/closed state", async () => {
    setup({});
    const open = await fetchPRFeedback(config, 7);
    expect(open).toMatchObject({ prNumber: 7, prState: "open", headRef: "feat", headSha: "abc" });
    setup({ pr: { ...pr, state: "closed", merged: true } });
    expect((await fetchPRFeedback(config, 7)).prState).toBe("merged");
    setup({ pr: { ...pr, state: "closed" } });
    expect((await fetchPRFeedback(config, 7)).prState).toBe("closed");
  });

  it("excludes resolved threads and keeps unresolved with location and author", async () => {
    setup({ threads: [thread("T_a", false), thread("T_b", true)] });
    const res = await fetchPRFeedback(config, 7);
    expect(res.threads).toHaveLength(1);
    expect(res.threads[0]).toMatchObject({
      id: "thread:T_a",
      kind: "review_thread",
      path: "src/a.ts",
      line: 12,
      author: "alice",
    });
    expect(res.threads[0].summary).toContain("alice: fix this");
  });

  it("includes only CHANGES_REQUESTED reviews with a body", async () => {
    setup({
      reviews: [
        { id: 1, state: "CHANGES_REQUESTED", body: "please fix", user: { login: "bob" } },
        { id: 2, state: "CHANGES_REQUESTED", body: "   ", user: { login: "bob" } },
        { id: 3, state: "APPROVED", body: "lgtm", user: { login: "bob" } },
        { id: 4, state: "COMMENTED", body: "hmm", user: { login: "bob" } },
      ],
    });
    const res = await fetchPRFeedback(config, 7);
    expect(res.reviews.map((r) => r.id)).toEqual(["review:1"]);
    expect(res.reviews[0].author).toBe("bob");
  });

  it("truncates long text and caps item count", async () => {
    setup({
      runs: Array.from({ length: MAX_FEEDBACK_ITEMS + 20 }, (_, i) =>
        run(i + 1, "failure", "completed", {
          output: { title: "T", summary: "x".repeat(MAX_SUMMARY_LENGTH * 2), text: null },
        })
      ),
    });
    const res = await fetchPRFeedback(config, 7);
    expect(res.checks).toHaveLength(MAX_FEEDBACK_ITEMS);
    expect(res.checks[0].truncated).toBe(true);
    expect(res.checks[0].summary.length).toBeLessThanOrEqual(MAX_SUMMARY_LENGTH + 1);
  });

  it("does not leak the token or redacts secrets found in text", async () => {
    setup({
      runs: [
        run(1, "failure", "completed", {
          output: { title: "T", summary: `leaked ${TOKEN} here`, text: null },
        }),
      ],
    });
    const res = await fetchPRFeedback(config, 7);
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });

  it("maps HTTP failures to typed errors", async () => {
    mockFetch.mockRejectedValue(new Error("GitHub API error: 404 - Not Found"));
    await expect(fetchPRFeedback(config, 7)).rejects.toMatchObject({ code: "not_found" });
    mockFetch.mockRejectedValue(new Error("GitHub API error: 403 - nope"));
    await expect(fetchPRFeedback(config, 7)).rejects.toMatchObject({ code: "forbidden" });
    mockFetch.mockRejectedValue(new Error("GitHub API error: 401 - bad"));
    await expect(fetchPRFeedback(config, 7)).rejects.toMatchObject({ code: "unauthorized" });
    mockFetch.mockRejectedValue(new Error("network down"));
    const err = await fetchPRFeedback(config, 7).catch((e) => e);
    expect(err).toBeInstanceOf(PRFeedbackError);
    expect(err.code).toBe("github_error");
  });

  it("rejects a missing or malformed repo", async () => {
    await expect(fetchPRFeedback({ token: "t", repo: "" }, 7)).rejects.toMatchObject({
      code: "invalid_repo",
    });
    await expect(fetchPRFeedback({ token: "t", repo: "a/b/c" }, 7)).rejects.toMatchObject({
      code: "invalid_repo",
    });
  });
});
