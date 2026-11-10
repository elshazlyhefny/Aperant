import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runHeadlessTask = vi.hoisted(() => vi.fn());
vi.mock('../run-task', () => ({ runHeadlessTask }));

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
  beforeEach(() => runHeadlessTask.mockReset().mockResolvedValue(0));

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
