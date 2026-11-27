/** zeenha fork: behaviour tests for every `aperant check` readiness check. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { getQueueLockPath } from '../../utils/project-queue-lock';
import {
  PREFLIGHT_CHECK_CODES,
  type PreflightCheck,
  type PreflightOptions,
  type PreflightReport,
  renderPreflightJson,
  renderPreflightText,
  runPreflight,
} from '../preflight';

const roots: string[] = [];
// Only what git needs to be found and to stay inside the temp directory: no host credentials.
const BASE_ENV: NodeJS.ProcessEnv = { PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: tmpdir() };
// Satisfies credentials.default, so tests about other checks can assert ok.
const READY_ENV = { ANTHROPIC_API_KEY: 'sk-ant-fixture' };

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix = 'preflight-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A repository on `branch` with one commit (or none). */
function makeRepo({ branch = 'main', commit = true }: { branch?: string; commit?: boolean } = {}): string {
  const root = tempDir();
  git(root, 'init', '-q', '-b', branch);
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'user.name', 'Fixture');
  if (commit) {
    writeFileSync(path.join(root, 'README.md'), '# fixture\n');
    git(root, 'add', 'README.md');
    git(root, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=.git/no-hooks', 'commit', '-q', '-m', 'init');
  }
  return root;
}

function writeConfig(content: unknown): string {
  const file = path.join(tempDir('preflight-config-'), 'headless.json');
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

function makeSpec(root: string, specId: string, metadata?: unknown): string {
  const specDir = path.join(root, '.auto-claude', 'specs', specId);
  mkdirSync(specDir, { recursive: true });
  writeFileSync(path.join(specDir, 'spec.md'), `# ${specId}\n`);
  if (metadata !== undefined) writeFileSync(path.join(specDir, 'task_metadata.json'), JSON.stringify(metadata));
  return specDir;
}

async function preflight(options: PreflightOptions): Promise<PreflightReport> {
  return runPreflight({ ...options, env: { ...BASE_ENV, ...options.env } });
}

function find(report: PreflightReport, code: string): PreflightCheck {
  const check = report.checks.find((entry) => entry.code === code);
  if (!check) throw new Error(`missing check ${code}`);
  return check;
}

function expectCodesUnique(report: PreflightReport): void {
  const codes = report.checks.map((check) => check.code);
  expect(new Set(codes).size).toBe(codes.length);
  for (const code of codes) expect(PREFLIGHT_CHECK_CODES).toContain(code);
  expect([...codes].sort()).toEqual([...PREFLIGHT_CHECK_CODES].sort());
}

describe('runPreflight: git', () => {
  it('blocks outside a repository and skips the commit and base ref checks', async () => {
    const report = await preflight({ projectPath: tempDir('preflight-norepo-') });
    expect(find(report, 'git.repository')).toMatchObject({ status: 'unavailable', blocking: true });
    expect(find(report, 'git.commit')).toMatchObject({ status: 'not_applicable', blocking: false });
    expect(find(report, 'git.base_ref')).toMatchObject({ status: 'not_applicable', blocking: false });
    expect(report.ok).toBe(false);
    expect(report.project).toBeNull();
    expectCodesUnique(report);
  });

  it('blocks when HEAD has no commit', async () => {
    const report = await preflight({ projectPath: makeRepo({ commit: false }) });
    expect(find(report, 'git.repository').status).toBe('valid');
    expect(find(report, 'git.commit')).toMatchObject({ status: 'unavailable', blocking: true });
    expect(report.ok).toBe(false);
  });

  it('accepts an existing local base branch from the default', async () => {
    const report = await preflight({ projectPath: makeRepo(), env: READY_ENV });
    expect(find(report, 'git.commit').status).toBe('valid');
    expect(find(report, 'git.base_ref')).toMatchObject({
      status: 'valid', blocking: false, details: { base: 'main', source: 'default', ref: 'main' },
    });
    expect(report.ok).toBe(true);
  });

  it('prefers an origin-tracking ref', async () => {
    const root = makeRepo();
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const report = await preflight({ projectPath: root });
    expect(find(report, 'git.base_ref')).toMatchObject({
      status: 'valid', details: { base: 'main', source: 'default', ref: 'origin/main' },
    });
  });

  it('reports the source of a missing base ref', async () => {
    const flag = await preflight({ projectPath: makeRepo(), baseBranch: 'nope' });
    expect(find(flag, 'git.base_ref')).toMatchObject({
      status: 'unavailable', blocking: true, details: { base: 'nope', source: 'flag', ref: null },
    });
    expect(flag.ok).toBe(false);

    const repoConfigRoot = makeRepo();
    writeFileSync(path.join(repoConfigRoot, '.aperant.json'), JSON.stringify({ baseBranch: 'missing-branch' }));
    const repoConfig = await preflight({ projectPath: repoConfigRoot });
    expect(find(repoConfig, 'git.base_ref')).toMatchObject({
      status: 'unavailable', blocking: true, details: { base: 'missing-branch', source: '.aperant.json' },
    });

    const config = await preflight({
      projectPath: makeRepo(), configPath: writeConfig({ project: { mainBranch: 'cfg-branch' } }),
    });
    expect(find(config, 'git.base_ref')).toMatchObject({
      status: 'unavailable', blocking: true, details: { base: 'cfg-branch', source: 'config' },
    });

    const fallback = await preflight({ projectPath: makeRepo({ branch: 'trunk' }) });
    expect(find(fallback, 'git.base_ref')).toMatchObject({
      status: 'unavailable', blocking: true, details: { base: 'main', source: 'default' },
    });
  });

  it('lets the flag win over .aperant.json', async () => {
    const root = makeRepo();
    writeFileSync(path.join(root, '.aperant.json'), JSON.stringify({ baseBranch: 'missing-branch' }));
    const report = await preflight({ projectPath: root, baseBranch: 'main' });
    expect(find(report, 'git.base_ref')).toMatchObject({ status: 'valid', details: { source: 'flag', ref: 'main' } });
  });
});

describe('runPreflight: config', () => {
  const dependents = [
    'config.values', 'config.webhook', 'sandbox.tools',
    'credentials.default', 'credentials.planning', 'credentials.coding', 'credentials.qa', 'credentials.remote',
  ];

  it.each([
    ['a missing file', () => path.join(tempDir('preflight-config-'), 'absent.json')],
    ['bad JSON', () => writeConfig('{not json')],
    ['providerAccounts that is not an array', () => writeConfig({ providerAccounts: {} })],
  ])('blocks on %s and skips the dependent checks', async (_name, configPath) => {
    const report = await preflight({ projectPath: makeRepo(), configPath: configPath() });
    expect(find(report, 'config.file')).toMatchObject({ status: 'unavailable', blocking: true });
    for (const code of dependents) expect(find(report, code).status, code).toBe('not_applicable');
    expect(find(report, 'git.base_ref').status).toBe('not_applicable');
    expect(report.ok).toBe(false);
    expectCodesUnique(report);
  });

  it('reports bad JSON without quoting the file contents', async () => {
    const report = await preflight({ projectPath: makeRepo(), configPath: writeConfig('{"apiKey": sk-SECRET-123}') });
    expect(find(report, 'config.file').message).toContain('invalid JSON');
    expect(JSON.stringify(report)).not.toContain('sk-SECRET');
  });

  it('accepts no config file and a valid one', async () => {
    const none = await preflight({ projectPath: makeRepo() });
    expect(find(none, 'config.file').status).toBe('valid');
    expect(find(none, 'config.values').status).toBe('valid');
    const file = await preflight({ projectPath: makeRepo(), configPath: writeConfig({ project: { bashSandbox: 'off' } }) });
    expect(find(file, 'config.file').status).toBe('valid');
    expect(find(file, 'config.values').status).toBe('valid');
  });

  it('warns about an unknown bashSandbox value', async () => {
    const report = await preflight({ projectPath: makeRepo(), configPath: writeConfig({ project: { bashSandbox: 'bogus' } }) });
    expect(find(report, 'config.values')).toMatchObject({ status: 'warning', blocking: false });
    expect(find(report, 'config.values').message).toContain('bashSandbox');
    expect(find(report, 'sandbox.tools').status).toBe('valid');
  });
});

describe('runPreflight: sandbox.tools', () => {
  const sandboxConfig = (mode: string) => writeConfig({ project: { bashSandbox: mode } });

  it('blocks home-hidden on linux when bubblewrap is missing', async () => {
    const report = await preflight({
      projectPath: makeRepo(), configPath: sandboxConfig('home-hidden'), findTool: () => null, platformName: 'linux',
    });
    const check = find(report, 'sandbox.tools');
    expect(check).toMatchObject({ status: 'unavailable', blocking: true, details: { mode: 'home-hidden', tool: 'bwrap' } });
    expect(check.message).toContain('tool-missing');
    expect(check.guidance).toContain('bubblewrap');
    expect(report.ok).toBe(false);
  });

  it('accepts home-hidden on linux when bubblewrap is found', async () => {
    const report = await preflight({
      projectPath: makeRepo(), configPath: sandboxConfig('home-hidden'), findTool: () => '/usr/bin/bwrap', platformName: 'linux',
      env: READY_ENV,
    });
    expect(find(report, 'sandbox.tools')).toMatchObject({ status: 'valid', blocking: false });
    expect(report.ok).toBe(true);
  });

  it('blocks restricted-rights on linux as unsupported', async () => {
    const report = await preflight({
      projectPath: makeRepo(), configPath: sandboxConfig('restricted-rights'), findTool: () => '/usr/bin/bwrap', platformName: 'linux',
    });
    const check = find(report, 'sandbox.tools');
    expect(check).toMatchObject({ status: 'unavailable', blocking: true });
    expect(check.message).toContain('mode-unsupported');
  });

  it('accepts off without looking for a tool', async () => {
    const report = await preflight({
      projectPath: makeRepo(), configPath: sandboxConfig('off'),
      findTool: () => { throw new Error('should not look for a tool'); }, platformName: 'linux',
    });
    expect(find(report, 'sandbox.tools')).toMatchObject({ status: 'valid', blocking: false });
  });
});

describe('runPreflight: queue.owner', () => {
  const NOW = Date.parse('2026-01-01T00:00:00.000Z');
  const HOST = 'preflight-host';

  function writeLock(root: string, content: string): void {
    const lockPath = getQueueLockPath(root);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, content);
  }

  function holder(heartbeatAt: number): string {
    const iso = new Date(heartbeatAt).toISOString();
    return JSON.stringify({ token: 't', kind: 'daemon', pid: 4242, host: HOST, startedAt: iso, heartbeatAt: iso });
  }

  const daemonOptions = (root: string, isPidAlive: boolean): PreflightOptions => ({
    projectPath: root, daemon: true, now: () => NOW, hostname: HOST, isPidAlive: () => isPidAlive, env: READY_ENV,
  });

  it('is not applicable in run mode, even with a live holder', async () => {
    const root = makeRepo();
    writeLock(root, holder(NOW));
    const report = await preflight({ ...daemonOptions(root, true), daemon: false });
    expect(find(report, 'queue.owner').status).toBe('not_applicable');
    expect(report.mode).toBe('run');
  });

  it('blocks on a live holder in daemon mode', async () => {
    const root = makeRepo();
    writeLock(root, holder(NOW));
    const report = await preflight(daemonOptions(root, true));
    expect(report.mode).toBe('daemon');
    expect(find(report, 'queue.owner')).toMatchObject({ status: 'unavailable', blocking: true });
    expect(find(report, 'queue.owner').message).toContain('pid 4242');
    expect(report.ok).toBe(false);
  });

  it('warns about a stale holder', async () => {
    const root = makeRepo();
    writeLock(root, holder(NOW));
    const deadPid = await preflight(daemonOptions(root, false));
    expect(find(deadPid, 'queue.owner')).toMatchObject({ status: 'warning', blocking: false });
    expect(deadPid.ok).toBe(true);

    const oldBeat = makeRepo();
    writeLock(oldBeat, holder(NOW - 10 * 60_000));
    const old = await preflight(daemonOptions(oldBeat, true));
    expect(find(old, 'queue.owner')).toMatchObject({ status: 'warning', blocking: false });
  });

  it('accepts no lock and warns about a corrupt lock file', async () => {
    const free = await preflight(daemonOptions(makeRepo(), true));
    expect(find(free, 'queue.owner')).toMatchObject({ status: 'valid', blocking: false });

    const corruptRoot = makeRepo();
    writeLock(corruptRoot, 'not json');
    const corrupt = await preflight(daemonOptions(corruptRoot, true));
    expect(find(corrupt, 'queue.owner')).toMatchObject({ status: 'warning', blocking: false });
  });
});

describe('runPreflight: config.webhook', () => {
  const httpWebhook = () => writeConfig({ webhook: { enabled: true, url: 'http://example.com/hook' } });

  it('blocks an http URL in daemon mode', async () => {
    const report = await preflight({ projectPath: makeRepo(), configPath: httpWebhook(), daemon: true });
    expect(find(report, 'config.webhook')).toMatchObject({ status: 'unavailable', blocking: true });
    expect(report.ok).toBe(false);
  });

  it('warns about the same URL in run mode', async () => {
    const report = await preflight({ projectPath: makeRepo(), configPath: httpWebhook(), env: READY_ENV });
    expect(find(report, 'config.webhook')).toMatchObject({ status: 'warning', blocking: false });
    expect(report.ok).toBe(true);
  });

  it('is not applicable without a webhook', async () => {
    const report = await preflight({ projectPath: makeRepo() });
    expect(find(report, 'config.webhook').status).toBe('not_applicable');
  });
});

describe('runPreflight: spec and budget', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-ant-fixture' };

  it('blocks on a missing spec and skips what depends on it', async () => {
    const report = await preflight({ projectPath: makeRepo(), spec: '999-missing', env });
    expect(find(report, 'spec.found')).toMatchObject({ status: 'unavailable', blocking: true, details: { specId: '999-missing' } });
    for (const code of ['spec.metadata', 'budget.effective', 'credentials.planning', 'credentials.coding', 'credentials.qa']) {
      expect(find(report, code).status, code).toBe('not_applicable');
    }
    expect(find(report, 'credentials.default').status).toBe('not_applicable');
    expect(report.spec).toBe('999-missing');
    expect(report.ok).toBe(false);
    expectCodesUnique(report);
  });

  it('reports the task token budget', async () => {
    const root = makeRepo();
    makeSpec(root, '001-budget', { tokenBudget: 500_000 });
    const report = await preflight({ projectPath: root, spec: '001-budget', env });
    expect(find(report, 'spec.found').status).toBe('valid');
    expect(find(report, 'spec.metadata').status).toBe('valid');
    expect(find(report, 'budget.effective')).toMatchObject({ status: 'valid', details: { tokenBudget: 500_000 } });
    expect(report.ok).toBe(true);
  });

  it('reports unlimited without metadata', async () => {
    const root = makeRepo();
    makeSpec(root, '001-nometa');
    const report = await preflight({ projectPath: root, spec: '001-nometa', env });
    expect(find(report, 'spec.metadata').status).toBe('valid');
    expect(find(report, 'budget.effective')).toMatchObject({ status: 'valid', details: { tokenBudget: null } });
  });

  it.each([-5, 'abc'])('warns about an invalid tokenBudget (%s)', async (tokenBudget) => {
    const root = makeRepo();
    makeSpec(root, '001-bad', { tokenBudget });
    const report = await preflight({ projectPath: root, spec: '001-bad', env });
    expect(find(report, 'budget.effective')).toMatchObject({
      status: 'warning', blocking: false, details: { tokenBudget: null },
    });
  });

  it('warns about unreadable metadata', async () => {
    const root = makeRepo();
    const specDir = makeSpec(root, '001-corrupt');
    writeFileSync(path.join(specDir, 'task_metadata.json'), '{oops');
    const report = await preflight({ projectPath: root, spec: '001-corrupt', env });
    expect(find(report, 'spec.metadata')).toMatchObject({ status: 'warning', blocking: false });
  });
});

describe('runPreflight: credentials', () => {
  const PHASES = ['credentials.planning', 'credentials.coding', 'credentials.qa'];

  it('blocks every phase of an unpinned spec without credentials', async () => {
    const root = makeRepo();
    makeSpec(root, '001-x');
    const report = await preflight({ projectPath: root, spec: '001-x' });
    for (const code of PHASES) {
      expect(find(report, code), code).toMatchObject({ status: 'unavailable', blocking: true, details: { pinned: false } });
    }
    expect(report.ok).toBe(false);
  });

  it('accepts ANTHROPIC_API_KEY for every phase of an unpinned spec', async () => {
    const root = makeRepo();
    makeSpec(root, '001-x');
    const report = await preflight({ projectPath: root, spec: '001-x', env: { ANTHROPIC_API_KEY: 'sk-ant-fixture' } });
    for (const code of PHASES) {
      expect(find(report, code), code).toMatchObject({
        status: 'valid', blocking: false, details: { provider: 'anthropic', source: 'env:ANTHROPIC_API_KEY' },
      });
    }
    expect(report.ok).toBe(true);
  });

  it('checks each pinned phase against its own provider', async () => {
    const root = makeRepo();
    makeSpec(root, '001-pinned', { phaseProviders: { planning: 'anthropic', coding: 'openai', qa: 'openai' } });
    const report = await preflight({ projectPath: root, spec: '001-pinned', env: { ANTHROPIC_API_KEY: 'sk-ant-fixture' } });
    expect(find(report, 'credentials.planning')).toMatchObject({
      status: 'valid', details: { provider: 'anthropic', pinned: true, source: 'env:ANTHROPIC_API_KEY' },
    });
    for (const code of ['credentials.coding', 'credentials.qa']) {
      expect(find(report, code), code).toMatchObject({ status: 'unavailable', blocking: true, details: { provider: 'openai' } });
      expect(find(report, code).guidance).toContain('OPENAI_API_KEY');
    }
    expect(report.ok).toBe(false);
  });

  it('marks an openai oauth account with an existing Codex token file as unverified', async () => {
    const root = makeRepo();
    makeSpec(root, '001-codex', { phaseProviders: { planning: 'openai', coding: 'openai', qa: 'openai' } });
    const codexTokenFilePath = path.join(tempDir('preflight-codex-'), 'tokens.json');
    writeFileSync(codexTokenFilePath, '{}');
    const configPath = writeConfig({
      providerAccounts: [{ id: 'codex', provider: 'openai', authType: 'oauth' }], codexTokenFilePath,
    });
    const report = await preflight({ projectPath: root, spec: '001-codex', configPath });
    for (const code of PHASES) {
      expect(find(report, code), code).toMatchObject({ status: 'unverified', blocking: false, details: { source: 'account:codex' } });
    }
    expect(report.ok).toBe(true);
  });

  it('marks an anthropic oauth account with a Claude profile as unverified', async () => {
    const root = makeRepo();
    makeSpec(root, '001-claude', { phaseProviders: { planning: 'anthropic', coding: 'anthropic', qa: 'anthropic' } });
    const configPath = writeConfig({
      providerAccounts: [{ id: 'claude', provider: 'anthropic', authType: 'oauth', claudeProfileId: 'profile-1' }],
    });
    const report = await preflight({ projectPath: root, spec: '001-claude', configPath });
    for (const code of PHASES) {
      expect(find(report, code), code).toMatchObject({ status: 'unverified', blocking: false, details: { source: 'account:claude' } });
    }
    expect(report.ok).toBe(true);
  });

  it('does not fall back to env credentials when the pinned provider has accounts', async () => {
    const root = makeRepo();
    makeSpec(root, '001-noenv', { phaseProviders: { planning: 'openai', coding: 'openai', qa: 'openai' } });
    // An oauth account with no Codex token file is not usable, and it still blocks the env fallback.
    const configPath = writeConfig({ providerAccounts: [{ id: 'codex', provider: 'openai', authType: 'oauth' }] });
    const report = await preflight({
      projectPath: root, spec: '001-noenv', configPath, env: { OPENAI_API_KEY: 'sk-openai-fixture' },
    });
    for (const code of PHASES) {
      expect(find(report, code), code).toMatchObject({ status: 'unavailable', blocking: true, details: { source: 'none' } });
      expect(find(report, code).guidance).toContain('remove those accounts');
    }
    expect(report.ok).toBe(false);
  });

  it('always reports credentials.remote as unverified and non-blocking', async () => {
    for (const env of [{}, { ANTHROPIC_API_KEY: 'sk-ant-fixture' }]) {
      const report = await preflight({ projectPath: makeRepo(), env });
      expect(find(report, 'credentials.remote')).toMatchObject({ status: 'unverified', blocking: false });
    }
  });

  it('checks credentials.default without a spec and skips the per-phase checks', async () => {
    const missing = await preflight({ projectPath: makeRepo() });
    expect(find(missing, 'credentials.default')).toMatchObject({ status: 'unavailable', blocking: true });
    expect(missing.ok).toBe(false);

    const report = await preflight({ projectPath: makeRepo(), env: { ANTHROPIC_API_KEY: 'sk-ant-fixture' } });
    expect(find(report, 'credentials.default')).toMatchObject({
      status: 'valid', blocking: false, details: { phase: 'default', source: 'env:ANTHROPIC_API_KEY' },
    });
    for (const code of PHASES) expect(find(report, code).status, code).toBe('not_applicable');
    expect(find(report, 'spec.found').status).toBe('not_applicable');
    expect(report.spec).toBeNull();
    expect(report.ok).toBe(true);
    expectCodesUnique(report);
  });

  it('redacts credential values that appear in the report', async () => {
    const key = 'sk-ant-SECRET-fixture-value';
    const root = makeRepo();
    makeSpec(root, '001-redact', { phaseProviders: { planning: 'anthropic' }, phaseModels: { planning: `m ${key}` } });
    const report = await preflight({ projectPath: root, spec: '001-redact', env: { ANTHROPIC_API_KEY: key } });
    expect(JSON.stringify(report)).not.toContain(key);
    expect(find(report, 'credentials.planning').details?.model).toBe('m [REDACTED]');
  });
});

describe('runPreflight: report shape and rendering', () => {
  it('lists every code exactly once, in the declared order', async () => {
    const root = makeRepo();
    makeSpec(root, '001-x', { tokenBudget: 1000 });
    const report = await preflight({ projectPath: root, spec: '001-x', daemon: true });
    expect(report.version).toBe(1);
    expect(report.checks.map((check) => check.code)).toEqual([...PREFLIGHT_CHECK_CODES]);
    expectCodesUnique(report);
  });

  it('ends the text output with READY when nothing blocks', async () => {
    const report = await preflight({ projectPath: makeRepo(), env: { ANTHROPIC_API_KEY: 'sk-ant-fixture' } });
    expect(report.ok).toBe(true);
    const text = renderPreflightText(report);
    expect(text.endsWith('\nREADY\n')).toBe(true);
    expect(text).toContain('[ok] git.repository');
    expect(text).toContain('[skip] spec.found');
  });

  it('ends the text output with NOT READY and the count when something blocks', async () => {
    const report = await preflight({ projectPath: makeRepo(), baseBranch: 'nope' });
    const blocking = report.checks.filter((check) => check.status === 'unavailable' && check.blocking).length;
    expect(blocking).toBeGreaterThan(0);
    const text = renderPreflightText(report);
    expect(text.endsWith(`NOT READY: ${blocking} blocking problem(s)\n`)).toBe(true);
    expect(text).toContain('[FAIL] git.base_ref');
    expect(text).toContain('    -> ');
  });

  it('renders JSON as one line that parses back to the report', async () => {
    const root = makeRepo();
    makeSpec(root, '001-x');
    const report = await preflight({ projectPath: root, spec: '001-x' });
    const json = renderPreflightJson(report);
    expect(json.endsWith('\n')).toBe(true);
    expect(json.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(json)).toEqual(report);
  });
});
