/**
 * zeenha fork: keep a development instance away from the installed app.
 *
 * Aperant develops itself, so its QA agents start this app from a task
 * worktree while the installed app is running the build. Without this module
 * both use ~/.config/aperant and the same terminal daemon socket, so a dev run
 * would read and rewrite the real settings, projects and memory database.
 *
 * index.ts imports this before anything else that touches userData, because
 * several modules read app.getPath('userData') while they load.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { isWindows } from './platform';

/** Inside the checkout, so removing a task worktree removes its data too. */
export const DEV_USER_DATA_DIR = '.dev-user-data';

export interface DevInstancePaths {
  userData: string;
  ptySocket: string;
}

export function devInstancePaths(
  appPath: string,
  env: NodeJS.ProcessEnv = process.env,
): DevInstancePaths {
  // A Unix socket path is limited to about 100 characters and worktree paths
  // are long, so the socket is named after a hash of the checkout.
  const key = createHash('sha1').update(appPath).digest('hex').slice(0, 10);
  const uid = process.getuid?.() ?? 'default';
  return {
    userData: env.APERANT_DEV_USER_DATA?.trim() || join(appPath, DEV_USER_DATA_DIR),
    ptySocket: isWindows()
      ? `\\\\.\\pipe\\auto-claude-pty-${uid}-dev-${key}`
      : `/tmp/auto-claude-pty-${uid}-dev-${key}.sock`,
  };
}

/** Does nothing in a packaged app. Returns the paths it applied. */
export function isolateDevInstance(
  target: Pick<typeof app, 'isPackaged' | 'getAppPath' | 'setPath'> = app,
  env: NodeJS.ProcessEnv = process.env,
): DevInstancePaths | null {
  if (target.isPackaged) return null;

  const paths = devInstancePaths(target.getAppPath(), env);
  mkdirSync(paths.userData, { recursive: true });
  target.setPath('userData', paths.userData);
  env.APERANT_PTY_SOCKET = paths.ptySocket;

  // A new data folder would otherwise open on the onboarding wizard, which
  // covers the screens a QA agent came to test.
  const settingsPath = join(paths.userData, 'settings.json');
  if (!existsSync(settingsPath)) {
    writeFileSync(settingsPath, `${JSON.stringify({ onboardingCompleted: true }, null, 2)}\n`);
  }

  return paths;
}

isolateDevInstance();
