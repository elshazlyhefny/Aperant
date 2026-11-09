import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPRsFromGraphQL, githubGraphQL, mapGraphQLPRToData } from "../graphql";
import { sanitizeNetworkData } from "../shared";

vi.mock("../../utils", () => ({
  normalizeRepoReference: (repo: string) => repo,
}));

const node = {
  number: 7,
  title: "T",
  body: null,
  state: "OPEN",
  author: null,
  headRefName: "feat",
  baseRefName: "main",
  additions: 1,
  deletions: 2,
  changedFiles: 3,
  assignees: { nodes: [{ login: "a" }, { login: "b" }] },
  createdAt: "c",
  updatedAt: "u",
  url: "https://x",
};

function stubFetch(impl: () => unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => impl()));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mapGraphQLPRToData", () => {
  it("applies defaults and mappings", () => {
    const pr = mapGraphQLPRToData(node);
    expect(pr.author.login).toBe("unknown");
    expect(pr.state).toBe("open");
    expect(pr.body).toBe("");
    expect(pr.assignees).toEqual([{ login: "a" }, { login: "b" }]);
    expect(pr.files).toEqual([]);
    expect(pr.htmlUrl).toBe("https://x");
  });
});

describe("githubGraphQL", () => {
  it("throws on non-OK response", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() => ({ ok: false, status: 500, statusText: "err" }));
    await expect(githubGraphQL("t", "q")).rejects.toThrow("Failed to connect to GitHub API");
  });

  it("throws on GraphQL errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() => ({ ok: true, json: async () => ({ errors: [{ message: "bad" }] }) }));
    await expect(githubGraphQL("t", "q")).rejects.toThrow("GitHub API request failed");
  });
});

describe("fetchPRsFromGraphQL", () => {
  it("returns mapped PRs", async () => {
    stubFetch(() => ({
      ok: true,
      json: async () => ({
        data: {
          repository: {
            pullRequests: { pageInfo: { hasNextPage: true, endCursor: "x" }, nodes: [node] },
          },
        },
      }),
    }));
    const res = await fetchPRsFromGraphQL({ token: "t", repo: "o/r" }, null, "test");
    expect(res.prs).toHaveLength(1);
    expect(res.hasNextPage).toBe(true);
    expect(res.endCursor).toBe("x");
  });

  it("returns an empty result for a null repository", async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ data: { repository: null } }) }));
    const res = await fetchPRsFromGraphQL({ token: "t", repo: "o/r" }, null, "test");
    expect(res).toEqual({ prs: [], hasNextPage: false, endCursor: null });
  });

  it("returns an empty result when the request fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() => ({ ok: false, status: 500, statusText: "err" }));
    const res = await fetchPRsFromGraphQL({ token: "t", repo: "o/r" }, null, "test");
    expect(res).toEqual({ prs: [], hasNextPage: false, endCursor: null });
  });
});

describe("sanitizeNetworkData", () => {
  it("strips control chars but keeps newline, tab and CR", () => {
    expect(sanitizeNetworkData("a\u0000b\u0007c\u007fd\ne\tf\rg")).toBe("abcd\ne\tf\rg");
  });

  it("truncates at maxLength", () => {
    expect(sanitizeNetworkData("abcdef", 3)).toBe("abc");
  });
});
