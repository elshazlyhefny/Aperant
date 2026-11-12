/**
 * Generic detection over the TOOL_SPECS table. detectSync and detectAsync are
 * the same loop; they differ only in the I/O calls. Everything else (user
 * config gating, result building, version interpretation) is shared.
 */

import { existsSync, readdirSync, promises as fsPromises } from 'fs';
import path from 'path';
import { existsAsync, findExecutable, findExecutableAsync } from '../env-utils';
import { isWindows } from '../platform';
import {
  findWindowsExecutableViaWhere,
  findWindowsExecutableViaWhereAsync,
  getWindowsExecutablePaths,
  getWindowsExecutablePathsAsync,
  isSecurePath,
} from '../utils/windows-paths';
import type { ToolDetectionResult } from '../../shared/types';
import { runVersion, runVersionAsync } from './run-version';
import { TOOL_SPECS } from './specs';
import type { Candidate, DetectionContext, ToolSpec, ToolValidation } from './types';

/**
 * Check if a path appears to be from a different platform.
 * Detects Windows paths on Unix and Unix paths on Windows.
 */
export function isWrongPlatformPath(pathStr: string | undefined): boolean {
  if (!pathStr) return false;

  if (isWindows()) {
    // On Windows, reject Unix-style absolute paths (starting with /)
    // but allow relative paths and Windows paths
    if (pathStr.startsWith('/') && !pathStr.startsWith('//')) {
      return true;
    }
  } else {
    // On Unix (macOS/Linux), reject Windows-style paths
    if (/^[A-Za-z]:[/\\]/.test(pathStr)) {
      return true;
    }
    if (pathStr.includes('\\')) {
      return true;
    }
    if (pathStr.includes('AppData') || pathStr.includes('Program Files')) {
      return true;
    }
  }

  return false;
}

/**
 * Sort NVM version directories by semantic version (newest first).
 * Only directories named like v20.0.0 are kept.
 */
export function sortNvmVersionDirs(
  entries: Array<{ name: string; isDirectory(): boolean }>
): string[] {
  // Strict semver match prevents NaN from malformed versions (e.g., v20.abc.1) breaking the sort
  const semverRegex = /^v\d+\.\d+\.\d+$/;

  return entries
    .filter((entry) => entry.isDirectory() && semverRegex.test(entry.name))
    .sort((a, b) => {
      const vA = a.name.slice(1).split('.').map(Number);
      const vB = b.name.slice(1).split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        const diff = (vB[i] ?? 0) - (vA[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    })
    .map((entry) => entry.name);
}

/**
 * Build a ToolDetectionResult from a validation result.
 * Returns null if validation failed.
 */
export function buildClaudeDetectionResult(
  claudePath: string,
  validation: ToolValidation,
  source: ToolDetectionResult['source'],
  messagePrefix: string
): ToolDetectionResult | null {
  if (!validation.valid) {
    return null;
  }
  return {
    found: true,
    path: claudePath,
    version: validation.version,
    source,
    message: `${messagePrefix}: ${claudePath}`,
  };
}

// ----------------------------------------------------------------------------
// Validation
// ----------------------------------------------------------------------------

const compareVersions = (a: string, b: string): number => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

/** Turn `--version` output into a validation result */
function interpretVersion(spec: ToolSpec, stdout: string): ToolValidation {
  const version = spec.parseVersion(stdout);
  if (version === null) {
    return { valid: false, message: `Unable to detect ${spec.label} version` };
  }
  if (spec.minVersion && compareVersions(version, spec.minVersion) < 0) {
    return {
      valid: false,
      version,
      message: `${spec.label} ${version} is too old. Requires ${spec.minVersion}+`,
    };
  }
  return {
    valid: true,
    version,
    message:
      spec.tool === 'python'
        ? `Python ${version} meets requirements`
        : `${spec.label} ${version} is available`,
  };
}

const failure = (spec: ToolSpec, error: unknown): ToolValidation => ({
  valid: false,
  message: `Failed to validate ${spec.label}: ${error instanceof Error ? error.message : String(error)}`,
});

/** Split 'py -3' into command and arguments, only for tools that allow it */
function versionInvocation(spec: ToolSpec, cmd: string): { file: string; args: string[] } {
  if (spec.splitCommandArgs) {
    const parts = cmd.split(' ');
    return { file: parts[0], args: [...parts.slice(1), '--version'] };
  }
  return { file: cmd, args: ['--version'] };
}

export function validateTool(spec: ToolSpec, cmd: string): ToolValidation {
  try {
    const { file, args } = versionInvocation(spec, cmd);
    return interpretVersion(spec, runVersion(file, args, spec.label));
  } catch (error) {
    return failure(spec, error);
  }
}

export async function validateToolAsync(spec: ToolSpec, cmd: string): Promise<ToolValidation> {
  try {
    const { file, args } = versionInvocation(spec, cmd);
    return interpretVersion(spec, await runVersionAsync(file, args, spec.label));
  } catch (error) {
    return failure(spec, error);
  }
}

/** Validate a Claude CLI path exactly the way the detector does */
export const validateClaudeAsync = (cmd: string): Promise<ToolValidation> =>
  validateToolAsync(TOOL_SPECS.claude, cmd);

// ----------------------------------------------------------------------------
// Shared helpers for both runners
// ----------------------------------------------------------------------------

/** Returns the user-configured path if it may be validated, otherwise null (after warning) */
function usableUserPath(
  spec: ToolSpec,
  userPath: string | undefined,
  ctx: DetectionContext
): string | null {
  if (!userPath) return null;
  if (isWrongPlatformPath(userPath)) {
    console.warn(
      `[${spec.label}] User-configured path is from different platform, ignoring: ${userPath}`
    );
    return null;
  }
  if (spec.secureUserConfigOnWindows && ctx.os === 'win32' && !isSecurePath(userPath)) {
    console.warn(
      `[${spec.label}] User-configured path failed security validation, ignoring: ${userPath}`
    );
    return null;
  }
  return userPath;
}

function userConfigResult(
  spec: ToolSpec,
  userPath: string,
  validation: ToolValidation
): ToolDetectionResult | null {
  const result = buildClaudeDetectionResult(
    userPath,
    validation,
    'user-config',
    `Using user-configured ${spec.label}`
  );
  if (!result) {
    console.warn(`[${spec.label}] User-configured path invalid: ${validation.message}`);
  }
  return result;
}

const notFoundResult = (spec: ToolSpec): ToolDetectionResult => ({
  found: false,
  source: 'fallback',
  message: spec.notFound,
});

const candidateResult = (
  candidate: Candidate,
  resolved: string,
  validation: ToolValidation
): ToolDetectionResult | null =>
  buildClaudeDetectionResult(resolved, validation, candidate.source, candidate.message);

const warnNvm = (spec: ToolSpec, error: unknown): void =>
  console.warn(`[${spec.label}] Unable to read NVM directory: ${error}`);

// ----------------------------------------------------------------------------
// Runners
// ----------------------------------------------------------------------------

export function detectSync(
  spec: ToolSpec,
  userPath: string | undefined,
  ctx: DetectionContext
): ToolDetectionResult {
  const userCandidate = usableUserPath(spec, userPath, ctx);
  if (userCandidate) {
    const result = userConfigResult(spec, userCandidate, validateTool(spec, userCandidate));
    if (result) return result;
  }

  /** Validate resolved paths in order; first valid wins */
  const tryPaths = (candidate: Candidate, paths: string[]): ToolDetectionResult | null => {
    for (const p of paths) {
      const result = candidateResult(candidate, p, validateTool(spec, p));
      if (result) return result;
    }
    return null;
  };

  for (const candidate of spec.candidates(ctx)) {
    let result: ToolDetectionResult | null = null;
    switch (candidate.kind) {
      case 'path':
        if (existsSync(candidate.path)) result = tryPaths(candidate, [candidate.path]);
        break;
      case 'command':
        result = tryPaths(candidate, [candidate.command]);
        break;
      case 'lookup': {
        const found = findExecutable(candidate.exe);
        if (found) result = tryPaths(candidate, [found]);
        break;
      }
      case 'where': {
        const found = findWindowsExecutableViaWhere(candidate.exe, `[${spec.label}]`);
        if (found) result = tryPaths(candidate, [found]);
        break;
      }
      case 'windows-patterns':
        result = tryPaths(candidate, getWindowsExecutablePaths(candidate.patterns, `[${spec.label}]`));
        break;
      case 'nvm':
        try {
          if (existsSync(candidate.dir)) {
            const entries = readdirSync(candidate.dir, { withFileTypes: true });
            for (const version of sortNvmVersionDirs(entries)) {
              const binPath = path.join(candidate.dir, version, 'bin', candidate.bin);
              if (existsSync(binPath)) {
                result = tryPaths(candidate, [binPath]);
                if (result) break;
              }
            }
          }
        } catch (error) {
          warnNvm(spec, error);
        }
        break;
    }
    if (result) return result;
  }

  return notFoundResult(spec);
}

export async function detectAsync(
  spec: ToolSpec,
  userPath: string | undefined,
  ctx: DetectionContext
): Promise<ToolDetectionResult> {
  const userCandidate = usableUserPath(spec, userPath, ctx);
  if (userCandidate) {
    const result = userConfigResult(spec, userCandidate, await validateToolAsync(spec, userCandidate));
    if (result) return result;
  }

  /** Validate resolved paths in order; first valid wins */
  const tryPaths = async (
    candidate: Candidate,
    paths: string[]
  ): Promise<ToolDetectionResult | null> => {
    for (const p of paths) {
      const result = candidateResult(candidate, p, await validateToolAsync(spec, p));
      if (result) return result;
    }
    return null;
  };

  for (const candidate of spec.candidates(ctx)) {
    let result: ToolDetectionResult | null = null;
    switch (candidate.kind) {
      case 'path':
        if (await existsAsync(candidate.path)) result = await tryPaths(candidate, [candidate.path]);
        break;
      case 'command':
        result = await tryPaths(candidate, [candidate.command]);
        break;
      case 'lookup': {
        const found = await findExecutableAsync(candidate.exe);
        if (found) result = await tryPaths(candidate, [found]);
        break;
      }
      case 'where': {
        const found = await findWindowsExecutableViaWhereAsync(candidate.exe, `[${spec.label}]`);
        if (found) result = await tryPaths(candidate, [found]);
        break;
      }
      case 'windows-patterns':
        result = await tryPaths(
          candidate,
          await getWindowsExecutablePathsAsync(candidate.patterns, `[${spec.label}]`)
        );
        break;
      case 'nvm':
        try {
          if (await existsAsync(candidate.dir)) {
            const entries = await fsPromises.readdir(candidate.dir, { withFileTypes: true });
            for (const version of sortNvmVersionDirs(entries)) {
              const binPath = path.join(candidate.dir, version, 'bin', candidate.bin);
              if (await existsAsync(binPath)) {
                result = await tryPaths(candidate, [binPath]);
                if (result) break;
              }
            }
          }
        } catch (error) {
          warnNvm(spec, error);
        }
        break;
    }
    if (result) return result;
  }

  return notFoundResult(spec);
}
