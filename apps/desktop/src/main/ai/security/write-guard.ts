/**
 * Write Guard
 * ===========
 *
 * zeenha fork: file-write tools (Write/Edit) must never modify git internals.
 * An agent writing into `.git/hooks`, `.git/config` or a worktree `.git`
 * pointer file can run arbitrary code or corrupt the repository, and plain
 * project-dir containment does not stop that.
 */

import * as path from 'node:path';

import { assertPathContained } from './path-containment';

/** Minimal context needed by the write guard */
export interface WriteGuardContext {
  projectDir: string;
  /** Optional narrower directory writes must stay inside */
  writeRoot?: string;
}

function hasGitSegment(p: string): boolean {
  return p.split(/[\\/]+/).some((segment) => segment.toLowerCase() === '.git');
}

/**
 * Throw if any segment of the resolved path is `.git` (case-insensitive).
 * Covers the .git directory, its contents, and a worktree `.git` pointer file.
 */
export function assertNotGitInternal(resolvedPath: string): void {
  if (hasGitSegment(resolvedPath)) {
    throw new Error(
      `Write blocked: '${resolvedPath}' is inside git internals (.git). Agents may not modify .git.`,
    );
  }
}

/**
 * Assert a write target is allowed: inside projectDir, not in .git, and
 * inside writeRoot when one is set.
 */
export function assertWriteAllowed(
  filePath: string,
  context: WriteGuardContext,
): { resolvedPath: string } {
  const { projectDir, writeRoot } = context;
  const { resolvedPath } = assertPathContained(filePath, projectDir);

  // Check the pre-resolution path too, so a symlink target cannot hide it
  const absolutePath = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(projectDir, filePath);
  assertNotGitInternal(absolutePath);
  assertNotGitInternal(resolvedPath);

  if (writeRoot) {
    try {
      assertPathContained(resolvedPath, writeRoot);
    } catch {
      throw new Error(
        `Write blocked: '${filePath}' resolves to '${resolvedPath}' which is outside the allowed write root '${writeRoot}'`,
      );
    }
  }

  return { resolvedPath };
}
