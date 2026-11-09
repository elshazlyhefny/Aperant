import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { IPC_CHANNELS } from "../../../../../shared/constants";
import type { Project } from "../../../../../shared/types";
import {
  PRLogCollector,
  addLogEntry,
  createEmptyPRLogs,
  getPRLogsPath,
  getPhaseFromSource,
  loadPRLogs,
  parseLogLine,
  savePRLogs,
  type PRLogEntry,
} from "../review-logs";

describe("parseLogLine", () => {
  it("parses a known [Source] message line", () => {
    expect(parseLogLine("[Context] Fetching PR data")).toEqual({
      source: "Context",
      content: "Fetching PR data",
      isError: false,
    });
  });

  it("parses Agent: and Specialist: sources", () => {
    expect(parseLogLine("[Agent:security-reviewer] scanning")).toEqual({
      source: "Agent:security-reviewer",
      content: "scanning",
      isError: false,
    });
    expect(parseLogLine("[Specialist:logic] done")?.source).toBe("Specialist:logic");
  });

  it("detects errors from [ERROR x] lines and not from [DEBUG x]", () => {
    expect(parseLogLine("[ERROR Foo] boom")).toEqual({
      source: "Foo",
      content: "boom",
      isError: true,
    });
    expect(parseLogLine("[DEBUG Foo] hi")?.isError).toBe(false);
  });

  it("skips debug message-type noise", () => {
    expect(parseLogLine("[DEBUG Foo] Message #3: AssistantMessage")).toBeNull();
  });

  it("parses progress lines", () => {
    expect(parseLogLine("[PR #12] [ 50%] halfway")).toEqual({
      source: "Progress",
      content: "[50%] halfway",
      isError: false,
    });
    expect(parseLogLine("[75%] almost")?.content).toBe("[75%] almost");
  });

  it("falls back to generic bracket and summary patterns", () => {
    expect(parseLogLine("[quick_scan] running")?.source).toBe("quick_scan");
    expect(parseLogLine("Status: ok")?.source).toBe("Summary");
    expect(parseLogLine("## Heading")?.source).toBe("Summary");
  });

  it("returns null for blank and unrecognised lines", () => {
    expect(parseLogLine("")).toBeNull();
    expect(parseLogLine("   ")).toBeNull();
    expect(parseLogLine("just some plain text")).toBeNull();
  });
});

describe("getPhaseFromSource", () => {
  it("maps sources to phases", () => {
    expect(getPhaseFromSource("Context")).toBe("context");
    expect(getPhaseFromSource("Followup")).toBe("context");
    expect(getPhaseFromSource("AI")).toBe("analysis");
    expect(getPhaseFromSource("Agent:x")).toBe("analysis");
    expect(getPhaseFromSource("Specialist:y")).toBe("analysis");
    expect(getPhaseFromSource("Summary")).toBe("synthesis");
    expect(getPhaseFromSource("SomethingUnknown")).toBe("synthesis");
  });
});

describe("createEmptyPRLogs", () => {
  it("creates three pending empty phases", () => {
    const logs = createEmptyPRLogs(7, "o/r", true);
    expect(logs.pr_number).toBe(7);
    expect(logs.repo).toBe("o/r");
    expect(logs.is_followup).toBe(true);
    expect(logs.created_at).toBe(logs.updated_at);
    for (const p of ["context", "analysis", "synthesis"] as const) {
      expect(logs.phases[p]).toEqual({
        phase: p,
        status: "pending",
        started_at: null,
        completed_at: null,
        entries: [],
      });
    }
  });
});

describe("addLogEntry", () => {
  const entry = (phase: PRLogEntry["phase"], ts: string): PRLogEntry => ({
    timestamp: ts,
    type: "text",
    content: "c",
    phase,
  });

  it("activates a pending phase and returns true, then false", () => {
    const logs = createEmptyPRLogs(1, "o/r", false);
    expect(addLogEntry(logs, entry("analysis", "t1"))).toBe(true);
    expect(logs.phases.analysis.status).toBe("active");
    expect(logs.phases.analysis.started_at).toBe("t1");
    expect(addLogEntry(logs, entry("analysis", "t2"))).toBe(false);
    expect(logs.phases.analysis.started_at).toBe("t1");
    expect(logs.phases.analysis.entries).toHaveLength(2);
    expect(logs.phases.context.status).toBe("pending");
  });
});

describe("load/save and PRLogCollector", () => {
  let dir: string;
  let project: Project;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-logs-"));
    project = { id: "proj-1", path: dir } as unknown as Project;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("builds the logs path under .auto-claude/github/pr", () => {
    expect(getPRLogsPath(project, 5)).toBe(
      path.join(dir, ".auto-claude", "github", "pr", "logs_5.json")
    );
  });

  it("returns null when the logs file is missing", () => {
    expect(loadPRLogs(project, 99)).toBeNull();
  });

  it("round-trips logs through save and load", () => {
    const logs = createEmptyPRLogs(3, "o/r", false);
    addLogEntry(logs, { timestamp: "t", type: "text", content: "hi", phase: "context" });
    savePRLogs(project, logs);
    const loaded = loadPRLogs(project, 3);
    expect(loaded).toEqual(logs);
    expect(loaded?.phases.context.entries[0].content).toBe("hi");
  });

  it("collector processes lines, notifies the window and persists on finalize", () => {
    const send = vi.fn();
    const win = { isDestroyed: () => false, webContents: { send } };
    const collector = new PRLogCollector(project, 4, "o/r", false, win as never);

    collector.processLine("[Context] gathering");
    collector.processLine("not a log line");
    collector.processLine("[AI] thinking");
    collector.processLine("[Summary] done");
    collector.finalize(true);

    expect(send).toHaveBeenCalled();
    const [channel, projectId, payload] = send.mock.calls[send.mock.calls.length - 1];
    expect(channel).toBe(IPC_CHANNELS.GITHUB_PR_LOGS_UPDATED);
    expect(projectId).toBe("proj-1");
    expect(payload.prNumber).toBe(4);
    expect(payload.entryCount).toBe(3);

    const saved = loadPRLogs(project, 4);
    expect(saved?.phases.context.status).toBe("completed");
    expect(saved?.phases.analysis.status).toBe("completed");
    expect(saved?.phases.synthesis.status).toBe("completed");
    expect(saved?.phases.context.entries[0].content).toBe("gathering");
    expect(saved?.phases.analysis.entries[0].source).toBe("AI");
  });

  it("collector works without a window and marks failure", () => {
    const collector = new PRLogCollector(project, 6, "o/r", true);
    collector.processLine("[Context] x");
    collector.finalize(false);
    const saved = loadPRLogs(project, 6);
    expect(saved?.is_followup).toBe(true);
    expect(saved?.phases.context.status).toBe("failed");
    expect(saved?.phases.analysis.status).toBe("pending");
  });
});
