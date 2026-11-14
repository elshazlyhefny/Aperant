/**
 * zeenha fork: headless run configuration.
 *
 * Electron-free on purpose (the CLI runs without the app): no settings-utils,
 * project-store, claude-profile-manager, mcp-approval-store or app-logger here.
 * It never reads the installed app's userData/settings.json; a CI run gets its
 * settings from an explicit --config file, flags and the environment only.
 */

import { readFileSync } from 'node:fs';
import type { ProviderAccount } from '../../shared/types/provider-account';
import { readProjectRepoConfig } from '../ai/worktree/project-repo-config';
import { readApprovedProjectMcpOptions } from '../ai/mcp/project-settings';
import type { McpApprovals } from '../ai/mcp/mcp-approval';
import { parseEnvPassthrough } from '../ai/security/child-env';
import { parseSandboxMode } from '../ai/security/sandbox';
import { parseWebFetchProvider } from '../ai/tools/providers/types';
import type { SerializableSessionConfig } from '../ai/agent/types';
import { DEFAULT_APP_SETTINGS } from '../../shared/constants/config';
import type { WebhookSettings } from '../../shared/types/settings';
import { validateWebhookUrl } from '../webhook-core';

export interface HeadlessProjectConfig {
  mainBranch?: string;
  pushNewBranches?: boolean;
  envPassthrough?: unknown;
  bashSandbox?: unknown;
  webFetchProvider?: unknown;
  /** Daemon only: how many queued tasks may run at once. */
  maxParallelTasks?: number;
}

export interface HeadlessConfig {
  providerAccounts?: ProviderAccount[];
  globalPriorityOrder?: string[];
  providerAgentConfig?: Record<string, unknown>;
  project?: HeadlessProjectConfig;
  webhook?: WebhookSettings;
}

export interface HeadlessFlags {
  baseBranch?: string;
  /** --no-push */
  noPush?: boolean;
}

export interface HeadlessProjectSettings {
  baseBranch: string;
  pushNewBranches: boolean;
  envPassthrough: string[];
  bashSandbox: ReturnType<typeof parseSandboxMode>;
  webFetchProvider: ReturnType<typeof parseWebFetchProvider>;
  prOnlyLanding: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const WEBHOOK_EVENT_KEYS = ['reviewReady', 'failed', 'blocked', 'prOpened'] as const;

function parseWebhook(value: unknown, configPath: string): WebhookSettings {
  if (!isRecord(value)) {
    throw new Error(`Config file ${configPath}: webhook must be an object`);
  }
  const { enabled, url, events } = value;
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new Error(`Config file ${configPath}: webhook.enabled must be a boolean`);
  }
  if (url !== undefined && typeof url !== 'string') {
    throw new Error(`Config file ${configPath}: webhook.url must be a string`);
  }
  if (events !== undefined && !isRecord(events)) {
    throw new Error(`Config file ${configPath}: webhook.events must be an object`);
  }
  const mergedEvents = { ...DEFAULT_APP_SETTINGS.webhook.events };
  for (const key of WEBHOOK_EVENT_KEYS) {
    const flag = events?.[key];
    if (flag === undefined) continue;
    if (typeof flag !== 'boolean') {
      throw new Error(`Config file ${configPath}: webhook.events.${key} must be a boolean`);
    }
    mergedEvents[key] = flag;
  }
  const webhookUrl = url ?? DEFAULT_APP_SETTINGS.webhook.url;
  if (enabled === true || webhookUrl !== '') {
    const check = validateWebhookUrl(webhookUrl);
    if (!check.ok) {
      throw new Error(`Config file ${configPath}: webhook.url is not valid (${check.error})`);
    }
  }
  return { enabled: enabled === true, url: webhookUrl, events: mergedEvents };
}

/** Load the optional --config file. Missing path = defaults; a bad explicit file throws. */
export function loadHeadlessConfig(configPath?: string): HeadlessConfig {
  if (!configPath) return {};

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read config file ${configPath}: ${reason}`);
  }
  if (!isRecord(raw)) {
    throw new Error(`Config file ${configPath} must contain a JSON object`);
  }

  const config: HeadlessConfig = {};
  if (raw.providerAccounts !== undefined) {
    if (!Array.isArray(raw.providerAccounts)) {
      throw new Error(`Config file ${configPath}: providerAccounts must be an array`);
    }
    config.providerAccounts = raw.providerAccounts as ProviderAccount[];
  }
  if (raw.globalPriorityOrder !== undefined) {
    if (!Array.isArray(raw.globalPriorityOrder) || !raw.globalPriorityOrder.every((id) => typeof id === 'string')) {
      throw new Error(`Config file ${configPath}: globalPriorityOrder must be an array of account ids`);
    }
    config.globalPriorityOrder = raw.globalPriorityOrder as string[];
  }
  if (raw.providerAgentConfig !== undefined) {
    if (!isRecord(raw.providerAgentConfig)) {
      throw new Error(`Config file ${configPath}: providerAgentConfig must be an object`);
    }
    config.providerAgentConfig = raw.providerAgentConfig;
  }
  if (raw.project !== undefined) {
    if (!isRecord(raw.project)) {
      throw new Error(`Config file ${configPath}: project must be an object`);
    }
    const { mainBranch, pushNewBranches, envPassthrough, bashSandbox, webFetchProvider, maxParallelTasks } =
      raw.project;
    if (mainBranch !== undefined && typeof mainBranch !== 'string') {
      throw new Error(`Config file ${configPath}: project.mainBranch must be a string`);
    }
    if (pushNewBranches !== undefined && typeof pushNewBranches !== 'boolean') {
      throw new Error(`Config file ${configPath}: project.pushNewBranches must be a boolean`);
    }
    if (
      maxParallelTasks !== undefined &&
      (typeof maxParallelTasks !== 'number' || !Number.isInteger(maxParallelTasks) || maxParallelTasks < 1)
    ) {
      throw new Error(`Config file ${configPath}: project.maxParallelTasks must be a positive integer`);
    }
    config.project = { mainBranch, pushNewBranches, envPassthrough, bashSandbox, webFetchProvider, maxParallelTasks };
  }
  if (raw.webhook !== undefined) {
    config.webhook = parseWebhook(raw.webhook, configPath);
  }
  return config;
}

/** base branch: flag > .aperant.json > config > 'main'. */
export function resolveProjectSettings(
  projectPath: string,
  config: HeadlessConfig,
  flags: HeadlessFlags = {},
): HeadlessProjectSettings {
  const baseBranch =
    flags.baseBranch ||
    readProjectRepoConfig(projectPath).baseBranch ||
    config.project?.mainBranch ||
    'main';
  return {
    baseBranch,
    pushNewBranches: flags.noPush ? false : (config.project?.pushNewBranches ?? true),
    envPassthrough: parseEnvPassthrough(config.project?.envPassthrough),
    bashSandbox: parseSandboxMode(config.project?.bashSandbox),
    // zeenha fork: unknown or missing = 'jina'.
    webFetchProvider: parseWebFetchProvider(config.project?.webFetchProvider),
    // zeenha fork: headless work always lands through a pull request. There is
    // deliberately no flag or config key to switch this off.
    prOnlyLanding: true,
  };
}

// Nothing is approved headless, so repo-supplied custom MCP servers and Chrome
// executables stay off: a cloned repository must not start processes in CI.
const NO_APPROVALS: McpApprovals = { servers: [], chromeExecutables: [] };

/** Mirrors AgentManager.mcpOptionsForProject with an empty approvals object. */
export function mcpOptionsForHeadless(
  projectPath: string,
  autoBuildPath = '.auto-claude',
): NonNullable<SerializableSessionConfig['mcpOptions']> {
  const settings = readApprovedProjectMcpOptions(projectPath, autoBuildPath, NO_APPROVALS);
  return {
    context7Enabled: settings.context7Enabled,
    memoryEnabled: !!process.env.GRAPHITI_MCP_URL,
    electronMcpEnabled: settings.electronMcpEnabled,
    chromeDevtoolsMcpEnabled: settings.chromeDevtoolsMcpEnabled,
    chromeDevtoolsExecutable: settings.chromeDevtoolsExecutable,
    chromeDevtoolsWebmcp: settings.chromeDevtoolsWebmcp,
    chromeDevtoolsSecureOrigins: settings.chromeDevtoolsSecureOrigins,
    agentMcpOverrides: settings.agentMcpOverrides,
    customServers: settings.customServers,
  };
}
