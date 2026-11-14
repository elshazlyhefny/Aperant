/**
 * zeenha fork: Windows skip convention for the unit test suite.
 *
 * CI runs the unit tests on Windows. A test that cannot pass there (POSIX file
 * modes, symlinks, shell syntax) must be skipped with a stated reason, so each
 * skip stays visible and reviewable:
 *
 *   it.skipIf(skipOnWindows('uses POSIX file modes'))('...', () => {});
 *   describe.skipIf(skipOnWindows('needs bash'))('...', () => {});
 *
 * Test code may read process.platform; production code must not.
 */
export function skipOnWindows(reason: string): boolean {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new Error('skipOnWindows requires a non-empty reason');
  }
  return process.platform === 'win32';
}
