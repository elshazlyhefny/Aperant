/**
 * Which commands a project's custom MCP server may launch.
 * ===========================================================
 *
 * zeenha fork: the ONE rule, used by the agent path (project-settings.ts drops
 * a custom server it refuses) and by the settings page's checks
 * (ipc-handlers/mcp-handlers.ts). Upstream had it only in the page's checks,
 * so a server the page called "invalid" was still started for every agent.
 *
 * A custom server's command comes from the project's .auto-claude/.env, which
 * the settings page writes; this is defence in depth against a config that
 * reached that file some other way.
 *
 * `docker` is allowed only as `docker exec …`: running a tool inside a
 * container the developer already started (e.g. `php artisan boost:mcp` in
 * the app container). `docker run` is refused, because a new container can
 * mount the host's filesystem or run privileged, and so is `--privileged` on
 * exec.
 */

export const SAFE_MCP_COMMANDS: ReadonlySet<string> = new Set([
  'npx', 'npm', 'node', 'python', 'python3', 'uv', 'uvx', 'docker',
]);

/** Interpreter flags that turn an argument into code to run. */
export const DANGEROUS_MCP_FLAGS: ReadonlySet<string> = new Set([
  '--eval', '-e', '-c', '--exec',
  '-m', '-p', '--print',
  '--input-type=module', '--experimental-loader',
  '--require', '-r',
]);

/** Characters that matter when Windows launches through a shell. */
const SHELL_METACHARACTERS = ['&', '|', '>', '<', '^', '%', ';', '$', '`', '\n', '\r'];

export type McpCommandVerdict =
  | { ok: true }
  | { ok: false; reason: string };

export function checkMcpCommand(
  command: string | undefined,
  args: readonly string[] | undefined,
  windows = process.platform === 'win32',
): McpCommandVerdict {
  if (!command) return { ok: false, reason: 'No command configured' };
  if (command.includes('/') || command.includes('\\')) {
    return { ok: false, reason: `Invalid command '${command}' - use the command name, not a path` };
  }
  if (!SAFE_MCP_COMMANDS.has(command)) {
    return { ok: false, reason: `Invalid command '${command}' - not in allowlist` };
  }
  const list = args ?? [];
  if (command === 'docker') {
    if (list[0] !== 'exec') {
      return { ok: false, reason: "docker is allowed only as 'docker exec' into a running container" };
    }
    if (list.some((a) => a === '--privileged' || a.startsWith('--privileged='))) {
      return { ok: false, reason: "'docker exec --privileged' is not allowed" };
    }
  }
  if (list.some((a) => DANGEROUS_MCP_FLAGS.has(a))) {
    return { ok: false, reason: 'Args contain dangerous flags' };
  }
  if (windows && list.some((a) => SHELL_METACHARACTERS.some((c) => a.includes(c)))) {
    return { ok: false, reason: 'Args contain shell metacharacters' };
  }
  return { ok: true };
}
