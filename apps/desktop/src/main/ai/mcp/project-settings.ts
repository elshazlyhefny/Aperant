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

export interface ProjectMcpOptions {
  context7Enabled: boolean;
  linearMcpEnabled: boolean;
  electronMcpEnabled: boolean;
  puppeteerMcpEnabled: boolean;
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
    return typeof o.command === 'string' && o.command.length > 0
      && (o.args === undefined || (Array.isArray(o.args) && o.args.every((a) => typeof a === 'string')));
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

/** Parse the MCP keys out of a project .env file's text. Exported for tests. */
export function parseProjectMcpOptions(content: string): ProjectMcpOptions {
  const vars = parseEnv(content);
  const options: ProjectMcpOptions = {
    context7Enabled: vars.CONTEXT7_ENABLED?.toLowerCase() !== 'false',
    linearMcpEnabled: vars.LINEAR_MCP_ENABLED?.toLowerCase() !== 'false',
    electronMcpEnabled: vars.ELECTRON_MCP_ENABLED?.toLowerCase() === 'true',
    puppeteerMcpEnabled: vars.PUPPETEER_MCP_ENABLED?.toLowerCase() === 'true',
  };

  const overrides: Record<string, { add?: string[]; remove?: string[] }> = {};
  for (const [key, value] of Object.entries(vars)) {
    const m = /^AGENT_MCP_(.+)_(ADD|REMOVE)$/.exec(key);
    if (!m) continue;
    const list = value.split(',').map((s) => s.trim()).filter(Boolean);
    const entry = (overrides[m[1]] ??= {});
    if (m[2] === 'ADD') entry.add = list;
    else entry.remove = list;
  }
  if (Object.keys(overrides).length > 0) options.agentMcpOverrides = overrides;

  if (vars.CUSTOM_MCP_SERVERS) {
    try {
      const parsed: unknown = JSON.parse(vars.CUSTOM_MCP_SERVERS);
      if (Array.isArray(parsed)) {
        const valid = parsed.filter(isValidCustomServer);
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
