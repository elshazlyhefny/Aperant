/**
 * zeenha fork: keep a development instance away from the installed app.
 *
 * Aperant develops itself, so its QA agents start this app from a task
 * worktree while the installed app is running the build. Without this module
 * both use ~/.config/aperant, so a dev run would read and rewrite the real
 * settings, projects and memory database.
 *
 * index.ts imports this before anything else that touches userData, because
 * several modules read app.getPath('userData') while they load.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/** Inside the checkout, so removing a task worktree removes its data too. */
export const DEV_USER_DATA_DIR = '.dev-user-data';

/** Does nothing in a packaged app. Returns the folder it applied. */
export function isolateDevInstance(
  target: Pick<typeof app, 'isPackaged' | 'getAppPath' | 'setPath'> = app,
): string | null {
  if (target.isPackaged) return null;

  const userData = join(target.getAppPath(), DEV_USER_DATA_DIR);
  mkdirSync(userData, { recursive: true });
  target.setPath('userData', userData);

  // A new data folder would otherwise open on the onboarding wizard, which
  // covers the screens a QA agent came to test.
  try {
    writeFileSync(
      join(userData, 'settings.json'),
      `${JSON.stringify({ onboardingCompleted: true }, null, 2)}\n`,
      { flag: 'wx' },
    );
  } catch {
    // Already there: keep it.
  }

  return userData;
}

isolateDevInstance();
