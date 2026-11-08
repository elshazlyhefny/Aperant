import { isWindows } from '../platform';

/**
 * The socket shared by the PTY daemon and its client.
 *
 * zeenha fork: APERANT_PTY_SOCKET gives a development instance its own daemon
 * (see dev-instance-isolation.ts); the daemon inherits it from the client.
 */
export function getPtySocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const uid = process.getuid?.() || 'default';
  return (
    env.APERANT_PTY_SOCKET ||
    (isWindows() ? `\\\\.\\pipe\\auto-claude-pty-${uid}` : `/tmp/auto-claude-pty-${uid}.sock`)
  );
}
