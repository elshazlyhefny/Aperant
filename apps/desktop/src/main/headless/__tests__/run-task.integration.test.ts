/**
 * zeenha fork: headless run against a real git repo, a real worktree and the
 * real WorkerBridgeCore, with a stub worker script in place of the agent. The
 * stub never calls a model.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

vi.mock('../../ai/prompts/prompt-loader', () => ({
  tryLoadPrompt: () => 'PLANNER PROMPT',
}));

import { WorkerBridgeCore } from '../../ai/agent/worker-bridge-core';
import type { AgentExecutorConfig } from '../../ai/agent/types';
import { runHeadlessTask } from '../run-task';
import type { HeadlessBridge } from '../run-task';

const SECRET = 'sk-ant-fake-integration-key-0123456789';
const SPEC = '001-demo';

const header = `
import { parentPort, workerData } from 'node:worker_threads';
const taskId = workerData.taskId;
const post = (type, data) => parentPort.postMessage({ type, taskId, data });
`;
const result = `post('result', { outcome: 'completed', stepsExecuted: 1, toolCallCount: 0, durationMs: 1, usage: {} });`;

const STUBS = {
  pass: `${header}
post('execution-progress', { phase: 'coding', phaseProgress: 0, overallProgress: 0, message: 'working' });
post('task-event', { type: 'QA_PASSED' });
post('task-event', { type: 'BUILD_COMPLETE' });
${result}`,
  qaMax: `${header}
post('execution-progress', { phase: 'qa_review', phaseProgress: 0, overallProgress: 0, message: 'reviewing' });
post('task-event', { type: 'QA_MAX_ITERATIONS', extra: { iteration: 3 } });
${result}`,
  throws: `${header}
throw new Error('stub worker crashed');`,
};

let root: string;
let projectDir: string;
let out: string[];
let err: string[];
let spawned: AgentExecutorConfig[];

function writeStub(name: keyof typeof STUBS): string {
  const file = path.join(root, `${name}.mjs`);
  writeFileSync(file, STUBS[name]);
  return file;
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: projectDir, encoding: 'utf-8' }).trim();
}

function run(stub: keyof typeof STUBS) {
  const workerPath = writeStub(stub);
  return runHeadlessTask({
    projectPath: projectDir,
    spec: SPEC,
    workerPath,
    noPush: true,
    baseBranch: 'main',
    createBridge: (options) => {
      const bridge = new WorkerBridgeCore(options);
      const spawn = bridge.spawn.bind(bridge);
      bridge.spawn = (config) => {
        spawned.push(config);
        spawn(config);
      };
      return bridge as unknown as HeadlessBridge;
    },
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'headless-int-')));
  projectDir = path.join(root, 'project');
  mkdirSync(projectDir);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(projectDir, 'README.md'), '# fixture\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'init');
  const specDir = path.join(projectDir, '.auto-claude', 'specs', SPEC);
  mkdirSync(specDir, { recursive: true });
  writeFileSync(path.join(specDir, 'spec.md'), '# Demo\n');
  out = [];
  err = [];
  spawned = [];
  // Keep the developer's real Claude login out of the test: the resolver
  // prefers a stored profile token over the environment variable.
  const home = path.join(root, 'home');
  mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(home, '.claude'));
  vi.stubEnv('ANTHROPIC_API_KEY', SECRET);
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('runHeadlessTask with a stub worker', () => {
  it('exits 0 on QA_PASSED, creating the worktree and branch', async () => {
    expect(await run('pass')).toBe(0);
    const worktree = path.join(projectDir, '.auto-claude/worktrees/tasks', SPEC);
    expect(existsSync(worktree)).toBe(true);
    expect(git('-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`auto-claude/${SPEC}`);
    const stdout = out.join('');
    expect(stdout).toContain('[coding]');
    expect(stdout).toMatch(/RESULT success exit=0/);
    expect(stdout + err.join('')).not.toContain(SECRET);
  }, 30000);

  it('exits 2 on QA_MAX_ITERATIONS', async () => {
    expect(await run('qaMax')).toBe(2);
    expect(out.join('')).toMatch(/RESULT qa_failed exit=2/);
    expect(out.join('') + err.join('')).not.toContain(SECRET);
  }, 30000);

  it('exits 1 when the worker throws', async () => {
    expect(await run('throws')).toBe(1);
    expect(out.join('')).toMatch(/RESULT error exit=1/);
    expect(err.join('')).toContain('stub worker crashed');
    expect(out.join('') + err.join('')).not.toContain(SECRET);
  }, 30000);

  it('keeps security parity with the app: PR-only landing, only apiKey/baseURL credentials', async () => {
    await run('pass');
    expect(spawned).toHaveLength(1);
    const session = spawned[0].session;
    expect(session.toolContext.securityProfile?.prOnlyLanding).toBe(true);
    expect(session.apiKey).toBe(SECRET);
    const keys = Object.keys(session);
    expect(keys).not.toContain('env');
    expect(keys).not.toContain('headers');
    const serialized = JSON.stringify(session);
    expect(serialized.split(SECRET).length - 1).toBe(1);
    expect(session.toolContext.cwd).toBe(path.join(projectDir, '.auto-claude/worktrees/tasks', SPEC));
  }, 30000);
});
