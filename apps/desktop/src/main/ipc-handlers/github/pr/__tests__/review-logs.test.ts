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
  getLiveLogs,
  getPhaseFromSource,
  loadPRLogs,
  loadPRLogsIfChanged,
  parseLogLine,
  savePRLogs,
  type PRLogEntry,
  type PRLogs,
  type PRLogPhase,
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

describe("PRLogCollector streaming, throttling and change detection", () => {
  let dir: string;
  let project: Project;
  const makeWin = () => {
    const send = vi.fn();
    return { send, win: { isDestroyed: () => false, webContents: { send } } };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-logs-stream-"));
    project = { id: "proj-stream", path: dir } as unknown as Project;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("throttles disk writes and writes compact JSON", () => {
    const collector = new PRLogCollector(project, 10, "o/r", false);
    const writeSpy = vi.spyOn(fs, "writeFileSync");
    const renameSpy = vi.spyOn(fs, "renameSync");

    for (let i = 0; i < 200; i++) collector.processLine(`[Context] line ${i}`);

    // First line activates the phase (immediate write); the rest are throttled
    expect(writeSpy.mock.calls.length).toBeLessThan(5);
    vi.advanceTimersByTime(1100);
    expect(writeSpy.mock.calls.length).toBeLessThan(10);
    expect(renameSpy.mock.calls.length).toBe(writeSpy.mock.calls.length);

    const raw = fs.readFileSync(getPRLogsPath(project, 10), "utf-8");
    expect(raw).not.toContain("\n");
    expect(raw).not.toContain('  "');
    collector.finalize(true);
  });

  it("pushes deltas with correct baseCount that reconstruct the memory state", () => {
    const { send, win } = makeWin();
    const collector = new PRLogCollector(project, 11, "o/r", false, win as never);

    const lines = [
      "[Context] a",
      "[Context] b",
      "[AI] c",
      "[AI] d",
      "[AI] e",
      "[Summary] f",
      "[Summary] g",
    ];
    for (const line of lines) {
      collector.processLine(line);
      vi.advanceTimersByTime(250);
    }
    collector.processLine("[Summary] h");
    collector.finalize(true);

    const rebuilt: Record<PRLogPhase, string[]> = { context: [], analysis: [], synthesis: [] };
    for (const call of send.mock.calls) {
      const delta = call[2].delta;
      for (const phase of Object.keys(delta.phases) as PRLogPhase[]) {
        const d = delta.phases[phase];
        expect(d.baseCount).toBe(rebuilt[phase].length);
        rebuilt[phase].push(...d.entries.map((e: PRLogEntry) => e.content));
      }
    }
    const mem = collector.getLogs();
    for (const phase of ["context", "analysis", "synthesis"] as const) {
      expect(rebuilt[phase]).toEqual(mem.phases[phase].entries.map((e) => e.content));
    }
    expect(rebuilt.synthesis).toEqual(["f", "g", "h"]);
  });

  it("flushes immediately on phase change", () => {
    const { send, win } = makeWin();
    const collector = new PRLogCollector(project, 12, "o/r", false, win as never);
    collector.processLine("[Context] a");
    const before = send.mock.calls.length;
    collector.processLine("[Context] b"); // throttled
    expect(send.mock.calls.length).toBe(before);

    collector.processLine("[AI] c"); // phase change -> immediate
    expect(send.mock.calls.length).toBeGreaterThan(before);
    const onDisk = loadPRLogs(project, 12);
    expect(onDisk?.phases.context.status).toBe("completed");
    expect(onDisk?.phases.analysis.entries).toHaveLength(1);
    collector.finalize(true);
  });

  it("finalize flushes pending entries to disk and reports the full entryCount", () => {
    const { send, win } = makeWin();
    const collector = new PRLogCollector(project, 13, "o/r", false, win as never);
    for (let i = 0; i < 50; i++) collector.processLine(`[Context] line ${i}`);
    collector.finalize(true);

    const onDisk = loadPRLogs(project, 13) as PRLogs;
    expect(onDisk).toEqual(collector.getLogs());
    expect(onDisk.phases.context.entries).toHaveLength(50);
    const payload = send.mock.calls[send.mock.calls.length - 1][2];
    expect(payload.entryCount).toBe(50);
  });

  it("loads logs larger than 1,000,000 characters", () => {
    const logs = createEmptyPRLogs(14, "o/r", false);
    const big = "x".repeat(10_000);
    for (let i = 0; i < 150; i++) {
      addLogEntry(logs, { timestamp: "t", type: "text", content: big, phase: "analysis" });
    }
    savePRLogs(project, logs);
    expect(JSON.stringify(logs).length).toBeGreaterThan(1_000_000);
    const loaded = loadPRLogs(project, 14);
    expect(loaded).not.toBeNull();
    expect(loaded?.phases.analysis.entries).toHaveLength(150);
  });

  it("loadPRLogsIfChanged uses live logs while a collector is running", () => {
    const collector = new PRLogCollector(project, 15, "o/r", false);
    collector.processLine("[Context] a");
    collector.processLine("[Context] b");
    const live = collector.getLogs();

    expect(
      loadPRLogsIfChanged(project, 15, { updated_at: live.updated_at, entryCount: 2 })
    ).toBe("unchanged");
    const changed = loadPRLogsIfChanged(project, 15, {
      updated_at: live.updated_at,
      entryCount: 1,
    });
    expect(changed).not.toBe("unchanged");
    expect((changed as PRLogs).phases.context.entries).toHaveLength(2);
    collector.finalize(true);
  });

  it("loadPRLogsIfChanged does not re-read an unchanged finished file", () => {
    const collector = new PRLogCollector(project, 16, "o/r", false);
    collector.processLine("[Context] a");
    collector.finalize(true);

    const first = loadPRLogsIfChanged(project, 16) as PRLogs;
    expect(first.phases.context.entries).toHaveLength(1);

    const readSpy = vi.spyOn(fs, "readFileSync");
    const second = loadPRLogsIfChanged(project, 16, {
      updated_at: first.updated_at,
      entryCount: 1,
    });
    expect(second).toBe("unchanged");
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("getLiveLogs returns collector logs during review and null after finalize", () => {
    const collector = new PRLogCollector(project, 17, "o/r", false);
    collector.processLine("[Context] a");
    expect(getLiveLogs(project, 17)).toBe(collector.getLogs());
    collector.finalize(true);
    expect(getLiveLogs(project, 17)).toBeNull();
  });
});
