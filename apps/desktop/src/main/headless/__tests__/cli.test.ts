import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runHeadlessTask = vi.hoisted(() => vi.fn());
vi.mock('../run-task', () => ({ runHeadlessTask }));

const runServe = vi.hoisted(() => vi.fn());

const createHeadlessSpec = vi.hoisted(() => vi.fn());
vi.mock('../new-spec', () => ({ createHeadlessSpec }));

import { runCli } from '../cli';

function harness() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t), workerPath: '/w/worker.js' },
  };
}

describe('headless cli', () => {
  beforeEach(() => {
    runHeadlessTask.mockReset().mockResolvedValue(0);
    runServe.mockReset().mockResolvedValue(0);
    createHeadlessSpec.mockReset().mockResolvedValue({ exitCode: 0, specId: '007-new' });
  });

  it('new creates a spec with a summary and does not run the build', async () => {
    const h = harness();
    const code = await runCli(
      ['new', 'x', '--project', '/p', '--config', 'c.json', '--json', '--verbose'],
      h.deps,
    );
    expect(code).toBe(0);
    expect(createHeadlessSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'x',
        projectPath: '/p',
        configPath: 'c.json',
        json: true,
        verbose: true,
        workerPath: '/w/worker.js',
        summary: true,
      }),
    );
    expect(runHeadlessTask).not.toHaveBeenCalled();
  });

  it('new --run creates the spec without a summary, then runs the build and returns its code', async () => {
    for (const buildCode of [0, 2]) {
      createHeadlessSpec.mockClear();
      runHeadlessTask.mockReset().mockResolvedValue(buildCode);
      const code = await runCli(['new', 'x', '--run', '--base-branch', 'dev', '--no-push'], harness().deps);
      expect(code).toBe(buildCode);
      expect(createHeadlessSpec).toHaveBeenCalledWith(expect.objectContaining({ summary: false }));
      expect(runHeadlessTask).toHaveBeenCalledWith(
        expect.objectContaining({ spec: '007-new', baseBranch: 'dev', noPush: true }),
      );
    }
  });

  it('new --run does not run the build when spec creation fails', async () => {
    createHeadlessSpec.mockResolvedValue({ exitCode: 1 });
    expect(await runCli(['new', 'x', '--run'], harness().deps)).toBe(1);
    expect(runHeadlessTask).not.toHaveBeenCalled();
  });

  it('rejects bad new and run arguments with exit 1 and usage', async () => {
    for (const argv of [['new'], ['new', 'a', 'b'], ['run', '001-x', '--run']]) {
      const h = harness();
      expect(await runCli(argv, h.deps)).toBe(1);
      expect(h.err.join('')).toContain('Usage:');
    }
    expect(createHeadlessSpec).not.toHaveBeenCalled();
    expect(runHeadlessTask).not.toHaveBeenCalled();
  });

  it('documents new and --run in the usage text', async () => {
    const h = harness();
    await runCli(['help'], h.deps);
    const text = h.out.join('');
    expect(text).toContain('new ');
    expect(text).toContain('--run');
  });

  it('prints usage and exits 0 for --help and help', async () => {
    for (const argv of [['--help'], ['help']]) {
      const h = harness();
      expect(await runCli(argv, h.deps)).toBe(0);
      expect(h.out.join('')).toContain('Usage:');
    }
    expect(runHeadlessTask).not.toHaveBeenCalled();
  });

  it('prints the version, falling back when it is unreadable', async () => {
    const h = harness();
    expect(await runCli(['--version'], { ...h.deps, readVersion: () => '1.2.3' })).toBe(0);
    expect(h.out.join('')).toBe('1.2.3\n');
  });

  it('rejects an unknown command, a missing spec and unknown flags with exit 1', async () => {
    for (const argv of [['bogus'], [], ['run'], ['run', 'a', 'b'], ['run', 'a', '--nope']]) {
      const h = harness();
      expect(await runCli(argv, h.deps)).toBe(1);
      expect(h.err.join('')).toContain('Usage:');
    }
    expect(runHeadlessTask).not.toHaveBeenCalled();
  });

  it('passes flags to runHeadlessTask and returns its exit code', async () => {
    runHeadlessTask.mockResolvedValue(2);
    const h = harness();
    const code = await runCli(
      ['run', '001-x', '--project', '/p', '--config', 'c.json', '--base-branch', 'main', '--no-push', '--json', '--verbose'],
      h.deps,
    );
    expect(code).toBe(2);
    expect(runHeadlessTask).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: '001-x',
        projectPath: '/p',
        configPath: 'c.json',
        baseBranch: 'main',
        noPush: true,
        json: true,
        verbose: true,
        workerPath: '/w/worker.js',
      }),
    );
  });

  it('dispatches serve with parsed options and returns its exit code', async () => {
    runServe.mockResolvedValue(3);
    const h = harness();
    const code = await runCli(
      ['serve', '--project', '/p', '--config', 'c.json', '--schedules', 's.json', '--project-id', 'pid',
        '--base-branch', 'main', '--no-push', '--shutdown-timeout', '5', '--json', '--verbose'],
      { ...h.deps, runServe },
    );
    expect(code).toBe(3);
    expect(runServe).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: '/p',
        configPath: 'c.json',
        schedulesPath: 's.json',
        projectId: 'pid',
        baseBranch: 'main',
        noPush: true,
        shutdownTimeoutMs: 5000,
        json: true,
        verbose: true,
        workerPath: '/w/worker.js',
      }),
    );
    expect(runHeadlessTask).not.toHaveBeenCalled();
  });

  it('rejects extra serve arguments and a bad shutdown timeout', async () => {
    for (const argv of [['serve', 'extra'], ['serve', '--shutdown-timeout', 'abc'], ['serve', '--run']]) {
      const h = harness();
      expect(await runCli(argv, { ...h.deps, runServe })).toBe(1);
      expect(h.err.join('')).toContain('Usage:');
    }
    expect(runServe).not.toHaveBeenCalled();
  });

  it('documents serve and its exit codes in the usage text', async () => {
    const h = harness();
    await runCli(['help'], h.deps);
    const text = h.out.join('');
    expect(text).toContain('serve');
    expect(text).toContain('--shutdown-timeout');
    expect(text).toContain('held by another process');
  });

  it('defaults the project to the current directory', async () => {
    await runCli(['run', '001-x'], harness().deps);
    expect(runHeadlessTask.mock.calls[0][0].projectPath).toBe(process.cwd());
  });

  it('finds the bundled prompts relative to out/main (plain node, no Electron)', () => {
    // resolvePromptsDir tries join(__dirname, '..', '..', 'prompts'); out/main/../../prompts = apps/desktop/prompts
    const outMain = path.resolve(__dirname, '../../../../out/main');
    expect(existsSync(path.join(outMain, '..', '..', 'prompts', 'planner.md'))).toBe(true);
  });
});
