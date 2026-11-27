import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const runHeadlessTask = vi.hoisted(() => vi.fn());
vi.mock('../run-task', () => ({ runHeadlessTask }));

const runServe = vi.hoisted(() => vi.fn());

const createHeadlessSpec = vi.hoisted(() => vi.fn());
vi.mock('../new-spec', () => ({ createHeadlessSpec }));

import { createDeliveryReceiptRecorder } from '../../delivery-receipts';
import { acquireProjectQueueLock } from '../../utils/project-queue-lock';
import { runCli } from '../cli';
import type { PreflightReport } from '../preflight';

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

  describe('check', () => {
    const report = (ok: boolean): PreflightReport => ({
      version: 1,
      ok,
      mode: 'run',
      project: '/p',
      spec: null,
      checks: [
        ok
          ? { code: 'git.repository', status: 'valid', blocking: false, message: 'Git repository at /p' }
          : { code: 'git.repository', status: 'unavailable', blocking: true, message: 'not a repo', guidance: 'pass --project' },
      ],
    });
    const runPreflight = vi.fn();

    beforeEach(() => {
      runPreflight.mockReset().mockResolvedValue(report(true));
    });

    function expectNothingRan() {
      expect(runHeadlessTask).not.toHaveBeenCalled();
      expect(runServe).not.toHaveBeenCalled();
      expect(createHeadlessSpec).not.toHaveBeenCalled();
    }

    it('passes the flags to runPreflight and exits by ok', async () => {
      for (const ok of [true, false]) {
        runPreflight.mockReset().mockResolvedValue(report(ok));
        const h = harness();
        const code = await runCli(
          ['check', '001-x', '--project', '/p', '--config', 'c.json', '--base-branch', 'dev', '--daemon'],
          { ...h.deps, runPreflight, runServe },
        );
        expect(code).toBe(ok ? 0 : 1);
        expect(runPreflight).toHaveBeenCalledWith({
          projectPath: '/p', spec: '001-x', configPath: 'c.json', baseBranch: 'dev', daemon: true,
        });
        expect(h.out.join('')).toContain(ok ? 'READY' : 'NOT READY');
        expect(h.err).toEqual([]);
      }
      expectNothingRan();
    });

    it('runs without a spec', async () => {
      const h = harness();
      expect(await runCli(['check'], { ...h.deps, runPreflight })).toBe(0);
      expect(runPreflight).toHaveBeenCalledWith(expect.objectContaining({ spec: undefined }));
      expectNothingRan();
    });

    it('--json prints exactly one parseable line', async () => {
      for (const ok of [true, false]) {
        runPreflight.mockReset().mockResolvedValue(report(ok));
        const h = harness();
        expect(await runCli(['check', '--json'], { ...h.deps, runPreflight })).toBe(ok ? 0 : 1);
        const output = h.out.join('');
        expect(output.endsWith('\n')).toBe(true);
        expect(output.trimEnd().split('\n')).toHaveLength(1);
        expect(JSON.parse(output)).toEqual(report(ok));
      }
      expectNothingRan();
    });

    it('rejects extra arguments, --run and --queue with exit 1 and usage', async () => {
      for (const [argv, message] of [
        [['check', 'a', 'b'], 'Too many arguments'],
        [['check', '--run'], '--run only applies'],
        [['check', 'a', '--queue'], '--queue only applies'],
      ] as const) {
        const h = harness();
        expect(await runCli([...argv], { ...h.deps, runPreflight, runServe })).toBe(1);
        expect(h.err.join('')).toContain(message);
        expect(h.err.join('')).toContain('Usage:');
      }
      expect(runPreflight).not.toHaveBeenCalled();
      expectNothingRan();
    });

    it('rejects --daemon on every other command', async () => {
      for (const argv of [['run', 'x', '--daemon'], ['serve', '--daemon'], ['new', 'x', '--daemon'], ['list', '--daemon']]) {
        const h = harness();
        expect(await runCli(argv, { ...h.deps, runPreflight, runServe })).toBe(1);
        expect(h.err.join('')).toContain('--daemon only applies to the check command');
        expect(h.err.join('')).toContain('Usage:');
      }
      expect(runPreflight).not.toHaveBeenCalled();
      expectNothingRan();
    });

    it('exits 1 with the message when runPreflight throws', async () => {
      runPreflight.mockReset().mockRejectedValue(new Error('boom'));
      const h = harness();
      expect(await runCli(['check'], { ...h.deps, runPreflight })).toBe(1);
      expect(h.err.join('')).toBe('boom\n');
      expectNothingRan();
    });

    it('documents check and --daemon in the usage text', async () => {
      const h = harness();
      await runCli(['help'], h.deps);
      const text = h.out.join('');
      expect(text).toContain('check [<spec>]');
      expect(text).toContain('--daemon');
    });
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

  describe('list and queue', () => {
    const roots: string[] = [];
    function makeProject(specs: Record<string, string | null> = {}): string {
      const root = mkdtempSync(path.join(tmpdir(), 'cli-list-'));
      roots.push(root);
      execFileSync('git', ['init', '-q'], { cwd: root });
      for (const [id, status] of Object.entries(specs)) {
        const dir = path.join(root, '.auto-claude', 'specs', id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'spec.md'), `# ${id} title\n`);
        if (status) {
          writeFileSync(
            path.join(dir, 'implementation_plan.json'),
            JSON.stringify({ feature: `${id} title`, status, planStatus: 'pending', phases: [] }),
          );
        }
      }
      return root;
    }
    const planStatus = (root: string, id: string) =>
      JSON.parse(readFileSync(path.join(root, '.auto-claude', 'specs', id, 'implementation_plan.json'), 'utf-8')).status;

    afterAll(() => {
      for (const r of roots) rmSync(r, { recursive: true, force: true });
    });

    it('list prints one line per task and nothing for an empty project', async () => {
      const root = makeProject({ '002-b': 'backlog', '001-a': 'queue' });
      const h = harness();
      expect(await runCli(['list', '--project', root], h.deps)).toBe(0);
      const lines = h.out.join('').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^001-a\s+queue\s+/);
      expect(lines[1]).toMatch(/^002-b\s+backlog\s+/);
      const empty = harness();
      expect(await runCli(['list', '--project', makeProject()], empty.deps)).toBe(0);
      expect(empty.out.join('')).toBe('');
    });

    it('list --json prints a parseable array', async () => {
      const root = makeProject({ '001-a': 'backlog' });
      const h = harness();
      expect(await runCli(['list', '--json', '--project', root], h.deps)).toBe(0);
      const parsed = JSON.parse(h.out.join(''));
      expect(parsed).toEqual([expect.objectContaining({ specId: '001-a', status: 'backlog', title: expect.any(String) })]);
      const empty = harness();
      await runCli(['list', '--json', '--project', makeProject()], empty.deps);
      expect(empty.out.join('')).toBe('[]\n');
    });

    it('queue moves a backlog task to queue, also by unique prefix', async () => {
      const root = makeProject({ '001-a': 'backlog', '002-b': 'backlog' });
      const h = harness();
      expect(await runCli(['queue', '001-a', '--project', root], h.deps)).toBe(0);
      expect(h.out.join('')).toContain('Queued 001-a');
      expect(planStatus(root, '001-a')).toBe('queue');
      const p = harness();
      expect(await runCli(['queue', '002', '--json', '--project', root], p.deps)).toBe(0);
      expect(JSON.parse(p.out.join(''))).toEqual({ specId: '002-b', status: 'queue' });
      expect(planStatus(root, '002-b')).toBe('queue');
    });

    it('queue refuses in_progress, queued and unknown specs and leaves files untouched', async () => {
      const root = makeProject({ '001-a': 'in_progress', '002-b': 'queue' });
      for (const spec of ['001-a', '002-b', '999-zzz']) {
        const h = harness();
        expect(await runCli(['queue', spec, '--project', root], h.deps)).toBe(1);
        expect(h.err.join('')).not.toBe('');
      }
      expect(planStatus(root, '001-a')).toBe('in_progress');
      expect(planStatus(root, '002-b')).toBe('queue');
    });

    it('rejects bad list and queue arguments', async () => {
      const root = makeProject();
      for (const argv of [['queue'], ['queue', 'a', 'b'], ['list', 'x'], ['list', '--run'], ['queue', 'a', '--run'], ['list', '--queue']]) {
        const h = harness();
        expect(await runCli([...argv, '--project', root], h.deps)).toBe(1);
        expect(h.err.join('')).toContain('Usage:');
      }
    });

    it('new --queue creates the spec with a summary, queues it and does not run the build', async () => {
      const root = makeProject({ '007-new': null });
      const h = harness();
      expect(await runCli(['new', 'x', '--queue', '--project', root], h.deps)).toBe(0);
      expect(createHeadlessSpec).toHaveBeenCalledWith(expect.objectContaining({ summary: true }));
      expect(runHeadlessTask).not.toHaveBeenCalled();
      expect(planStatus(root, '007-new')).toBe('queue');
    });

    it('new --queue --run is rejected and new --queue skips queueing when creation fails', async () => {
      const root = makeProject({ '007-new': null });
      const h = harness();
      expect(await runCli(['new', 'x', '--queue', '--run', '--project', root], h.deps)).toBe(1);
      expect(h.err.join('')).toContain('Usage:');
      expect(createHeadlessSpec).not.toHaveBeenCalled();
      createHeadlessSpec.mockResolvedValue({ exitCode: 1 });
      expect(await runCli(['new', 'x', '--queue', '--project', root], harness().deps)).toBe(1);
      expect(existsSync(path.join(root, '.auto-claude', 'specs', '007-new', 'implementation_plan.json'))).toBe(false);
    });

    describe('receipts', () => {
      it('reads only the resolved task and never sends, loads config or starts a worker', async () => {
        const root = makeProject({ '001-a': 'human_review', '002-b': 'backlog' });
        const recorder = createDeliveryReceiptRecorder(root, '001-a');
        const send = vi.fn(async () => ({ status: 'delivered' as const }));
        await recorder.track({ operation: 'webhook', event: 'review_ready' }, send);
        const filename = path.join(root, '.auto-claude', 'delivery-receipts.json');
        const before = readFileSync(filename, 'utf8');
        const h = harness();
        expect(await runCli(['receipts', '001', '--project', root, '--json', '--config', '/missing'], h.deps)).toBe(0);
        expect(JSON.parse(h.out.join(''))).toEqual({ type: 'delivery-receipts', spec: '001-a', receipts: recorder.snapshot() });
        const empty = harness();
        expect(await runCli(['receipts', '002-b', '--project', root], empty.deps)).toBe(0);
        expect(empty.out.join('')).toContain('No delivery history');
        expect(readFileSync(filename, 'utf8')).toBe(before);
        expect(send).toHaveBeenCalledOnce();
        expect(runHeadlessTask).not.toHaveBeenCalled();
      });

      it('prefers exact history over a different task with the same prefix', async () => {
        const root = makeProject({ '001-a-other': 'backlog' });
        const recorder = createDeliveryReceiptRecorder(root, '001-a');
        await recorder.skip({ operation: 'webhook', event: 'failed' }, 'invalid_target');
        const h = harness();
        expect(await runCli(['receipts', '001-a', '--project', root, '--json'], h.deps)).toBe(0);
        expect(JSON.parse(h.out.join(''))).toEqual({ type: 'delivery-receipts', spec: '001-a', receipts: recorder.snapshot() });
      });

      it('rejects unknown and invalid IDs rather than returning another task’s history', async () => {
        const root = makeProject({ '001-a': 'backlog' });
        for (const [spec, message] of [
          ['002-missing', 'Task not found: 002-missing\n'],
          ['../001-a', 'Invalid spec ID for delivery history\n'],
        ]) {
          const h = harness();
          expect(await runCli(['receipts', spec, '--project', root], h.deps)).toBe(1);
          expect(h.out).toEqual([]);
          expect(h.err).toEqual([message]);
        }
      });

      it('reports unreadable history without reflecting file contents', async () => {
        const root = makeProject({ '001-a': 'backlog' });
        writeFileSync(path.join(root, '.auto-claude', 'delivery-receipts.json'), 'private body');
        const h = harness();
        expect(await runCli(['receipts', '001', '--project', root], h.deps)).toBe(1);
        expect(h.out).toEqual([]);
        expect(h.err).toEqual(['Could not read delivery history\n']);
      });
    });

    describe('stop', () => {
      const locksDir = (root: string) => path.join(root, '.auto-claude', '.locks');
      const stopFiles = (root: string) =>
        existsSync(locksDir(root)) ? readdirSync(locksDir(root)).filter((f) => f.startsWith('stop-request-')) : [];

      async function withDaemon(root: string, kind: 'daemon' | 'desktop', fn: () => Promise<void>): Promise<void> {
        const lock = acquireProjectQueueLock(root, kind);
        if (!lock.ok) throw new Error('lock not acquired');
        try {
          await fn();
        } finally {
          lock.lock.release();
        }
      }

      it('writes one stop request for a running task, also by prefix', async () => {
        const root = makeProject({ '001-a': 'in_progress' });
        await withDaemon(root, 'daemon', async () => {
          const h = harness();
          expect(await runCli(['stop', '001-a', '--project', root], h.deps)).toBe(0);
          expect(h.out.join('')).toBe('Requested stop of 001-a\n');
          expect(stopFiles(root)).toHaveLength(1);
          const file = path.join(locksDir(root), stopFiles(root)[0]);
          expect(JSON.parse(readFileSync(file, 'utf-8'))).toMatchObject({ specId: '001-a', requeue: false });
          const p = harness();
          expect(await runCli(['stop', '001', '--project', root], p.deps)).toBe(0);
          expect(p.out.join('')).toContain('Requested stop of 001-a');
        });
      });

      it('--requeue writes requeue true and --json prints a result object', async () => {
        const root = makeProject({ '001-a': 'in_progress' });
        await withDaemon(root, 'daemon', async () => {
          const h = harness();
          expect(await runCli(['stop', '001-a', '--requeue', '--project', root], h.deps)).toBe(0);
          expect(h.out.join('')).toContain('it will be requeued');
          const file = path.join(locksDir(root), stopFiles(root)[0]);
          expect(JSON.parse(readFileSync(file, 'utf-8')).requeue).toBe(true);
          const j = harness();
          expect(await runCli(['stop', '001-a', '--json', '--project', root], j.deps)).toBe(0);
          expect(JSON.parse(j.out.join(''))).toEqual({ specId: '001-a', requeue: false, requested: true });
        });
      });

      it('fails without a serve daemon and writes nothing', async () => {
        const root = makeProject({ '001-a': 'in_progress' });
        const h = harness();
        expect(await runCli(['stop', '001-a', '--project', root], h.deps)).toBe(1);
        expect(h.err.join('')).toContain('No serve daemon');
        expect(stopFiles(root)).toHaveLength(0);
      });

      it('fails when the desktop holds the lock', async () => {
        const root = makeProject({ '001-a': 'in_progress' });
        await withDaemon(root, 'desktop', async () => {
          const h = harness();
          expect(await runCli(['stop', '001-a', '--project', root], h.deps)).toBe(1);
          expect(h.err.join('')).not.toBe('');
          expect(stopFiles(root)).toHaveLength(0);
        });
      });

      it('refuses unknown and non-running specs and writes nothing', async () => {
        const root = makeProject({ '001-a': 'queue', '002-b': 'backlog' });
        await withDaemon(root, 'daemon', async () => {
          for (const spec of ['999-zzz', '001-a', '002-b']) {
            const h = harness();
            expect(await runCli(['stop', spec, '--project', root], h.deps)).toBe(1);
            expect(h.err.join('')).not.toBe('');
          }
          const h = harness();
          await runCli(['stop', '001-a', '--project', root], h.deps);
          expect(h.err.join('')).toContain('only running tasks can be stopped');
          expect(stopFiles(root)).toHaveLength(0);
        });
      });

      it('rejects bad stop arguments and documents stop and --requeue', async () => {
        const root = makeProject();
        for (const argv of [
          ['stop'],
          ['stop', 'a', 'b'],
          ['stop', 'a', '--run'],
          ['stop', 'a', '--queue'],
          ['queue', 'a', '--requeue'],
          ['list', '--requeue'],
        ]) {
          const h = harness();
          expect(await runCli([...argv, '--project', root], h.deps)).toBe(1);
          expect(h.err.join('')).toContain('Usage:');
        }
        const h = harness();
        await runCli(['help'], h.deps);
        expect(h.out.join('')).toContain('stop <spec>');
        expect(h.out.join('')).toContain('--requeue');
      });
    });

    it('rejects --queue on run and serve and documents list, queue and --queue', async () => {
      for (const argv of [['run', '001-x', '--queue'], ['serve', '--queue']]) {
        const h = harness();
        expect(await runCli(argv, { ...h.deps, runServe })).toBe(1);
        expect(h.err.join('')).toContain('Usage:');
      }
      expect(runHeadlessTask).not.toHaveBeenCalled();
      const h = harness();
      await runCli(['help'], h.deps);
      const text = h.out.join('');
      expect(text).toContain('list');
      expect(text).toContain('queue <spec>');
      expect(text).toContain('--queue');
    });
  });
});
