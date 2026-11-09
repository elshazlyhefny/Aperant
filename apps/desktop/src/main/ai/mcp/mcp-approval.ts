/**
 * User approval of project-declared MCP launches.
 * ================================================
 *
 * zeenha fork: a project's `.auto-claude/.env` can be committed, so its custom
 * MCP servers and CHROME_DEVTOOLS_EXECUTABLE are UNTRUSTED input: a cloned
 * repository could make the app start `node tools/payload.js` for every agent.
 * Nothing declared there may launch until the user approved that exact
 * definition. Approvals are stored per project outside the repository (by the
 * IPC layer); this module only holds the pure, electron-free logic.
 */

import { createHash } from 'crypto';
import type { CustomMcpServerDefinition } from './types';

/** The approved set for ONE project. */
export type McpApprovals = {
  /** hashMcpServer() values of approved custom servers */
  servers: string[];
  /** Approved absolute Chrome executable paths */
  chromeExecutables: string[];
};

/**
 * sha256 over the launch-relevant fields of the EXPANDED definition (after
 * `${VAR}` substitution, so changing a referenced value changes the hash).
 * Headers are deliberately excluded: tokens rotate and do not change what is
 * launched; the url, which decides where they are sent, is hashed.
 */
export function hashMcpServer(def: CustomMcpServerDefinition): string {
  const canonical = JSON.stringify({
    id: def.id,
    type: def.type,
    command: def.command ?? null,
    args: def.args ?? null,
    url: def.url ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function isServerApproved(def: CustomMcpServerDefinition, approvals: McpApprovals | undefined): boolean {
  if (!approvals) return false;
  return approvals.servers.includes(hashMcpServer(def));
}

export function isChromeExecutableApproved(exe: string, approvals: McpApprovals | undefined): boolean {
  if (!approvals) return false;
  return approvals.chromeExecutables.includes(exe);
}
