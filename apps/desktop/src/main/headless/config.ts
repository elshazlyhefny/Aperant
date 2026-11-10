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
import type { SerializableSessionConfig } from '../ai/agent/types';

export interface HeadlessProjectConfig {
  mainBranch?: string;
  pushNewBranches?: boolean;
  envPassthrough?: unknown;
  bashSandbox?: unknown;
}

export interface HeadlessConfig {
  providerAccounts?: ProviderAccount[];
  globalPriorityOrder?: string[];
  providerAgentConfig?: Record<string, unknown>;
  project?: HeadlessProjectConfig;
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
  prOnlyLanding: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    const { mainBranch, pushNewBranches, envPassthrough, bashSandbox } = raw.project;
    if (mainBranch !== undefined && typeof mainBranch !== 'string') {
      throw new Error(`Config file ${configPath}: project.mainBranch must be a string`);
    }
    if (pushNewBranches !== undefined && typeof pushNewBranches !== 'boolean') {
      throw new Error(`Config file ${configPath}: project.pushNewBranches must be a boolean`);
    }
    config.project = { mainBranch, pushNewBranches, envPassthrough, bashSandbox };
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
