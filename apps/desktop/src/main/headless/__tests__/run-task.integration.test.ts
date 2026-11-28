/**
 * zeenha fork: headless run against a real git repo, a real worktree and the
 * real WorkerBridgeCore, with a stub worker script in place of the agent. The
 * stub never calls a model.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { ipcMain, ipcRenderer } from 'electron';

vi.mock('../../ai/prompts/prompt-loader', () => ({
  tryLoadPrompt: () => 'PLANNER PROMPT',
}));

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, ipcRenderer: { invoke: vi.fn() } }));
vi.mock('../../project-store', () => ({ projectStore: { getProject: vi.fn() } }));

import { createTaskAPI } from '../../../preload/api/task-api';
import type { Project } from '../../../shared/types';
import { WorkerBridgeCore } from '../../ai/agent/worker-bridge-core';
import type { AgentExecutorConfig } from '../../ai/agent/types';
import { registerTaskDeliveryReceiptsHandlers } from '../../ipc-handlers/task/delivery-receipts-handlers';
import { projectStore } from '../../project-store';
import { LEGACY_WORKTREE_DIR, TASK_WORKTREE_DIR } from '../../worktree-paths';
import { runCli } from '../cli';
import { type HeadlessBridge, type HeadlessRunOptions, runHeadlessTask } from '../run-task';
import { runServe } from '../serve';

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

function run(stub: keyof typeof STUBS, overrides: Partial<HeadlessRunOptions> = {}) {
  const workerPath = writeStub(stub);
  return runHeadlessTask({
    projectPath: projectDir,
    spec: SPEC,
    workerPath,
    noPush: true,
    // zeenha fork: memory probes Ollama through the stubbed fetch; only the memory test turns it on.
    config: { memory: { enabled: false } },
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
    ...overrides,
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
  vi.stubEnv('APERANT_WEBHOOK_URL', '');
  vi.stubEnv('APERANT_WEBHOOK_SECRET', '');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected fixture request')));
});

afterEach(() => {
  vi.unstubAllGlobals();
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

  // zeenha fork: headless memory is on by default and uses the project's own database file.
  it('opens the project memory database when memory is on', async () => {
    expect(await run('pass', { config: {} })).toBe(0);
    expect(existsSync(path.join(projectDir, '.auto-claude', 'memory.db'))).toBe(true);
  }, 30000);
});

// zeenha fork: the same receipt written by headless must be readable through
// the CLI and desktop preload, without contacting any provider on read.
const hook = 'https://hooks.example.com/fixture-private-url';
const specFile = (name: string) => path.join(projectDir, '.auto-claude', 'specs', SPEC, name);
const receiptFile = () => path.join(projectDir, '.auto-claude', 'delivery-receipts.json');
const readNdjson = (text: string) => text.trim().split('\n').map((line) => JSON.parse(line));

async function cliHistory(json = false, projectPath = projectDir, spec = SPEC) {
  const output: string[] = [];
  const errors: string[] = [];
  const args = ['receipts', spec, '--project', projectPath, ...(json ? ['--json'] : [])];
  expect(await runCli(args, { out: (t) => void output.push(t), err: (t) => void errors.push(t) })).toBe(0);
  expect(errors).toEqual([]);
  return output.join('');
}

function desktopReader() {
  vi.mocked(ipcMain.handle).mockClear();
  vi.mocked(projectStore.getProject).mockImplementation((id) =>
    id === 'fixture-project' ? { id, path: projectDir } as Project : undefined
  );
  registerTaskDeliveryReceiptsHandlers();
  const [[channel, handler]] = vi.mocked(ipcMain.handle).mock.calls;
  vi.mocked(ipcRenderer.invoke).mockImplementation(async (name, ...args) => {
    expect(name).toBe(channel);
    return handler({} as Electron.IpcMainInvokeEvent, ...args);
  });
  const api = createTaskAPI();
  return () => api.getTaskDeliveryReceipts('fixture-project', SPEC);
}

describe('headless delivery receipt history', () => {
  it.each([TASK_WORKTREE_DIR, LEGACY_WORKTREE_DIR])('shares history for a linked checkout under %s', async (worktreeDir) => {
    const worktree = path.join(projectDir, worktreeDir, SPEC);
    git('worktree', 'add', '--quiet', '--detach', worktree, 'HEAD');
    const worktreeSpec = path.join(worktree, '.auto-claude', 'specs', SPEC);
    mkdirSync(worktreeSpec, { recursive: true });
    writeFileSync(path.join(worktreeSpec, 'spec.md'), '# Demo\n');

    expect(await run('pass', {
      projectPath: worktreeSpec,
      baseBranch: 'missing-fixture-branch',
      json: true,
      config: { webhook: { url: 'http://example.com/rejected-hook' }, memory: { enabled: false } },
    })).toBe(1);
    expect(spawned).toEqual([]);
    expect(err.join('')).toContain('Could not create the task');
    const events = readNdjson(out.join(''));
    expect(events.at(-1)).toMatchObject({ type: 'result', kind: 'error', exitCode: 1 });
    const history = events.at(-2);
    expect(history).toMatchObject({ type: 'delivery-receipts', spec: SPEC, receipts: [
      { operation: 'webhook', event: 'failed', status: 'skipped', reason: 'invalid_target' },
    ] });

    expect(JSON.parse(await cliHistory(true))).toEqual(history);
    // History resolves the registered task even without a worktree-local spec copy.
    rmSync(worktreeSpec, { recursive: true });
    expect(JSON.parse(await cliHistory(true, worktree))).toEqual(history);
    await expect(desktopReader()()).resolves.toEqual({ success: true, data: history.receipts });
    expect(existsSync(path.join(worktree, '.auto-claude', 'delivery-receipts.json'))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  }, 30000);

  it('reads exact worktree-only history after the linked checkout is removed', async () => {
    const spec = '002-worktree-only';
    const worktree = path.join(projectDir, TASK_WORKTREE_DIR, spec);
    git('worktree', 'add', '--quiet', '--detach', worktree, 'HEAD');
    const worktreeSpec = path.join(worktree, '.auto-claude', 'specs', spec);
    mkdirSync(worktreeSpec, { recursive: true });
    writeFileSync(path.join(worktreeSpec, 'spec.md'), '# Worktree-only fixture\n');
    expect(existsSync(path.join(projectDir, '.auto-claude', 'specs', spec))).toBe(false);
    const exclude = path.resolve(projectDir, git('rev-parse', '--git-path', 'info/exclude'));
    const before = readFileSync(exclude, 'utf8');
    expect(JSON.parse(await cliHistory(true, worktree, spec))).toEqual({
      type: 'delivery-receipts', spec, receipts: [],
    });
    expect(existsSync(receiptFile())).toBe(false);
    expect(readFileSync(exclude, 'utf8')).toBe(before);

    expect(await run('pass', {
      projectPath: worktree,
      spec,
      baseBranch: 'missing-fixture-branch',
      json: true,
      config: { webhook: { url: 'http://example.com/rejected-hook' }, memory: { enabled: false } },
    })).toBe(1);
    const events = readNdjson(out.join(''));
    expect(events.at(-1)).toMatchObject({ type: 'result', kind: 'error', exitCode: 1 });
    const history = events.at(-2);
    expect(history).toMatchObject({ type: 'delivery-receipts', spec, receipts: [
      { operation: 'webhook', event: 'failed', status: 'skipped', reason: 'invalid_target' },
    ] });
    const localFile = '.auto-claude/delivery-receipts.json';
    expect(existsSync(receiptFile())).toBe(true);
    expect(existsSync(path.join(worktree, localFile))).toBe(false);
    expect(git('check-ignore', '--', localFile)).toBe(localFile);
    expect(git('status', '--short', '--untracked-files=all', '--', localFile)).toBe('');
    expect(existsSync(path.join(projectDir, '.gitignore'))).toBe(false);

    const after = readFileSync(exclude, 'utf8');
    expect(JSON.parse(await cliHistory(true, worktree, spec))).toEqual(history);
    expect(JSON.parse(await cliHistory(true, projectDir, spec))).toEqual(history);
    git('worktree', 'remove', '--force', worktree);
    expect(JSON.parse(await cliHistory(true, projectDir, spec))).toEqual(history);
    expect(readFileSync(exclude, 'utf8')).toBe(after);
    expect(spawned).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  }, 30000);

  it('shares mixed delivery results with desktop and CLI without changing a successful build', async () => {
    const jira = 'https://fixture.atlassian.net';
    const token = 'fixture-private-tracker-token';
    const title = 'fixture-private-request-payload';
    const responseBody = 'fixture-private-response-body';
    const basicAuth = Buffer.from(`test@example.com:${token}`).toString('base64');
    writeFileSync(specFile('spec.md'), `# ${title}\n`);
    writeFileSync(specFile('task_metadata.json'), JSON.stringify({
      sourceType: 'jira', jiraIssueKey: 'DEMO-1', jiraSiteUrl: jira,
    }));
    writeFileSync(path.join(projectDir, '.auto-claude', '.env'),
      `JIRA_SITE_URL=${jira}\nJIRA_EMAIL=test@example.com\nJIRA_API_TOKEN=${token}\n`);

    const fetchMock = vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(responseBody, { status: 429 })) // webhook retry
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(responseBody, { status: 429 })) // Jira comment: no retry
      .mockResolvedValueOnce(Response.json({ transitions: [{ id: '5', to: { name: 'In Review' } }] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const delay = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    expect(await run('pass', {
      json: true,
      webhookDelay: delay,
      config: { webhook: { url: hook }, writeback: { jira: { enabled: true, transitionOnReview: true } }, memory: { enabled: false } },
    })).toBe(0);
    const issue = `${jira}/rest/api/3/issue/DEMO-1`;
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [hook, 'POST'], [hook, 'POST'], [`${issue}/comment`, 'POST'],
      [`${issue}/transitions`, 'GET'], [`${issue}/transitions`, 'POST'],
    ]);
    expect(delay.mock.calls).toEqual([[500]]);
    expect(fetchMock.mock.calls[0][1]?.body).toContain(title);
    expect(fetchMock.mock.calls[2][1]?.headers).toMatchObject({ Authorization: `Basic ${basicAuth}` });

    const records = readNdjson(out.join(''));
    const receiptEvent = records.at(-2);
    expect(records.at(-1)).toMatchObject({ type: 'result', kind: 'success', exitCode: 0, spec: SPEC });
    expect(receiptEvent).toMatchObject({ type: 'delivery-receipts', spec: SPEC });
    expect(receiptEvent.receipts).toHaveLength(3);
    expect(receiptEvent.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'webhook', event: 'review_ready', status: 'delivered', attempts: 2, httpStatus: 204 }),
      expect.objectContaining({ operation: 'issue_comment', provider: 'jira', status: 'failed', reason: 'rate_limited', attempts: 1, httpStatus: 429 }),
      expect.objectContaining({ operation: 'issue_transition', provider: 'jira', status: 'delivered', attempts: 1 }),
    ]));

    const persisted = readFileSync(receiptFile(), 'utf8');
    expect(existsSync(path.join(projectDir, '.auto-claude/worktrees/tasks', SPEC, '.auto-claude/delivery-receipts.json'))).toBe(false);
    const ipc = await desktopReader()();
    expect(ipc).toEqual({ success: true, data: receiptEvent.receipts });
    const json = await cliHistory(true);
    expect(JSON.parse(json)).toEqual(receiptEvent);
    const text = await cliHistory();
    expect(text).toContain('issue_comment review_ready failed provider=jira reason=rate_limited attempts=1 http=429');
    expect(text).toContain('issue_transition review_ready delivered provider=jira attempts=1');
    for (const surface of [persisted, JSON.stringify(ipc), JSON.stringify(receiptEvent), json, text]) {
      for (const value of [hook, 'fixture-private-url', jira, token, title, responseBody, basicAuth]) {
        expect(surface).not.toContain(value);
      }
    }
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(readFileSync(receiptFile(), 'utf8')).toBe(persisted);
  }, 30000);

  it('does not record anything for a build with delivery opted out', async () => {
    expect(await run('pass', { json: true })).toBe(0);
    expect(out.join('')).not.toContain('delivery-receipts');
    expect(JSON.parse(await cliHistory(true))).toEqual({ type: 'delivery-receipts', spec: SPEC, receipts: [] });
    await expect(desktopReader()()).resolves.toEqual({ success: true, data: [] });
    expect(existsSync(receiptFile())).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  }, 30000);

  it('keeps a webhook timeout unknown after later refusals, without exposing its error', async () => {
    const detail = 'fixture-private-timeout-detail';
    const fetchMock = vi.mocked(fetch)
      .mockRejectedValueOnce(new DOMException(detail, 'TimeoutError'))
      .mockImplementation(async () => new Response(detail, { status: 429 }));
    const delay = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    expect(await run('pass', { config: { webhook: { url: hook }, memory: { enabled: false } }, webhookDelay: delay })).toBe(0);
    expect(delay.mock.calls).toEqual([[500], [1000]]);
    expect(out.join('')).toMatch(/DELIVERY .*webhook review_ready unknown .*reason=timeout attempts=3\nRESULT success exit=0/);
    const surfaces = [out.join(''), readFileSync(receiptFile(), 'utf8'), await cliHistory(true), JSON.stringify(await desktopReader()())];
    for (const surface of surfaces) {
      expect(surface).not.toContain(detail);
      expect(surface).not.toContain(hook);
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 30000);

  it.each(['project root', 'linked task worktree'])('keeps a settled build and unconfirmed receipt after daemon interruption from %s, with no replay', async (checkout) => {
    const serveProjectDir = checkout === 'project root' ? projectDir : path.join(projectDir, TASK_WORKTREE_DIR, SPEC);
    const serveSpecDir = path.join(serveProjectDir, '.auto-claude', 'specs', SPEC);
    if (serveProjectDir !== projectDir) {
      git('worktree', 'add', '--quiet', '--detach', serveProjectDir, 'HEAD');
      mkdirSync(serveSpecDir, { recursive: true });
      writeFileSync(path.join(serveSpecDir, 'spec.md'), '# Demo\n');
    }
    const plan = path.join(serveSpecDir, 'implementation_plan.json');
    writeFileSync(plan, JSON.stringify({ feature: 'Demo', status: 'queue', phases: [] }));
    // Simulate process exit with a request that never returns an acknowledgment.
    const fetchMock = vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
    const createBridge = vi.fn<NonNullable<HeadlessRunOptions['createBridge']>>(
      (options) => new WorkerBridgeCore(options) as unknown as HeadlessBridge
    );
    let signal: ((name: string) => void) | undefined;
    const serve = () => runServe({
      projectPath: serveProjectDir, workerPath: writeStub('pass'), createBridge,
      noPush: true, baseBranch: 'main', json: true, shutdownTimeoutMs: 0,
      config: { webhook: { enabled: true, url: hook }, memory: { enabled: false } },
      out: (t) => void out.push(t), err: (t) => void err.push(t),
      installSignalHandlers: (handler) => {
        signal = handler;
        return () => { signal = undefined; };
      },
    });
    const stop = async (daemon: Promise<number>) => {
      await vi.waitFor(() => expect(signal).toBeDefined());
      signal?.('SIGTERM');
      expect(await daemon).toBe(0);
    };
    const first = serve();
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce(), { timeout: 10000 });
    } finally {
      await stop(first);
    }
    expect(JSON.parse(readFileSync(plan, 'utf8'))).toMatchObject({ status: 'human_review', reviewReason: 'completed' });
    expect(readNdjson(out.join(''))).toContainEqual(
      expect.objectContaining({ type: 'result', taskId: SPEC, kind: 'success', exitCode: 0 })
    );
    const persisted = readFileSync(receiptFile(), 'utf8');

    await stop(serve());
    expect(createBridge).toHaveBeenCalledOnce();
    const history = JSON.parse(await cliHistory(true));
    expect(history).toMatchObject({ type: 'delivery-receipts', spec: SPEC, receipts: [
      { operation: 'webhook', status: 'unknown', reason: 'unconfirmed' },
    ] });
    if (serveProjectDir !== projectDir) {
      expect(JSON.parse(await cliHistory(true, serveProjectDir))).toEqual(history);
      expect(existsSync(path.join(serveProjectDir, '.auto-claude', 'delivery-receipts.json'))).toBe(false);
    }
    expect(await cliHistory()).toContain('unknown provider=slack reason=unconfirmed');
    const read = desktopReader();
    // Same preload call used by Task Detail on open and Refresh.
    await expect(read()).resolves.toEqual({ success: true, data: history.receipts });
    await expect(read()).resolves.toEqual({ success: true, data: history.receipts });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(readFileSync(receiptFile(), 'utf8')).toBe(persisted);
  }, 30000);
});
