import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const mockCreateWorktree = vi.fn();
const mockResolveAuth = vi.fn();

vi.mock('../../ai/worktree/worktree-manager', () => ({
  createOrGetWorktree: (...args: unknown[]) => mockCreateWorktree(...args),
}));
vi.mock('../auth', () => ({
  resolveHeadlessAuth: (...args: unknown[]) => mockResolveAuth(...args),
}));
vi.mock('../../ai/prompts/prompt-loader', () => ({
  tryLoadPrompt: () => 'PLANNER PROMPT',
}));

import { runHeadlessTask } from '../run-task';
import type { HeadlessBridge } from '../run-task';

const SECRET = 'sk-ant-super-secret-key';

class FakeBridge extends EventEmitter implements HeadlessBridge {
  spawn = vi.fn();
  terminate = vi.fn().mockResolvedValue(undefined);
}

let projectDir: string;
let out: string[];
let err: string[];
let bridge: FakeBridge;

function makeSpec(id = '001-demo'): string {
  const dir = path.join(projectDir, '.auto-claude', 'specs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'spec.md'), '# Demo\n');
  return dir;
}

function run(overrides: Partial<Parameters<typeof runHeadlessTask>[0]> = {}) {
  return runHeadlessTask({
    projectPath: projectDir,
    spec: '001-demo',
    workerPath: '/fake/worker.js',
    createBridge: () => bridge,
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    ...overrides,
  });
}

/** Make spawn() drive the bridge with the given events, then exit. */
function script(events: Array<Record<string, unknown>>, code = 0) {
  bridge.spawn.mockImplementation(() => {
    setImmediate(() => {
      for (const e of events) bridge.emit('task-event', '001-demo', e);
      bridge.emit('exit', '001-demo', code, 'task-execution');
    });
  });
}

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'headless-run-')));
  execFileSync('git', ['init', '-q'], { cwd: projectDir });
  out = [];
  err = [];
  bridge = new FakeBridge();
  mockCreateWorktree.mockReset();
  mockResolveAuth.mockReset();
  mockCreateWorktree.mockImplementation(async () => {
    const worktreePath = path.join(projectDir, '.auto-claude/worktrees/tasks/001-demo');
    return { worktreePath, branch: 'auto-claude/001-demo' };
  });
  mockResolveAuth.mockResolvedValue({
    auth: { apiKey: SECRET },
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5',
  });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('runHeadlessTask', () => {
  it('returns 0 on QA_PASSED and prints worktree and branch', async () => {
    makeSpec();
    script([{ type: 'QA_PASSED' }]);
    expect(await run()).toBe(0);
    const text = out.join('');
    expect(text).toContain('branch=auto-claude/001-demo');
    expect(text).toContain('worktree=');
    expect(mockCreateWorktree).toHaveBeenCalledOnce();
    const config = bridge.spawn.mock.calls[0][0];
    expect(config.session.agentType).toBe('build_orchestrator');
    expect(config.session.maxSteps).toBe(1000);
    expect(config.session.systemPrompt).toBe('PLANNER PROMPT');
    expect(config.session.toolContext.securityProfile.prOnlyLanding).toBe(true);
    expect(config.session.sourceSpecDir).toBe(path.join(projectDir, '.auto-claude/specs/001-demo'));
  });

  it('returns 2 on QA_MAX_ITERATIONS', async () => {
    makeSpec();
    script([{ type: 'QA_MAX_ITERATIONS' }]);
    expect(await run()).toBe(2);
  });

  it('returns 1 when planning failed', async () => {
    makeSpec();
    script([{ type: 'PLANNING_FAILED', error: 'no plan' }]);
    expect(await run()).toBe(1);
  });

  it('returns 1 when spawn throws', async () => {
    makeSpec();
    bridge.spawn.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(await run()).toBe(1);
  });

  it('returns 1 for a missing spec and creates no worktree', async () => {
    expect(await run()).toBe(1);
    expect(mockCreateWorktree).not.toHaveBeenCalled();
    expect(err.join('')).toContain('Spec not found');
  });

  it('returns 1 without credentials and creates no worktree', async () => {
    makeSpec();
    mockResolveAuth.mockRejectedValue(new Error('No credentials found.'));
    expect(await run()).toBe(1);
    expect(mockCreateWorktree).not.toHaveBeenCalled();
    expect(bridge.spawn).not.toHaveBeenCalled();
  });

  it('fails when the worktree cannot be created, with no fallback', async () => {
    makeSpec();
    mockCreateWorktree.mockRejectedValue(new Error('git exploded'));
    expect(await run()).toBe(1);
    expect(bridge.spawn).not.toHaveBeenCalled();
    expect(err.join('')).toContain("Could not create the task's git worktree");
  });

  it('fails outside a git repository', async () => {
    const plain = realpathSync(mkdtempSync(path.join(tmpdir(), 'headless-nogit-')));
    try {
      expect(await run({ projectPath: plain })).toBe(1);
      expect(mockCreateWorktree).not.toHaveBeenCalled();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('terminates the bridge on a signal and exits 1', async () => {
    makeSpec();
    bridge.spawn.mockImplementation(() => {
      setImmediate(() => process.emit('SIGTERM'));
    });
    const before = process.listenerCount('SIGTERM');
    expect(await run()).toBe(1);
    expect(bridge.terminate).toHaveBeenCalledOnce();
    expect(err.join('')).toContain('aborted by SIGTERM');
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('never writes the api key to out or err', async () => {
    makeSpec();
    bridge.spawn.mockImplementation(() => {
      setImmediate(() => {
        bridge.emit('log', '001-demo', `using key ${SECRET}`);
        bridge.emit('error', '001-demo', `bad key ${SECRET}`);
        bridge.emit('task-event', '001-demo', { type: 'PLANNING_FAILED', error: `key ${SECRET}` });
        bridge.emit('exit', '001-demo', 1, 'task-execution');
      });
    });
    await run({ json: true, verbose: true });
    expect(out.join('')).not.toContain(SECRET);
    expect(err.join('')).not.toContain(SECRET);
  });
});

describe('runHeadlessTask outcome webhook', () => {
  const HOOK = 'https://hooks.example.com/services/T000/B000/SECRETTOKEN';
  const PR = 'https://github.com/o/r/pull/7';
  let fetchMock: ReturnType<typeof vi.fn>;

  function configWith(webhook: Record<string, unknown> | undefined): string {
    const file = path.join(projectDir, 'headless-config.json');
    writeFileSync(file, JSON.stringify(webhook ? { webhook } : {}));
    return file;
  }

  const runHook = (overrides: Partial<Parameters<typeof runHeadlessTask>[0]> = {}) =>
    run({
      webhookDelay: async () => undefined,
      ...overrides,
      configPath: overrides.configPath ?? configWith({ url: HOOK }),
    });

  const bodies = (): Array<{ text: string; blocks: unknown[] }> =>
    fetchMock.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body));
  /** The link of every "View PR" button in a posted body (exact values, not substring matches). */
  const prLinks = (body: { blocks: unknown[] }): string[] =>
    (body.blocks as Array<{ type?: string; elements?: Array<{ url?: string }> }>)
      .filter((block) => block.type === 'actions')
      .flatMap((block) => (block.elements ?? []).map((element) => element.url ?? ''));

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('APERANT_WEBHOOK_URL', '');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('posts review_ready on success', async () => {
    makeSpec();
    script([{ type: 'QA_PASSED' }]);
    expect(await runHook()).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(HOOK);
    const [body] = bodies();
    expect(body.text).toContain('Demo');
    expect(body.text).toContain(path.basename(projectDir));
    expect(JSON.stringify(body.blocks)).toContain('Demo');
  });

  it('posts blocked and keeps exit code 2 on QA_MAX_ITERATIONS', async () => {
    makeSpec();
    script([{ type: 'QA_MAX_ITERATIONS' }]);
    expect(await runHook()).toBe(2);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(bodies()[0].text.toLowerCase()).toContain('blocked');
  });

  it('posts failed and keeps exit code 1 on an error run', async () => {
    makeSpec();
    script([{ type: 'PLANNING_FAILED', error: 'no plan' }]);
    expect(await runHook()).toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(bodies()[0].text.toLowerCase()).toContain('fail');
  });

  it('posts failed for a setup failure after the config loaded', async () => {
    makeSpec();
    mockResolveAuth.mockRejectedValue(new Error('No credentials found.'));
    expect(await runHook()).toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(bodies()[0].text.toLowerCase()).toContain('fail');
  });

  it('sends nothing when the config itself cannot be loaded', async () => {
    makeSpec();
    expect(await runHook({ configPath: path.join(projectDir, 'missing.json') })).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts pr_opened with the https link when events.prOpened is true', async () => {
    makeSpec();
    script([{ type: 'QA_PASSED', prUrl: PR }]);
    const config = configWith({ url: HOOK, events: { prOpened: true } });
    expect(await runHook({ configPath: config })).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [reviewReady, prOpened] = bodies();
    expect(prLinks(reviewReady)).toEqual([]);
    expect(prLinks(prOpened)).toEqual([PR]);
    expect(prOpened.text.split(' ').at(-1)).toBe(PR);
  });

  it('sends no pr_opened when events.prOpened is false', async () => {
    makeSpec();
    script([{ type: 'QA_PASSED', prUrl: PR }]);
    const config = configWith({ url: HOOK, events: { prOpened: false } });
    expect(await runHook({ configPath: config })).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [reviewReady] = bodies();
    expect(prLinks(reviewReady)).toEqual([]);
    expect(reviewReady.text.split(' ').at(-1)).not.toBe(PR);
  });

  it('keeps exit 0 and warns without the URL when the server returns 500', async () => {
    makeSpec();
    fetchMock.mockResolvedValue({ status: 500 });
    script([{ type: 'QA_PASSED' }]);
    expect(await runHook()).toBe(0);
    const text = err.join('');
    expect(text).toContain('warning:');
    expect(text).not.toContain('hooks.example.com');
    expect(text).not.toContain('SECRETTOKEN');
  });

  it('keeps exit 0 and warns without the URL when fetch throws', async () => {
    makeSpec();
    fetchMock.mockRejectedValue(new Error(`connect failed ${HOOK}`));
    script([{ type: 'QA_PASSED' }]);
    expect(await runHook()).toBe(0);
    const text = err.join('');
    expect(text).toContain('warning:');
    expect(text).not.toContain('SECRETTOKEN');
  });

  it('reads the URL from APERANT_WEBHOOK_URL', async () => {
    makeSpec();
    vi.stubEnv('APERANT_WEBHOOK_URL', 'https://env.example.com/hook');
    script([{ type: 'QA_PASSED' }]);
    expect(await runHook({ configPath: configWith(undefined) })).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('https://env.example.com/hook');
  });

  it('warns and sends nothing for an invalid http:// remote URL', async () => {
    makeSpec();
    script([{ type: 'QA_PASSED' }]);
    const config = configWith({ url: 'http://remote.example.com/hook' });
    expect(await runHook({ configPath: config })).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    const text = err.join('');
    expect(text).toContain('warning: webhook disabled');
    expect(text).not.toContain('remote.example.com');
  });

  it('never calls fetch when no webhook is configured', async () => {
    makeSpec();
    script([{ type: 'QA_PASSED' }]);
    expect(await run()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
