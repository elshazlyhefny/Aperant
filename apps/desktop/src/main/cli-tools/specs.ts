/**
 * The CLI tool table: every fact that differs between python, git, gh, glab
 * and claude lives here, once. Detection and validation are generic over it.
 */

import path from 'path';
import { getExecutableExtension, isWindows, joinPaths } from '../platform';
import { getHomebrewPythonPaths } from '../utils/homebrew-python';
import { WINDOWS_GIT_PATHS, WINDOWS_GLAB_PATHS } from '../utils/windows-paths';
import type { Candidate, CLITool, DetectionContext, ToolSpec } from './types';

/**
 * Configuration for Claude CLI detection paths
 */
interface ClaudeDetectionPaths {
  /** Homebrew paths for macOS (Apple Silicon and Intel) */
  homebrewPaths: string[];
  /** Platform-specific standard installation paths */
  platformPaths: string[];
  /** Path to NVM versions directory for Node.js-installed Claude */
  nvmVersionsDir: string;
}

/**
 * Get all candidate paths for Claude CLI detection.
 *
 * Returns platform-specific paths where Claude CLI might be installed.
 * This pure function consolidates path configuration used by both sync
 * and async detection methods.
 *
 * Note: This is the single source of truth for CLI detection paths.
 * The Python backend relies on the Claude Agent SDK's bundled CLI,
 * so it no longer needs its own path detection logic.
 *
 * @param homeDir - User's home directory (from os.homedir())
 * @returns Object containing homebrew, platform, and NVM paths
 *
 * @example
 * const paths = getClaudeDetectionPaths('/Users/john');
 * // On macOS: { homebrewPaths: ['/opt/homebrew/bin/claude', ...], ... }
 */
export function getClaudeDetectionPaths(homeDir: string): ClaudeDetectionPaths {
  const homebrewPaths = [
    '/opt/homebrew/bin/claude', // Apple Silicon
    '/usr/local/bin/claude',    // Intel Mac
  ];

  const platformPaths = isWindows()
    ? [
        joinPaths(homeDir, 'AppData', 'Local', 'Programs', 'claude', `claude${getExecutableExtension()}`),
        joinPaths(homeDir, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
        joinPaths(homeDir, '.local', 'bin', `claude${getExecutableExtension()}`),
        'C:\\Program Files\\Claude\\claude.exe',
        'C:\\Program Files (x86)\\Claude\\claude.exe',
      ]
    : [
        joinPaths(homeDir, '.local', 'bin', 'claude'),
        joinPaths(homeDir, 'bin', 'claude'),
      ];

  const nvmVersionsDir = joinPaths(homeDir, '.nvm', 'versions', 'node');

  return { homebrewPaths, platformPaths, nvmVersionsDir };
}

/** Homebrew candidates for a single-binary tool on macOS */
function homebrewCandidates(label: string, exe: string, ctx: DetectionContext): Candidate[] {
  if (ctx.os !== 'darwin') return [];
  return [`/opt/homebrew/bin/${exe}`, `/usr/local/bin/${exe}`].map((p) => ({
    kind: 'path' as const,
    path: p,
    source: 'homebrew' as const,
    message: `Using Homebrew ${label}`,
  }));
}

function systemLookup(label: string, exe: string): Candidate {
  return { kind: 'lookup', exe, source: 'system-path', message: `Using system ${label}` };
}

/** Parse `<regex> match, else fallback(output)` style version output */
function versionParser(
  regex: RegExp,
  fallback: (output: string) => string | null
): (stdout: string) => string | null {
  return (stdout) => {
    const output = stdout.trim();
    const match = output.match(regex);
    return match ? match[1] : fallback(output);
  };
}

const firstLine = (output: string): string => output.split('\n')[0];

export const TOOL_SPECS: Record<CLITool, ToolSpec> = {
  python: {
    tool: 'python',
    label: 'Python',
    configKey: 'pythonPath',
    exe: 'python',
    minVersion: '3.10.0',
    splitCommandArgs: true,
    candidates(ctx) {
      const result: Candidate[] = [];
      if (ctx.isPackaged) {
        result.push({
          kind: 'path',
          path:
            ctx.os === 'win32'
              ? path.join(ctx.resourcesPath, 'python', 'python.exe')
              : path.join(ctx.resourcesPath, 'python', 'bin', 'python3'),
          source: 'bundled',
          message: 'Using bundled Python',
        });
      }
      if (ctx.os === 'darwin') {
        for (const p of getHomebrewPythonPaths()) {
          result.push({ kind: 'path', path: p, source: 'homebrew', message: 'Using Homebrew Python' });
        }
      }
      if (ctx.os === 'win32') {
        result.push({
          kind: 'command',
          command: 'py -3',
          source: 'system-path',
          message: 'Using system Python',
        });
        for (const exe of ['python', 'python3', 'py']) result.push(systemLookup('Python', exe));
      } else {
        for (const exe of ['python3', 'python']) result.push(systemLookup('Python', exe));
      }
      return result;
    },
    parseVersion: versionParser(/Python (\d+\.\d+\.\d+)/, () => null),
    notFound: 'Python 3.10.0+ not found. Please install Python or configure in Settings.',
  },

  git: {
    tool: 'git',
    label: 'Git',
    configKey: 'gitPath',
    exe: 'git',
    candidates(ctx) {
      const result = [...homebrewCandidates('Git', 'git', ctx), systemLookup('Git', 'git')];
      if (ctx.os === 'win32') {
        result.push(
          { kind: 'where', exe: 'git', source: 'system-path', message: 'Using Windows Git' },
          {
            kind: 'windows-patterns',
            patterns: WINDOWS_GIT_PATHS,
            source: 'system-path',
            message: 'Using Windows Git',
          }
        );
      }
      return result;
    },
    parseVersion: versionParser(/git version (\d+\.\d+\.\d+)/, (output) => output),
    notFound: 'Git not found in standard locations. Using fallback "git".',
  },

  gh: {
    tool: 'gh',
    label: 'GitHub CLI',
    configKey: 'githubCLIPath',
    exe: 'gh',
    candidates(ctx) {
      const result = [...homebrewCandidates('GitHub CLI', 'gh', ctx), systemLookup('GitHub CLI', 'gh')];
      if (ctx.os === 'win32') {
        for (const p of [
          'C:\\Program Files\\GitHub CLI\\gh.exe',
          'C:\\Program Files (x86)\\GitHub CLI\\gh.exe',
        ]) {
          result.push({ kind: 'path', path: p, source: 'system-path', message: 'Using Windows GitHub CLI' });
        }
      }
      return result;
    },
    parseVersion: versionParser(/gh version (\d+\.\d+\.\d+)/, firstLine),
    notFound: 'GitHub CLI (gh) not found. Install from https://cli.github.com',
  },

  glab: {
    tool: 'glab',
    label: 'GitLab CLI',
    configKey: 'gitlabCLIPath',
    exe: 'glab',
    candidates(ctx) {
      const result = [...homebrewCandidates('GitLab CLI', 'glab', ctx), systemLookup('GitLab CLI', 'glab')];
      if (ctx.os === 'win32') {
        result.push({
          kind: 'windows-patterns',
          patterns: WINDOWS_GLAB_PATHS,
          source: 'system-path',
          message: 'Using Windows GitLab CLI',
        });
      }
      return result;
    },
    parseVersion: versionParser(/glab\s+(\d+\.\d+\.\d+)/, firstLine),
    notFound: 'GitLab CLI (glab) not found. Install from https://gitlab.com/gitlab-org/cli',
  },

  claude: {
    tool: 'claude',
    label: 'Claude CLI',
    configKey: 'claudePath',
    exe: 'claude',
    secureUserConfigOnWindows: true,
    candidates(ctx) {
      const paths = getClaudeDetectionPaths(ctx.homeDir);
      const result: Candidate[] = [];
      if (ctx.os === 'darwin') {
        for (const p of paths.homebrewPaths) {
          result.push({ kind: 'path', path: p, source: 'homebrew', message: 'Using Homebrew Claude CLI' });
        }
      }
      result.push(systemLookup('Claude CLI', 'claude'));
      if (ctx.os === 'win32') {
        result.push({ kind: 'where', exe: 'claude', source: 'system-path', message: 'Using Windows Claude CLI' });
      } else {
        result.push({
          kind: 'nvm',
          dir: paths.nvmVersionsDir,
          bin: 'claude',
          source: 'nvm',
          message: 'Using NVM Claude CLI',
        });
      }
      for (const p of paths.platformPaths) {
        result.push({ kind: 'path', path: p, source: 'system-path', message: 'Using Claude CLI' });
      }
      return result;
    },
    parseVersion: versionParser(/(\d+\.\d+\.\d+)/, firstLine),
    notFound: 'Claude CLI not found. Install from https://claude.ai/download',
  },
};
