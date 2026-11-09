import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../utils", () => ({
  githubFetch: vi.fn(),
}));

import { githubFetch } from "../../utils";
import { waitForCIChecks, performCIWaitCheck } from "../ci-wait";

const mockFetch = vi.mocked(githubFetch);

const pending = (names: string[]) => ({
  total_count: names.length,
  check_runs: names.map((name) => ({ name, status: "in_progress", conclusion: null })),
});
const done = { total_count: 1, check_runs: [{ name: "build", status: "completed", conclusion: "success" }] };

describe("waitForCIChecks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns success immediately when no checks are pending", async () => {
    mockFetch.mockResolvedValueOnce(done);
    const sendProgress = vi.fn();
    const result = await waitForCIChecks("t", "o/r", "sha", 1, sendProgress);
    expect(result).toEqual({
      success: true,
      hasInProgress: false,
      inProgressCount: 0,
      inProgressChecks: [],
      timedOut: false,
      waitTimeSeconds: 0,
    });
    expect(sendProgress).not.toHaveBeenCalled();
  });

  it("waits while checks are pending, then succeeds with waitTimeSeconds", async () => {
    mockFetch.mockResolvedValueOnce(pending(["build"])).mockResolvedValueOnce(done);
    const sendProgress = vi.fn();
    const promise = waitForCIChecks("t", "o/r", "sha", 1, sendProgress);
    await vi.advanceTimersByTimeAsync(20000);
    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.waitTimeSeconds).toBe(20);
    expect(sendProgress).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("times out after the maximum wait", async () => {
    mockFetch.mockResolvedValue(pending(["build", "lint"]));
    const promise = waitForCIChecks("t", "o/r", "sha", 1, vi.fn());
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1000);
    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.success).toBe(false);
    expect(result.hasInProgress).toBe(true);
    expect(result.inProgressChecks).toEqual(["build", "lint"]);
    expect(result.waitTimeSeconds).toBe(1800);
  });

  it("stops waiting when the abort signal fires", async () => {
    mockFetch.mockResolvedValue(pending(["build"]));
    const controller = new AbortController();
    const promise = waitForCIChecks("t", "o/r", "sha", 1, vi.fn(), controller.signal);
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(20000);
    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.inProgressChecks).toEqual(["build"]);
  });

  it("proceeds when fetching CI status fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("boom"));
    const result = await waitForCIChecks("t", "o/r", "sha", 1, vi.fn());
    expect(result.success).toBe(true);
    expect(result.hasInProgress).toBe(false);
  });
});

describe("performCIWaitCheck", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns true when CI is complete", async () => {
    mockFetch.mockResolvedValueOnce({ head: { sha: "abc" } }).mockResolvedValueOnce(done);
    const ok = await performCIWaitCheck({ token: "t", repo: "o/r" }, 5, vi.fn(), "review");
    expect(ok).toBe(true);
  });

  it("returns false when already aborted", async () => {
    mockFetch.mockResolvedValueOnce({ head: { sha: "abc" } });
    const controller = new AbortController();
    controller.abort();
    const ok = await performCIWaitCheck({ token: "t", repo: "o/r" }, 5, vi.fn(), "review", controller.signal);
    expect(ok).toBe(false);
  });

  it("returns true when fetching the PR fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("nope"));
    const ok = await performCIWaitCheck({ token: "t", repo: "o/r" }, 5, vi.fn(), "review");
    expect(ok).toBe(true);
  });
});
