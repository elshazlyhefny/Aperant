/**
 * Project MCP settings → worker MCP options.
 * ===========================================
 *
 * zeenha fork: upstream's "MCP Server Overview" page wrote its toggles,
 * per-agent overrides and custom servers to `<project>/<autoBuildPath>/.env`,
 * but the agent manager never read them back: every session got a hardcoded
 * `{ context7Enabled: true, memoryEnabled, linearEnabled }`, so turning
 * Context7 off, enabling a browser server or adding a custom server changed
 * nothing an agent could see. This module is the ONE reader of those keys on
 * the agent path; it mirrors the parsing in `ipc-handlers/env-handlers.ts`.
 *
 * Plain fs + a local parser only: it runs in the main process but must not
 * import electron, so it stays unit-testable.
 */

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import type { CustomMcpServerDefinition } from './types';
import { checkMcpCommand } from './command-policy';
import type { McpServerResolveOptions } from '../config/agent-configs';

export interface ProjectMcpOptions {
  context7Enabled: boolean;
  electronMcpEnabled: boolean;
  chromeDevtoolsMcpEnabled: boolean;
  /** Absolute path of the Chrome binary the browser server launches */
  chromeDevtoolsExecutable?: string;
  /** Expose pages' WebMCP tools (Chrome 150+) */
  chromeDevtoolsWebmcp: boolean;
  /**
   * http:// development origins the QA browser treats as secure contexts, so
   * APIs gated on one (WebMCP, WebAuthn) exist on a plain-http dev domain.
   */
  chromeDevtoolsSecureOrigins?: string[];
  /** Keyed by agent type, e.g. `qa_reviewer` → { add: ['chrome-devtools'] } */
  agentMcpOverrides?: Record<string, { add?: string[]; remove?: string[] }>;
  customServers?: CustomMcpServerDefinition[];
}

function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function isValidCustomServer(s: unknown): s is CustomMcpServerDefinition {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  if (typeof o.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(o.id)) return false;
  if (o.type === 'command') {
    if (typeof o.command !== 'string' || o.command.length === 0) return false;
    if (o.args !== undefined && !(Array.isArray(o.args) && o.args.every((a) => typeof a === 'string'))) return false;
    // The same rule the settings page's checks apply (command-policy.ts).
    return checkMcpCommand(o.command, o.args as string[] | undefined).ok;
  }
  if (o.type === 'http') {
    if (typeof o.url !== 'string') return false;
    try {
      const u = new URL(o.url);
      return u.protocol === 'https:' || u.protocol === 'http:';
    } catch {
      return false;
    }
  }
  return false;
}

const VAR_REF = /\$\{([A-Z][A-Z0-9_]*)\}/g;

/**
 * zeenha fork: `${NAME}` in a custom server's args or headers is replaced with
 * NAME from the SAME project .env, so a secret (e.g. GITHUB_TOKEN) is written
 * once instead of copied into the server's JSON. Only this file's variables are
 * read, never the app's process environment. A reference to a variable that is
 * missing or empty drops the server: sending `Bearer ` with no token, or
 * launching with a blank argument, is worse than not starting it.
 */
function expandServerVars(
  server: CustomMcpServerDefinition,
  vars: Record<string, string>,
): CustomMcpServerDefinition | null {
  let missing = false;
  const expand = (value: string): string =>
    value.replace(VAR_REF, (_, name: string) => {
      const v = vars[name];
      if (!v) missing = true;
      return v ?? '';
    });
  const out: CustomMcpServerDefinition = { ...server };
  if (server.args) out.args = server.args.map(expand);
  if (server.headers) {
    out.headers = Object.fromEntries(Object.entries(server.headers).map(([k, v]) => [k, expand(String(v))]));
  }
  return missing ? null : out;
}

/**
 * Only bare `http://host[:port]` origins, at most 32. Chrome's switch takes an
 * explicit comma-separated list (it ignores wildcards, measured on Chrome 155),
 * and anything else here would become part of a browser launch argument.
 */
const HTTP_ORIGIN = /^http:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

export function parseSecureOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  const origins = raw
    .split(',')
    .map((o) => o.trim().toLowerCase().replace(/\/+$/, ''))
    .filter((o) => HTTP_ORIGIN.test(o));
  return [...new Set(origins)].slice(0, 32);
}

/** Parse the MCP keys out of a project .env file's text. Exported for tests. */
export function parseProjectMcpOptions(content: string): ProjectMcpOptions {
  const vars = parseEnv(content);
  const options: ProjectMcpOptions = {
    context7Enabled: vars.CONTEXT7_ENABLED?.toLowerCase() !== 'false',
    electronMcpEnabled: vars.ELECTRON_MCP_ENABLED?.toLowerCase() === 'true',
    chromeDevtoolsMcpEnabled: vars.CHROME_DEVTOOLS_MCP_ENABLED?.toLowerCase() === 'true',
    chromeDevtoolsWebmcp: vars.CHROME_DEVTOOLS_WEBMCP?.toLowerCase() === 'true',
  };
  // An absolute path only: this becomes a process argument, and a relative
  // one would resolve against whichever worktree the agent runs in.
  const exe = vars.CHROME_DEVTOOLS_EXECUTABLE?.trim();
  if (exe && path.isAbsolute(exe)) options.chromeDevtoolsExecutable = exe;
  const secure = parseSecureOrigins(vars.CHROME_DEVTOOLS_SECURE_ORIGINS);
  if (secure.length > 0) options.chromeDevtoolsSecureOrigins = secure;

  const overrides: Record<string, { add?: string[]; remove?: string[] }> = {};
  for (const [key, value] of Object.entries(vars)) {
    const m = /^AGENT_MCP_(.+)_(ADD|REMOVE)$/.exec(key);
    if (!m) continue;
    const list = value.split(',').map((s) => s.trim()).filter(Boolean);
    const entry = overrides[m[1]] ?? {};
    overrides[m[1]] = entry;
    if (m[2] === 'ADD') entry.add = list;
    else entry.remove = list;
  }
  if (Object.keys(overrides).length > 0) options.agentMcpOverrides = overrides;

  if (vars.CUSTOM_MCP_SERVERS) {
    try {
      const parsed: unknown = JSON.parse(vars.CUSTOM_MCP_SERVERS);
      if (Array.isArray(parsed)) {
        const valid = parsed
          .filter(isValidCustomServer)
          .map((server) => expandServerVars(server, vars))
          .filter((server): server is CustomMcpServerDefinition => server !== null);
        if (valid.length > 0) options.customServers = valid;
      }
    } catch {
      // Invalid JSON: the settings page shows the same file as "no custom servers".
    }
  }

  return options;
}

/**
 * Read a project's MCP settings. Missing or unreadable file → upstream defaults
 * (Context7 on, browsers off, nothing custom).
 */
export function readProjectMcpOptions(projectPath: string, autoBuildPath = '.auto-claude'): ProjectMcpOptions {
  const envPath = path.join(projectPath, autoBuildPath, '.env');
  if (!existsSync(envPath)) return parseProjectMcpOptions('');
  try {
    return parseProjectMcpOptions(readFileSync(envPath, 'utf-8'));
  } catch {
    return parseProjectMcpOptions('');
  }
}

/** The worker's serialized MCP options (SerializableSessionConfig['mcpOptions']). */
export interface WorkerMcpOptions {
  context7Enabled?: boolean;
  memoryEnabled?: boolean;
  electronMcpEnabled?: boolean;
  chromeDevtoolsMcpEnabled?: boolean;
  projectCapabilities?: { is_electron?: boolean; is_web_frontend?: boolean };
  agentMcpAdd?: string;
  agentMcpRemove?: string;
  agentMcpOverrides?: Record<string, { add?: string[]; remove?: string[] }>;
}

/**
 * Resolution options for ONE agent type: that agent's own AGENT_MCP_<agent>_*
 * override wins over the session-wide add/remove strings.
 */
export function mcpResolveOptionsForAgent(
  o: WorkerMcpOptions | undefined,
  agentType: string,
): McpServerResolveOptions {
  const override = o?.agentMcpOverrides?.[agentType];
  return {
    context7Enabled: o?.context7Enabled ?? true,
    memoryEnabled: o?.memoryEnabled ?? false,
    electronMcpEnabled: o?.electronMcpEnabled ?? false,
    chromeDevtoolsMcpEnabled: o?.chromeDevtoolsMcpEnabled ?? false,
    projectCapabilities: o?.projectCapabilities,
    agentMcpAdd: override?.add?.join(',') ?? o?.agentMcpAdd,
    agentMcpRemove: override?.remove?.join(',') ?? o?.agentMcpRemove,
  };
}
