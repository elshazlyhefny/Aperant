/** zeenha fork: exercise the real check command without allowing it to run an agent. */
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { get as httpGet, request as httpRequest } from 'node:http';
import { get as httpsGet, request as httpsRequest } from 'node:https';
import { connect, createConnection } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getQueueLockPath } from '../../utils/project-queue-lock';
import { runCli } from '../cli';
import type { PreflightReport } from '../preflight';

const workerSpies = vi.hoisted(() => ({ WorkerBridgeCore: vi.fn(), Worker: vi.fn() }));
vi.mock('../../ai/agent/worker-bridge-core', () => ({ WorkerBridgeCore: workerSpies.WorkerBridgeCore }));
vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  return { ...actual, Worker: workerSpies.Worker, default: { ...actual, Worker: workerSpies.Worker } };
});

const executionSpies = vi.hoisted(() => ({ runHeadlessTask: vi.fn(), runServe: vi.fn(), createHeadlessSpec: vi.fn() }));
vi.mock('../run-task', () => ({ runHeadlessTask: executionSpies.runHeadlessTask }));
vi.mock('../serve', () => ({ runServe: executionSpies.runServe }));
vi.mock('../new-spec', () => ({ createHeadlessSpec: executionSpies.createHeadlessSpec }));

const authSpies = vi.hoisted(() => ({
  resolver: { resolveAuth: vi.fn(), resolveAuthFromQueue: vi.fn(), refreshOAuthTokenReactive: vi.fn(), hasCredentials: vi.fn() },
  refresh: { ensureValidToken: vi.fn(), reactiveTokenRefresh: vi.fn(), refreshOAuthToken: vi.fn() },
  provider: { ensureValidOAuthToken: vi.fn() },
  keychain: {
    getCredentials: vi.fn(), getCredentialsFromKeychain: vi.fn(), getFullCredentialsFromKeychain: vi.fn(),
    updateKeychainCredentials: vi.fn(),
  },
}));
vi.mock('../../ai/auth/resolver', () => authSpies.resolver);
vi.mock('../../claude-profile/token-refresh', () => authSpies.refresh);
vi.mock('../../ai/providers/oauth-fetch', () => authSpies.provider);
vi.mock('../../claude-profile/credential-utils', () => authSpies.keychain);

const lockSpies = vi.hoisted(() => ({ acquireProjectQueueLock: vi.fn(), writeStopRequest: vi.fn() }));
vi.mock('../../utils/project-queue-lock', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../utils/project-queue-lock')>(),
  acquireProjectQueueLock: lockSpies.acquireProjectQueueLock,
}));
vi.mock('../stop-request', async (importOriginal) => ({
  ...await importOriginal<typeof import('../stop-request')>(),
  writeStopRequest: lockSpies.writeStopRequest,
}));

const blockNetwork = vi.hoisted(() => () => { throw new Error('Unexpected network call in preflight'); });
// Preserve the modules' other exports (e.g. net.isIP for webhook URL validation).
vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  const spies = { request: vi.fn(blockNetwork), get: vi.fn(blockNetwork) };
  return { ...actual, ...spies, default: { ...actual, ...spies } };
});
vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>();
  const spies = { request: vi.fn(blockNetwork), get: vi.fn(blockNetwork) };
  return { ...actual, ...spies, default: { ...actual, ...spies } };
});
vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  const spies = { connect: vi.fn(blockNetwork), createConnection: vi.fn(blockNetwork) };
  return { ...actual, ...spies, default: { ...actual, ...spies } };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  // Fail closed on unexpected commands, even if the CLI catches the error.
  function observe<T extends (...args: never[]) => unknown>(fn: T) {
    return vi.fn((...args: Parameters<T>) => {
      const [command, argv] = args;
      if (command !== 'git' || !Array.isArray(argv) || argv[0] !== 'rev-parse') {
        throw new Error('Unexpected subprocess in preflight');
      }
      return fn(...args);
    });
  }
  const spies = {
    execFileSync: observe(actual.execFileSync), execFile: observe(actual.execFile),
    spawn: observe(actual.spawn), spawnSync: observe(actual.spawnSync),
  };
  return { ...actual, ...spies, default: { ...actual, ...spies } };
});

const ACCOUNT_KEY = 'sk-acct-SECRET-111111';
const CONFIG_WEBHOOK = 'https://hooks.slack.com/services/T000/B000/SECRETPATH';
const CONFIG_SIGNING_SECRET = 'whsec-SECRET-222222';
const ENV = {
  ANTHROPIC_API_KEY: 'sk-ant-SECRET-333333',
  CLAUDE_CODE_OAUTH_TOKEN: 'oat-SECRET-444444',
  OPENAI_API_KEY: 'sk-openai-SECRET-555555',
  APERANT_WEBHOOK_URL: 'http://example.com/hook/SECRET-666666',
  APERANT_WEBHOOK_SECRET: 'whsec-SECRET-777777',
};
// The spec path is printed in both formats, so redaction is exercised even
// when report details (below) are omitted from the text output.
const SPEC_ID = `001-safety-${ENV.ANTHROPIC_API_KEY}`;

function snapshot(root: string) {
  function walk(dir: string): unknown[] {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return entries.flatMap((dirent) => {
      const file = path.join(dir, dirent.name);
      const relative = path.relative(root, file);
      if (dirent.isFile()) {
        // Stat and hash through one descriptor, so both describe the same file.
        const fd = openSync(file, 'r');
        try {
          const stat = fstatSync(fd);
          const sha1 = createHash('sha1').update(readFileSync(fd)).digest('hex');
          return [{ path: relative, type: 'file', size: stat.size, mtimeMs: stat.mtimeMs, sha1 }];
        } finally {
          closeSync(fd);
        }
      }
      const stat = lstatSync(file);
      const type = dirent.isDirectory() ? 'directory' : 'other';
      const entry = { path: relative, type, size: stat.size, mtimeMs: stat.mtimeMs, sha1: null };
      return dirent.isDirectory() ? [entry, ...walk(file)] : [entry];
    });
  }
  return walk(root);
}

let root: string;
let configPath: string;

beforeEach(async () => {
  vi.clearAllMocks();
  root = mkdtempSync(path.join(tmpdir(), 'preflight-safety-'));
  const git = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  git.execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  git.execFileSync('git', [
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    // zeenha fork: no detached auto-maintenance, which could write .git/objects/maintenance.lock
    // after the "before" snapshot and fail the no-side-effects comparison.
    '-c', 'core.hooksPath=.git/no-hooks', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
    'commit', '-q', '--allow-empty', '-m', 'Initial fixture commit',
  ], { cwd: root });

  const specDir = path.join(root, '.auto-claude', 'specs', SPEC_ID);
  mkdirSync(specDir, { recursive: true });
  writeFileSync(path.join(specDir, 'spec.md'), '# Safety fixture\n');
  writeFileSync(path.join(specDir, 'task_metadata.json'), JSON.stringify({
    phaseProviders: { planning: 'anthropic', coding: 'openai', qa: 'groq' },
    // Echo credential-shaped canaries through otherwise innocuous report details.
    phaseModels: {
      planning: `fixture ${ENV.ANTHROPIC_API_KEY} ${ENV.CLAUDE_CODE_OAUTH_TOKEN} ${ENV.OPENAI_API_KEY}`,
      coding: `fixture ${CONFIG_WEBHOOK} ${ENV.APERANT_WEBHOOK_URL} ${CONFIG_SIGNING_SECRET} ${ENV.APERANT_WEBHOOK_SECRET}`,
      qa: `fixture ${ACCOUNT_KEY}`,
    },
    tokenBudget: 500_000,
  }));
  const codexTokenFilePath = path.join(root, 'codex-tokens.json');
  writeFileSync(codexTokenFilePath, '{}');
  configPath = path.join(root, 'headless.json');
  writeFileSync(configPath, JSON.stringify({
    providerAccounts: [
      { id: 'api', provider: 'groq', authType: 'api-key', apiKey: ACCOUNT_KEY },
      { id: 'claude', provider: 'anthropic', authType: 'oauth', claudeProfileId: 'fixture-profile' },
      { id: 'codex', provider: 'openai', authType: 'oauth' },
    ],
    codexTokenFilePath,
    webhook: { enabled: true, url: CONFIG_WEBHOOK, secret: CONFIG_SIGNING_SECRET },
  }));
  for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function check({ daemon = false, json }: { daemon?: boolean; json: boolean }) {
  const lockPath = getQueueLockPath(root);
  const lockDir = path.dirname(lockPath);
  if (daemon) {
    const now = new Date().toISOString();
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      token: 'fixture-owner', kind: 'daemon', pid: process.pid, host: hostname(), startedAt: now, heartbeatAt: now,
    }));
  }
  const lockBefore = daemon ? readFileSync(lockPath) : null;
  const before = snapshot(root);
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(blockNetwork);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli([
    'check', SPEC_ID, '--project', root, '--config', configPath,
    ...(daemon ? ['--daemon'] : []), ...(json ? ['--json'] : []),
  ], { out: (text) => void stdout.push(text), err: (text) => void stderr.push(text) });

  for (const spies of [workerSpies, executionSpies, ...Object.values(authSpies), lockSpies]) {
    for (const [name, spy] of Object.entries(spies)) expect(spy, name).not.toHaveBeenCalled();
  }
  for (const spy of [fetch, httpGet, httpRequest, httpsGet, httpsRequest, connect, createConnection]) {
    expect(spy).not.toHaveBeenCalled();
  }
  const calls = [execFileSync, execFile, spawn, spawnSync].flatMap((fn) => vi.mocked(fn).mock.calls.map((args) => args.slice(0, 2)));
  expect(calls.length).toBeGreaterThan(0);
  for (const [command, args] of calls) {
    expect(command).toBe('git');
    expect(Array.isArray(args) && args[0]).toBe('rev-parse');
  }

  expect(existsSync(path.join(root, '.auto-claude', 'worktrees'))).toBe(false);
  if (existsSync(lockDir)) expect(readdirSync(lockDir).filter((name) => name.startsWith('stop-request-'))).toEqual([]);
  if (lockBefore) expect(readFileSync(lockPath)).toEqual(lockBefore);
  else expect(existsSync(lockPath)).toBe(false);
  expect(snapshot(root)).toEqual(before);

  const output = stdout.join('');
  const combined = output + stderr.join('');
  for (const secret of [ACCOUNT_KEY, CONFIG_WEBHOOK, CONFIG_SIGNING_SECRET, ...Object.values(ENV),
    '/services/T000/B000/SECRETPATH', '/hook/SECRET-666666', 'SECRETPATH', 'SECRET-666666',
  ]) expect(combined).not.toContain(secret);
  expect(stderr).toEqual([]);
  return { code, output };
}

describe('headless check safety', () => {
  it.each([
    { daemon: false, json: false }, { daemon: false, json: true },
    { daemon: true, json: false }, { daemon: true, json: true },
  ])('has no side effects or secret leaks (daemon=$daemon, json=$json)', async ({ daemon, json }) => {
    const { code, output } = await check({ daemon, json });
    expect(code).toBe(daemon ? 1 : 0);
    expect(output).toContain('001-safety-[REDACTED]');
    if (json) {
      const report: PreflightReport = JSON.parse(output);
      const find = (code: string) => report.checks.find((check) => check.code === code);
      expect(report.mode).toBe(daemon ? 'daemon' : 'run');
      expect(find('queue.owner')?.status).toBe(daemon ? 'unavailable' : 'not_applicable');
      expect(find('config.webhook')?.status).toBe(daemon ? 'valid' : 'warning');
      expect(find('credentials.planning')).toMatchObject({
        status: 'unverified', details: { source: 'account:claude', model: 'fixture [REDACTED] [REDACTED] [REDACTED]' },
      });
      expect(find('credentials.coding')).toMatchObject({
        status: 'unverified', details: { source: 'account:codex', model: 'fixture [REDACTED_URL] [REDACTED_URL] [REDACTED] [REDACTED]' },
      });
      expect(find('credentials.qa')).toMatchObject({
        status: 'valid', details: { source: 'account:api', model: 'fixture [REDACTED]' },
      });
      expect(find('credentials.remote')?.status).toBe('unverified');
    } else {
      expect(output).toContain(daemon ? 'Queue is held by daemon' : 'webhook disabled:');
      expect(output).toContain(daemon ? 'NOT READY:' : '\nREADY\n');
    }
  });

  it.each([false, true])('omits malformed config contents from the parse diagnostic (json=%s)', async (json) => {
    // V8's parse diagnostic can quote the beginning of the unquoted key.
    writeFileSync(configPath, `{"apiKey": ${ACCOUNT_KEY}, "webhook":{"url": "${CONFIG_WEBHOOK}"}}`);
    const { code, output } = await check({ json });
    expect(code).toBe(1);
    expect(output).not.toContain('sk-acct-');
    expect(output).toContain('invalid JSON');
    if (json) {
      const report: PreflightReport = JSON.parse(output);
      expect(report.checks).toContainEqual(expect.objectContaining({
        code: 'config.file', status: 'unavailable', blocking: true,
      }));
    } else {
      expect(output).toContain('[FAIL] config.file');
    }
  });
});
