import { describe, it, expect, vi } from 'vitest';

const platformState = vi.hoisted(() => ({ windows: false }));

vi.mock('../../platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platform')>();
  return {
    ...actual,
    isWindows: () => platformState.windows,
    getExecutableExtension: () => (platformState.windows ? '.exe' : ''),
  };
});

import { TOOL_SPECS, getClaudeDetectionPaths } from '../specs';
import { WINDOWS_GIT_PATHS, WINDOWS_GLAB_PATHS } from '../../utils/windows-paths';
import type { Candidate, CLITool, DetectionContext } from '../types';

type OsName = DetectionContext['os'];

function ctxFor(os: OsName, isPackaged = false): DetectionContext {
  return { os, homeDir: '/home/u', isPackaged, resourcesPath: '/res' };
}

function candidates(tool: CLITool, os: OsName, isPackaged = false): Candidate[] {
  platformState.windows = os === 'win32';
  return TOOL_SPECS[tool].candidates(ctxFor(os, isPackaged));
}

const summary = (list: Candidate[]) =>
  list.map((c) => {
    const target =
      c.kind === 'path' ? c.path
      : c.kind === 'command' ? c.command
      : c.kind === 'lookup' || c.kind === 'where' ? c.exe
      : c.kind === 'nvm' ? c.dir
      : 'patterns';
    return `${c.kind}:${target}:${c.source}:${c.message}`;
  });

describe('TOOL_SPECS candidates', () => {
  it('python: only lookups on linux', () => {
    expect(summary(candidates('python', 'linux'))).toEqual([
      'lookup:python3:system-path:Using system Python',
      'lookup:python:system-path:Using system Python',
    ]);
  });

  it('python: Homebrew then lookups on darwin', () => {
    const list = candidates('python', 'darwin');
    const homebrew = list.filter((c) => c.source === 'homebrew');
    expect(homebrew).toHaveLength(12);
    expect(homebrew[0]).toMatchObject({ path: '/opt/homebrew/bin/python3.14' });
    expect(homebrew[11]).toMatchObject({ path: '/usr/local/bin/python3' });
    expect(list.slice(12).map((c) => c.kind === 'lookup' && c.exe)).toEqual(['python3', 'python']);
  });

  it('python: py launcher first on win32', () => {
    expect(summary(candidates('python', 'win32'))).toEqual([
      'command:py -3:system-path:Using system Python',
      'lookup:python:system-path:Using system Python',
      'lookup:python3:system-path:Using system Python',
      'lookup:py:system-path:Using system Python',
    ]);
  });

  it('python: bundled only when packaged, first in order', () => {
    expect(candidates('python', 'linux').some((c) => c.source === 'bundled')).toBe(false);
    const linux = candidates('python', 'linux', true)[0];
    expect(linux).toMatchObject({ kind: 'path', source: 'bundled', message: 'Using bundled Python' });
    expect((linux as { path: string }).path).toMatch(/python[\\/]bin[\\/]python3$/);
    const win = candidates('python', 'win32', true)[0];
    expect((win as { path: string }).path).toMatch(/python[\\/]python\.exe$/);
  });

  it.each(['git', 'gh', 'glab'] as const)('%s: Homebrew only on darwin', (tool) => {
    const exe = TOOL_SPECS[tool].exe;
    const label = TOOL_SPECS[tool].label;
    expect(summary(candidates(tool, 'darwin')).slice(0, 3)).toEqual([
      `path:/opt/homebrew/bin/${exe}:homebrew:Using Homebrew ${label}`,
      `path:/usr/local/bin/${exe}:homebrew:Using Homebrew ${label}`,
      `lookup:${exe}:system-path:Using system ${label}`,
    ]);
    expect(summary(candidates(tool, 'linux'))).toEqual([
      `lookup:${exe}:system-path:Using system ${label}`,
    ]);
  });

  it('git: where then patterns on win32', () => {
    const list = candidates('git', 'win32');
    expect(list).toHaveLength(3);
    expect(list[1]).toMatchObject({ kind: 'where', exe: 'git', message: 'Using Windows Git' });
    expect(list[2]).toMatchObject({
      kind: 'windows-patterns',
      patterns: WINDOWS_GIT_PATHS,
      source: 'system-path',
      message: 'Using Windows Git',
    });
  });

  it('gh: fixed Program Files paths on win32', () => {
    expect(summary(candidates('gh', 'win32')).slice(1)).toEqual([
      'path:C:\\Program Files\\GitHub CLI\\gh.exe:system-path:Using Windows GitHub CLI',
      'path:C:\\Program Files (x86)\\GitHub CLI\\gh.exe:system-path:Using Windows GitHub CLI',
    ]);
  });

  it('glab: windows patterns on win32', () => {
    const list = candidates('glab', 'win32');
    expect(list[1]).toMatchObject({
      kind: 'windows-patterns',
      patterns: WINDOWS_GLAB_PATHS,
      message: 'Using Windows GitLab CLI',
    });
  });

  it('claude: darwin order Homebrew, lookup, nvm, platform paths', () => {
    expect(summary(candidates('claude', 'darwin'))).toEqual([
      'path:/opt/homebrew/bin/claude:homebrew:Using Homebrew Claude CLI',
      'path:/usr/local/bin/claude:homebrew:Using Homebrew Claude CLI',
      'lookup:claude:system-path:Using system Claude CLI',
      'nvm:/home/u/.nvm/versions/node:nvm:Using NVM Claude CLI',
      'path:/home/u/.local/bin/claude:system-path:Using Claude CLI',
      'path:/home/u/bin/claude:system-path:Using Claude CLI',
    ]);
  });

  it('claude: no Homebrew on linux', () => {
    expect(candidates('claude', 'linux').some((c) => c.source === 'homebrew')).toBe(false);
  });

  it('claude: where, no nvm on win32', () => {
    const list = candidates('claude', 'win32');
    expect(list.some((c) => c.kind === 'nvm')).toBe(false);
    expect(list[0]).toMatchObject({ kind: 'lookup', exe: 'claude' });
    expect(list[1]).toMatchObject({ kind: 'where', exe: 'claude', message: 'Using Windows Claude CLI' });
    expect(list.slice(2).every((c) => c.kind === 'path' && c.message === 'Using Claude CLI')).toBe(true);
    expect(list).toHaveLength(2 + getClaudeDetectionPaths('/home/u').platformPaths.length);
    expect(TOOL_SPECS.claude.secureUserConfigOnWindows).toBe(true);
  });

  it('non-darwin never yields Homebrew candidates', () => {
    for (const tool of Object.keys(TOOL_SPECS) as CLITool[]) {
      for (const os of ['linux', 'win32'] as const) {
        expect(candidates(tool, os).some((c) => c.source === 'homebrew')).toBe(false);
      }
    }
  });
});

describe('TOOL_SPECS metadata', () => {
  it('has config keys, python settings and not-found messages', () => {
    expect(TOOL_SPECS.python).toMatchObject({ minVersion: '3.10.0', splitCommandArgs: true, configKey: 'pythonPath' });
    expect(TOOL_SPECS.git.configKey).toBe('gitPath');
    expect(TOOL_SPECS.gh.configKey).toBe('githubCLIPath');
    expect(TOOL_SPECS.glab.configKey).toBe('gitlabCLIPath');
    expect(TOOL_SPECS.claude.configKey).toBe('claudePath');
    expect(TOOL_SPECS.git.notFound).toBe('Git not found in standard locations. Using fallback "git".');
    expect(TOOL_SPECS.gh.notFound).toBe('GitHub CLI (gh) not found. Install from https://cli.github.com');
    expect(TOOL_SPECS.glab.notFound).toBe('GitLab CLI (glab) not found. Install from https://gitlab.com/gitlab-org/cli');
    expect(TOOL_SPECS.claude.notFound).toBe('Claude CLI not found. Install from https://claude.ai/download');
    expect(TOOL_SPECS.python.notFound).toBe('Python 3.10.0+ not found. Please install Python or configure in Settings.');
  });
});

describe('TOOL_SPECS parseVersion', () => {
  it('python', () => {
    expect(TOOL_SPECS.python.parseVersion('Python 3.12.1\n')).toBe('3.12.1');
    expect(TOOL_SPECS.python.parseVersion('garbage')).toBeNull();
  });
  it('git', () => {
    expect(TOOL_SPECS.git.parseVersion('git version 2.43.0\n')).toBe('2.43.0');
    expect(TOOL_SPECS.git.parseVersion('weird output\n')).toBe('weird output');
  });
  it('gh', () => {
    expect(TOOL_SPECS.gh.parseVersion('gh version 2.40.1 (2024-01-01)\nhttps://github.com/cli/cli/releases/tag/v2.40.1')).toBe('2.40.1');
    expect(TOOL_SPECS.gh.parseVersion('garbage\nsecond')).toBe('garbage');
  });
  it('glab', () => {
    expect(TOOL_SPECS.glab.parseVersion('glab 1.36.0 (abc123)')).toBe('1.36.0');
    expect(TOOL_SPECS.glab.parseVersion('garbage\nsecond')).toBe('garbage');
  });
  it('claude', () => {
    expect(TOOL_SPECS.claude.parseVersion('claude-code version 1.0.0')).toBe('1.0.0');
    expect(TOOL_SPECS.claude.parseVersion('2.1.16 (Claude Code)')).toBe('2.1.16');
    expect(TOOL_SPECS.claude.parseVersion('garbage\nsecond')).toBe('garbage');
  });
});
