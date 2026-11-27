/** zeenha fork: check headless readiness locally, without starting a run or taking a queue lock. */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import path from 'node:path';

import { resolveTaskTokenBudget } from '../ai/agent/task-session';
import { PROVIDER_ENV_VARS } from '../ai/auth/types';
import { parseSandboxMode, RESTRICTED_RIGHTS_WINDOWS_ONLY } from '../ai/security/sandbox';
import { deriveSandboxStatus, getSandboxAvailability } from '../ai/security/sandbox-status';
import { WINDOWS_HOME_HIDDEN_REFUSAL } from '../ai/security/sandbox-windows';
import { parseWebFetchProvider } from '../ai/tools/providers/types';
import { readProjectRepoConfig } from '../ai/worktree/project-repo-config';
import {
  formatLockHolder,
  getQueueLockPath,
  isQueueLockHolderStale,
  isQueueLockPidAlive,
  readLockHolder
} from '../utils/project-queue-lock';
import { type HeadlessConfig, loadHeadlessConfig } from './config';
import { checkPhaseCredentials, PREFLIGHT_SPEC_PHASES } from './preflight-credentials';
import { resolveHeadlessSpec } from './shared';
import { resolveHeadlessWebhook, resolveServeWebhookSettings } from './webhook';

export const PREFLIGHT_CHECK_CODES = [
  'git.repository',
  'git.commit',
  'git.base_ref',
  'config.file',
  'config.values',
  'config.webhook',
  'sandbox.tools',
  'queue.owner',
  'spec.found',
  'spec.metadata',
  'budget.effective',
  'credentials.default',
  'credentials.planning',
  'credentials.coding',
  'credentials.qa',
  'credentials.remote'
] as const;

export type PreflightCheckCode = (typeof PREFLIGHT_CHECK_CODES)[number];
export type PreflightStatus = 'valid' | 'unavailable' | 'unverified' | 'warning' | 'not_applicable';

export interface PreflightCheck {
  code: PreflightCheckCode;
  status: PreflightStatus;
  blocking: boolean;
  message: string;
  guidance?: string;
  details?: Record<string, string | number | boolean | null>;
}

export interface PreflightReport {
  version: 1;
  ok: boolean;
  mode: 'run' | 'daemon';
  project: string | null;
  spec: string | null;
  checks: PreflightCheck[];
}

export interface PreflightOptions {
  projectPath?: string;
  spec?: string;
  configPath?: string;
  baseBranch?: string;
  daemon?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  hostname?: string;
  isPidAlive?: (pid: number) => boolean;
  findTool?: (name: string) => string | null;
  platformName?: 'linux' | 'darwin' | 'win32';
}

const CONFIG_UNREADABLE = 'config could not be read';
const NO_REPOSITORY = 'No Git repository was found';

function revParse(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string | null {
  try {
    return execFileSync('git', ['rev-parse', ...args], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        ...env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        // Commit peeling must not fetch missing objects in a partial clone.
        GIT_NO_LAZY_FETCH: '1',
        GIT_ALLOW_PROTOCOL: ''
      }
    }).trim() || null;
  } catch {
    return null;
  }
}

function skip(code: PreflightCheckCode, message: string): PreflightCheck {
  return { code, status: 'not_applicable', blocking: false, message };
}

function checkBaseRef(
  root: string | null, baseBranch: string | undefined, config: HeadlessConfig | undefined, env: NodeJS.ProcessEnv
): PreflightCheck {
  const code = 'git.base_ref';
  if (!root) return skip(code, NO_REPOSITORY);

  // Keep the precedence in sync with resolveProjectSettings.
  const repoBase = baseBranch ? undefined : readProjectRepoConfig(root).baseBranch;
  if (!baseBranch && !repoBase && !config) return skip(code, CONFIG_UNREADABLE);
  const configBase = config?.project?.mainBranch;
  const base = baseBranch || repoBase || configBase || 'main';
  const source = baseBranch ? 'flag' : repoBase ? '.aperant.json' : configBase ? 'config' : 'default';
  let ref: string | null = null;
  // A base is a ref name, not a revision expression such as main~1.
  if (!/[~^:]|@\{/.test(base)) {
    if (revParse(root, env, '--verify', '--quiet', `refs/remotes/origin/${base}^{commit}`)) {
      ref = `origin/${base}`;
    } else if (revParse(root, env, '--verify', '--quiet', `refs/heads/${base}^{commit}`)) {
      ref = base;
    }
  }
  if (!ref) {
    return {
      code, status: 'unavailable', blocking: true,
      message: `No local or origin-tracking ref for base branch ${base}`,
      guidance: 'Fetch the base branch (e.g. use fetch-depth: 0 with actions/checkout) or pass --base-branch.',
      details: { base, source, ref }
    };
  }
  return {
    code, status: 'valid', blocking: false,
    message: `Found ${ref} locally; run prefers origin/${base} after fetching`,
    details: { base, source, ref }
  };
}

function safeConfigError(error: unknown, configPath: string | undefined): string {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = `Cannot read config file ${configPath}: `;
  if (!message.startsWith(prefix)) return message; // Schema errors name the field, not its value.

  // The loader wraps both read and parse errors. JSON.parse may quote raw config,
  // including partial secrets we can't extract from an invalid document.
  const reason = message.slice(prefix.length);
  const ioError = /^(?:E[A-Z0-9]+: |The argument 'path' )/.test(reason);
  return ioError ? message : `${prefix}invalid JSON`;
}

function checkConfigValues(config: HeadlessConfig, mode: ReturnType<typeof parseSandboxMode>): PreflightCheck {
  const code = 'config.values';
  const { bashSandbox, webFetchProvider } = config.project ?? {};
  const warnings: string[] = [];
  if (bashSandbox !== undefined && bashSandbox !== mode) warnings.push('unknown bashSandbox; using off');
  if (webFetchProvider !== undefined && webFetchProvider !== parseWebFetchProvider(webFetchProvider)) {
    warnings.push('unknown webFetchProvider; using jina');
  }
  return warnings.length
    ? { code, status: 'warning', blocking: false, message: warnings.join('; ') }
    : { code, status: 'valid', blocking: false, message: 'Project config values are recognized' };
}

function checkWebhook(config: HeadlessConfig, env: NodeJS.ProcessEnv, daemon: boolean): PreflightCheck {
  const code = 'config.webhook';
  const guidance = 'Configure a valid HTTPS webhook URL or remove the URL.';
  if (daemon) {
    try {
      const { enabled, secret } = resolveServeWebhookSettings(config);
      return enabled
        ? {
            code, status: 'valid', blocking: false, message: 'Daemon webhook configured',
            details: { configured: true, source: 'config', signed: Boolean(secret) }
          }
        : skip(code, 'Daemon webhook is disabled');
    } catch (error) {
      return { code, status: 'unavailable', blocking: true, message: (error as Error).message, guidance };
    }
  }
  const webhook = resolveHeadlessWebhook(config, env);
  if (!webhook) return skip(code, 'No run webhook configured');
  if ('warning' in webhook) return { code, status: 'warning', blocking: false, message: webhook.warning, guidance };
  return {
    code, status: 'valid', blocking: false, message: 'Run webhook configured',
    details: { configured: true, source: env.APERANT_WEBHOOK_URL?.trim() ? 'env' : 'config', signed: Boolean(webhook.secret) }
  };
}

function checkSandbox(mode: ReturnType<typeof parseSandboxMode>, options: PreflightOptions): PreflightCheck {
  const code = 'sandbox.tools';
  if (mode === 'off') return { code, status: 'valid', blocking: false, message: 'Bash sandbox is off' };
  const availability = getSandboxAvailability({ find: options.findTool, platformName: options.platformName });
  const status = deriveSandboxStatus(availability, mode);
  const { tool, installHint, unsupportedModes } = availability;
  const details = { mode, tool };
  if (status === 'active') {
    return { code, status: 'valid', blocking: false, message: `Found ${tool} for Bash sandbox mode ${mode}`, details };
  }

  // A tool install can't fix a mode that the OS doesn't support.
  const modeUnsupported = unsupportedModes?.includes(mode);
  let guidance = 'Choose a Bash sandbox mode supported on this OS.';
  if (modeUnsupported) {
    guidance = mode === 'restricted-rights' ? RESTRICTED_RIGHTS_WINDOWS_ONLY : WINDOWS_HOME_HIDDEN_REFUSAL;
  } else if (status === 'tool-missing') {
    guidance = `Install ${installHint ?? tool} so it can be found on this system.`;
  }
  return {
    code, status: 'unavailable', blocking: true,
    message: `Bash sandbox mode ${mode} is unavailable (${modeUnsupported ? 'mode-unsupported' : status}); Bash commands will be refused`,
    guidance, details
  };
}

function checkQueueOwner(root: string | null, options: PreflightOptions): PreflightCheck {
  const code = 'queue.owner';
  if (!options.daemon) return skip(code, 'Only serve needs to own the queue');
  if (!root) return skip(code, NO_REPOSITORY);
  const holder = readLockHolder(root);
  if (!holder) {
    return existsSync(getQueueLockPath(root))
      ? { code, status: 'warning', blocking: false, message: 'Queue lock file exists but could not be read or parsed' }
      : { code, status: 'valid', blocking: false, message: 'No queue owner found' };
  }
  const stale = isQueueLockHolderStale(holder, {
    now: options.now ?? Date.now,
    hostname: options.hostname ?? osHostname(),
    isPidAlive: options.isPidAlive ?? isQueueLockPidAlive
  });
  return stale
    ? { code, status: 'warning', blocking: false, message: `Queue lock from ${formatLockHolder(holder)} is stale; serve will take it over` }
    : {
        code, status: 'unavailable', blocking: true, message: `Queue is held by ${formatLockHolder(holder)}`,
        guidance: "Serve would exit 3. Stop this project's queue in the desktop app or stop the other daemon first."
      };
}

export function createPreflightRedactor(secrets: string[]): (text: string) => string {
  const literals = [...new Set(secrets.filter((secret) => secret.length >= 4))]
    .sort((a, b) => b.length - a.length)
    .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const secretPattern = literals.length ? new RegExp(literals.join('|'), 'g') : null;
  return (text) => {
    // Mask URLs before any secret substring can break the URL pattern.
    const withoutUrls = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]');
    return secretPattern ? withoutUrls.replace(secretPattern, '[REDACTED]') : withoutUrls;
  };
}

function preflightSecrets(config: HeadlessConfig | undefined, env: NodeJS.ProcessEnv): string[] {
  const names = [...Object.values(PROVIDER_ENV_VARS), 'CLAUDE_CODE_OAUTH_TOKEN', 'APERANT_WEBHOOK_URL', 'APERANT_WEBHOOK_SECRET'];
  return [
    ...names.flatMap((name) => name ? [env[name]] : []),
    ...(config?.providerAccounts ?? []).map((account) => account?.apiKey),
    config?.webhook?.url,
    config?.webhook?.secret
  ].flatMap((value) => typeof value === 'string' ? [value, value.trim()] : []);
}

function isBlocking(check: PreflightCheck): boolean {
  return check.status === 'unavailable' && check.blocking;
}

function checkSpec(root: string, spec: string): { check: PreflightCheck; specId: string; specDir?: string } {
  const code = 'spec.found';
  const specId = path.basename(spec);
  let resolved: ReturnType<typeof resolveHeadlessSpec>;
  try {
    resolved = resolveHeadlessSpec(root, spec);
  } catch (error) {
    return {
      specId,
      check: { code, status: 'unavailable', blocking: true, message: (error as Error).message, details: { specId } }
    };
  }

  const specFile = path.join(resolved.specDir, 'spec.md');
  try {
    if (statSync(specFile).isFile()) {
      return {
        ...resolved,
        check: {
          code, status: 'valid', blocking: false, message: `Found ${specFile}`, details: { specId: resolved.specId }
        }
      };
    }
  } catch {
    // The spec directory or file is missing or inaccessible.
  }
  return {
    specId: resolved.specId,
    check: {
      code, status: 'unavailable', blocking: true, message: `Spec not found: ${specFile} does not exist`,
      details: { specId: resolved.specId }
    }
  };
}

function checkSpecMetadata(specDir: string): { check: PreflightCheck; hasBudget: boolean } {
  const code = 'spec.metadata';
  try {
    const metadata = JSON.parse(readFileSync(path.join(specDir, 'task_metadata.json'), 'utf-8'));
    return {
      check: { code, status: 'valid', blocking: false, message: 'Loaded task_metadata.json' },
      hasBudget: metadata !== null && Object.hasOwn(metadata, 'tokenBudget')
    };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    // Don't include parse errors: they may quote arbitrary contents of the file.
    return {
      check: missing
        ? { code, status: 'valid', blocking: false, message: 'No task_metadata.json; using defaults' }
        : { code, status: 'warning', blocking: false, message: 'Cannot read or parse task_metadata.json; using defaults' },
      hasBudget: false
    };
  }
}

function checkBudget(specDir: string, hasBudget: boolean): PreflightCheck {
  const code = 'budget.effective';
  const tokenBudget = resolveTaskTokenBudget(specDir);
  if (tokenBudget !== undefined) {
    return {
      code, status: 'valid', blocking: false, message: `${tokenBudget} tokens`,
      details: { tokenBudget, source: 'task_metadata.json' }
    };
  }
  return {
    code, status: hasBudget ? 'warning' : 'valid', blocking: false,
    message: hasBudget
      ? 'unlimited (tokenBudget in task_metadata.json does not resolve to a positive limit)'
      : 'unlimited (no tokenBudget in task_metadata.json; the CLI has no project default)',
    details: { tokenBudget: null }
  };
}

export async function runPreflight(options: PreflightOptions): Promise<PreflightReport> {
  const env = options.env ?? process.env;
  const start = path.resolve(options.projectPath ?? process.cwd());
  const root = revParse(start, env, '--show-toplevel');
  const checks: PreflightCheck[] = [root
    ? { code: 'git.repository', status: 'valid', blocking: false, message: `Git repository at ${root}` }
    : {
        code: 'git.repository', status: 'unavailable', blocking: true,
        message: `${start} is not inside a Git repository`, guidance: 'pass --project or run from the repository'
      }];
  checks.push(!root
    ? skip('git.commit', NO_REPOSITORY)
    : revParse(root, env, '--verify', '--quiet', 'HEAD^{commit}')
      ? { code: 'git.commit', status: 'valid', blocking: false, message: 'HEAD resolves to a commit' }
      : {
          code: 'git.commit', status: 'unavailable', blocking: true, message: 'HEAD does not resolve to a commit',
          guidance: 'Check out an existing commit or create the first commit.'
        });

  let config: HeadlessConfig | undefined;
  let configFile: PreflightCheck;
  try {
    config = loadHeadlessConfig(options.configPath);
    configFile = {
      code: 'config.file', status: 'valid', blocking: false,
      message: options.configPath ? `Loaded config file ${options.configPath}` : 'No config file specified; using defaults'
    };
  } catch (error) {
    configFile = { code: 'config.file', status: 'unavailable', blocking: true, message: safeConfigError(error, options.configPath) };
  }
  checks.push(checkBaseRef(root, options.baseBranch, config, env), configFile);
  if (config) {
    const mode = parseSandboxMode(config.project?.bashSandbox);
    checks.push(checkConfigValues(config, mode), checkWebhook(config, env, Boolean(options.daemon)), checkSandbox(mode, options));
  } else {
    for (const code of ['config.values', 'config.webhook', 'sandbox.tools'] as const) {
      checks.push(skip(code, CONFIG_UNREADABLE));
    }
  }
  checks.push(checkQueueOwner(root, options));

  const specRequested = options.spec !== undefined;
  const spec = root && options.spec !== undefined ? checkSpec(root, options.spec) : null;
  const specDir = spec?.specDir;
  const specSkipReason = specRequested ? (root ? 'Spec not found' : NO_REPOSITORY) : 'No spec supplied';
  checks.push(spec?.check ?? skip('spec.found', specSkipReason));
  if (specDir) {
    const metadata = checkSpecMetadata(specDir);
    checks.push(metadata.check, checkBudget(specDir, metadata.hasBudget));
  } else {
    checks.push(skip('spec.metadata', specSkipReason), skip('budget.effective', specSkipReason));
  }

  checks.push(!config
    ? skip('credentials.default', CONFIG_UNREADABLE)
    : specRequested
      ? skip('credentials.default', 'Only checked without a spec')
      : await checkPhaseCredentials({ phase: 'default', config, env }));
  for (const phase of PREFLIGHT_SPEC_PHASES) {
    checks.push(config && specDir
      ? await checkPhaseCredentials({ phase, specDir, config, env })
      : skip(`credentials.${phase}`, config ? specSkipReason : CONFIG_UNREADABLE));
  }
  checks.push(config
    ? {
        code: 'credentials.remote', status: 'unverified', blocking: false,
        message: 'Token validity, scopes and quotas are not checked: confirming them needs a request to the provider.'
      }
    : skip('credentials.remote', CONFIG_UNREADABLE));

  const redact = createPreflightRedactor(preflightSecrets(config, env));
  return {
    version: 1,
    ok: !checks.some(isBlocking),
    mode: options.daemon ? 'daemon' : 'run',
    project: root && redact(root),
    spec: spec ? redact(spec.specId) : null,
    checks: checks.map(({ message, guidance, details, ...check }) => ({
      ...check,
      message: redact(message),
      ...(guidance === undefined ? {} : { guidance: redact(guidance) }),
      ...(details === undefined ? {} : {
        details: Object.fromEntries(
          Object.entries(details).map(([key, value]) => [key, typeof value === 'string' ? redact(value) : value])
        )
      })
    }))
  };
}

const TEXT_LABELS: Record<PreflightStatus, string> = {
  valid: 'ok', unavailable: 'FAIL', unverified: 'unverified', warning: 'warn', not_applicable: 'skip'
};

export function renderPreflightText(report: PreflightReport): string {
  const oneLine = (text: string) => text.replace(/[\r\n]+/g, ' ');
  const lines = report.checks.flatMap(({ code, status, message, guidance }) => [
    `[${TEXT_LABELS[status]}] ${code}  ${oneLine(message)}`,
    ...(guidance ? [`    -> ${oneLine(guidance)}`] : [])
  ]);
  const failures = report.checks.filter(isBlocking).length;
  lines.push(failures ? `NOT READY: ${failures} blocking problem(s)` : 'READY');
  return `${lines.join('\n')}\n`;
}

export function renderPreflightJson(report: PreflightReport): string {
  return `${JSON.stringify(report)}\n`;
}
