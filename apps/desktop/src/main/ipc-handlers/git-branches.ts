import { execFile } from 'child_process';
import { resolve } from 'path';
import { promisify } from 'util';
import type { GitBranchDetail } from '../../shared/types';
import { getToolPath } from '../cli-tool-manager';

const execFileAsync = promisify(execFile);

/** Minimum time between background fetch attempts for the same project. */
export const FETCH_MIN_INTERVAL_MS = 3 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;

// A fetch can take up to 10 s on a slow or offline network. It used to run
// synchronously before every branch listing and froze the main process, so it
// now runs in the background and is rate limited per project. Listings use the
// refs already on disk and callers are told when fresh refs have arrived.
const lastFetchStartedAt = new Map<string, number>();
const inFlight = new Set<string>();

async function runGit(projectPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(getToolPath('git'), args, {
    cwd: projectPath,
    encoding: 'utf-8'
  });
  return String(stdout);
}

function splitLines(output: string): string[] {
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

/**
 * Get list of git branches for a directory (both local and remote).
 * Never fetches; uses the refs already present.
 */
export async function getGitBranches(projectPath: string): Promise<string[]> {
  try {
    const output = await runGit(projectPath, ['branch', '--all', '--format=%(refname:short)']);
    const all = splitLines(output).filter(b => !b.endsWith('/HEAD'));

    const localNames = new Set(all.filter(b => !b.startsWith('origin/')));
    const seen = new Set<string>();
    const branches: string[] = [];
    for (const branch of all) {
      if (seen.has(branch)) continue;
      if (branch.startsWith('origin/') && localNames.has(branch.slice('origin/'.length))) continue;
      seen.add(branch);
      branches.push(branch);
    }

    return branches.sort((a, b) => {
      const aIsRemote = a.startsWith('origin/');
      const bIsRemote = b.startsWith('origin/');
      if (aIsRemote && !bIsRemote) return 1;
      if (!aIsRemote && bIsRemote) return -1;
      return a.localeCompare(b);
    });
  } catch {
    return [];
  }
}

/**
 * Get structured branch information (local first, then remote-only branches).
 * Never fetches; uses the refs already present.
 */
export async function getGitBranchesWithInfo(projectPath: string): Promise<GitBranchDetail[]> {
  try {
    const [currentResult, localOutput, remoteOutput] = await Promise.all([
      runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null),
      runGit(projectPath, ['branch', '--format=%(refname:short)']),
      runGit(projectPath, ['branch', '-r', '--format=%(refname:short)']).catch(() => null)
    ]);

    const currentBranch = currentResult?.trim() || null;

    const localBranches: GitBranchDetail[] = splitLines(localOutput).map(name => ({
      name,
      type: 'local' as const,
      displayName: name,
      isCurrent: name === currentBranch
    }));

    const localNames = new Set(localBranches.map(b => b.name));
    const remoteBranches: GitBranchDetail[] = splitLines(remoteOutput ?? '')
      .filter(b => !b.endsWith('/HEAD'))
      .map(fullName => fullName.replace(/^origin\//, ''))
      .filter(name => !localNames.has(name))
      .map(name => ({
        name,
        type: 'remote' as const,
        displayName: name,
        isCurrent: false
      }));

    const byName = (a: GitBranchDetail, b: GitBranchDetail) => a.name.localeCompare(b.name);
    return [...localBranches.sort(byName), ...remoteBranches.sort(byName)];
  } catch {
    return [];
  }
}

/**
 * Get the current git branch for a directory
 */
export async function getCurrentGitBranch(projectPath: string): Promise<string | null> {
  try {
    const output = await runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return output.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get the ref origin/HEAD points to (e.g. "refs/remotes/origin/main"), or null.
 */
export async function getDefaultRemoteBranchRef(projectPath: string): Promise<string | null> {
  try {
    const output = await runGit(projectPath, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
    return output.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Refresh remote refs in the background. Fire-and-forget: never throws and
 * callers must not await it. `onFetched` runs only after a successful fetch.
 */
export function scheduleBackgroundFetch(
  projectPath: string,
  onFetched: (projectPath: string) => void
): void {
  const key = resolve(projectPath);
  if (inFlight.has(key)) return;
  const last = lastFetchStartedAt.get(key);
  if (last !== undefined && Date.now() - last < FETCH_MIN_INTERVAL_MS) return;

  // Record the start so failed or offline attempts are rate limited too.
  lastFetchStartedAt.set(key, Date.now());
  inFlight.add(key);

  void (async () => {
    try {
      await execFileAsync(getToolPath('git'), ['fetch', '--prune'], {
        cwd: projectPath,
        timeout: FETCH_TIMEOUT_MS
      });
      onFetched(projectPath);
    } catch {
      // Offline or no remote: keep using local refs
    } finally {
      inFlight.delete(key);
    }
  })();
}

export function resetBackgroundFetchStateForTests(): void {
  lastFetchStartedAt.clear();
  inFlight.clear();
}
