/**
 * Unit tests for cli-tool-manager
 * Tests CLI tool detection with focus on NVM path detection
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readdirSync, promises as fsPromises } from 'fs';
import nodePath from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import {
  getToolInfo,
  getToolInfoAsync,
  getToolPath,
  getToolPathAsync,
  configureTools,
  type CLITool,
  type ToolConfig,
  clearToolCache,
  getClaudeDetectionPaths,
  sortNvmVersionDirs,
  buildClaudeDetectionResult
} from '../cli-tool-manager';
import {
  findWindowsExecutableViaWhere,
  findWindowsExecutableViaWhereAsync,
  getWindowsExecutablePaths,
  getWindowsExecutablePathsAsync,
  isSecurePath
} from '../utils/windows-paths';
import { findExecutable, findExecutableAsync } from '../env-utils';

type SpawnOptions = Parameters<(typeof import('../env-utils'))['getSpawnOptions']>[1];
type MockDirent = import('fs').Dirent<import('node:buffer').NonSharedBuffer>;

const createDirent = (name: string, isDir: boolean): MockDirent =>
  ({
    name,
    parentPath: '',
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false
  }) as unknown as MockDirent;

// Mock Electron app
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn()
  }
}));

// Mock os module
vi.mock('os', () => ({
  default: {
    homedir: vi.fn(() => '/mock/home')
  }
}));

// Mock fs module - need to mock both sync and promises
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  promises: { readdir: vi.fn() }
}));

// Mock child_process for execFileSync, execFile, execSync, and exec (used in validation)
// execFile and exec need to be promisify-compatible
// IMPORTANT: execSync and execFileSync share the same mock so tests that set one will affect both
// This is because validateClaude() uses execSync for .cmd files and execFileSync for others
vi.mock('child_process', () => {
  // Shared mock for sync execution - both execFileSync and execSync use this
  // so when tests call vi.mocked(execFileSync).mockReturnValue(), it affects execSync too
  const sharedSyncMock = vi.fn();

const mockExecFile = vi.fn((_cmd: unknown, _args: unknown, _options: unknown, callback: unknown) => {
    // Return a minimal ChildProcess-like object
    const childProcess = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn()
    };

    // If callback is provided, call it asynchronously
    if (typeof callback === 'function') {
      const cb = callback as (error: Error | null, stdout: string, stderr: string) => void;
      setImmediate(() => cb(null, 'claude-code version 1.0.0\n', ''));
    }

    return childProcess as unknown as import('child_process').ChildProcess;
  });

  const mockExec = vi.fn((_cmd: unknown, _options: unknown, callback: unknown) => {
    // Return a minimal ChildProcess-like object
    const childProcess = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn()
    };

    // If callback is provided, call it asynchronously
    if (typeof callback === 'function') {
      const cb = callback as (error: Error | null, stdout: string, stderr: string) => void;
      setImmediate(() => cb(null, 'claude-code version 1.0.0\n', ''));
    }

    return childProcess as unknown as import('child_process').ChildProcess;
  });

  // util.promisify(execFile) must resolve { stdout, stderr }. Drive stdout from the same
  // mock as execFileSync so sync and async validation see identical output (and errors).
  (mockExecFile as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] =
    vi.fn(async (...callArgs: unknown[]) => {
      const stdout = (sharedSyncMock as unknown as (...a: unknown[]) => unknown)(...callArgs);
      return { stdout: stdout === undefined ? '' : String(stdout), stderr: '' };
    });

  return {
    execFileSync: sharedSyncMock,
    execFile: mockExecFile,
    execSync: sharedSyncMock,  // Share with execFileSync so tests work for both
    exec: mockExec
  };
});

// Mock env-utils to avoid PATH augmentation complexity
vi.mock('../env-utils', () => {
  const mockShouldUseShell = vi.fn((command: string) => {
    if (process.platform !== 'win32') {
      return false;
    }
    const trimmed = command.trim();
    const unquoted =
      trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
    return /\.(cmd|bat)$/i.test(unquoted);
  });

  return ({
  findExecutable: vi.fn(() => null), // Return null to force platform-specific path checking
  findExecutableAsync: vi.fn(() => Promise.resolve(null)),
  getAugmentedEnv: vi.fn(() => ({ PATH: '' })),
  getAugmentedEnvAsync: vi.fn(() => Promise.resolve({ PATH: '' })),
  shouldUseShell: mockShouldUseShell,
  getSpawnCommand: vi.fn((command: string) => {
    // Mock getSpawnCommand to match actual behavior
    const trimmed = command.trim();
    // On Windows, quote .cmd/.bat files
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(trimmed)) {
      // Idempotent - if already quoted, return as-is
      if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed;
      }
      return `"${trimmed}"`;
    }
    // For non-.cmd/.bat files, return trimmed (strip quotes if present)
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  }),
  getSpawnOptions: vi.fn((command: string, baseOptions?: SpawnOptions) => ({
    ...baseOptions,
    shell: mockShouldUseShell(command)
  })),
  // Delegates to the existsSync mock so sync and async detection see the same filesystem
  existsAsync: vi.fn(async (p: string) => {
    const fsMock = await import('fs');
    return Boolean(fsMock.existsSync(p));
  })
  });
});

// Mock homebrew-python utility
vi.mock('../utils/homebrew-python', () => {
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin'];
  const names = ['python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3'];
  return {
    getHomebrewPythonPaths: vi.fn(() => dirs.flatMap((dir) => names.map((name) => `${dir}/${name}`)))
  };
});

// Mock windows-paths utility
vi.mock('../utils/windows-paths', () => ({
  findWindowsExecutableViaWhere: vi.fn(() => null),
  findWindowsExecutableViaWhereAsync: vi.fn(() => Promise.resolve(null)),
  isSecurePath: vi.fn(() => true),
  getWindowsExecutablePaths: vi.fn(() => []),
  getWindowsExecutablePathsAsync: vi.fn(() => Promise.resolve([])),
  WINDOWS_GIT_PATHS: {},
  WINDOWS_GLAB_PATHS: {}
}));

describe('cli-tool-manager - Claude CLI NVM detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set default platform to Linux
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      writable: true
    });
  });

  afterEach(() => {
    clearToolCache();
  });

  const mockHomeDir = '/mock/home';

  describe('NVM path detection on Unix/Linux/macOS', () => {
    it('should detect Claude CLI in NVM directory when multiple Node versions exist', () => {
      // Mock home directory
      vi.mocked(os.homedir).mockReturnValue(mockHomeDir);

      // Mock NVM directory exists
      vi.mocked(existsSync).mockImplementation((filePath) => {
        const pathStr = String(filePath);
        // NVM versions directory exists
        if (pathStr.includes('.nvm/versions/node') || pathStr.includes('.nvm\\versions\\node')) {
          return true;
        }
        // Claude CLI exists in v22.17.0
        if (pathStr.includes('v22.17.0/bin/claude') || pathStr.includes('v22.17.0\\bin\\claude')) {
          return true;
        }
        return false;
      });

      // Mock Node.js version directories (three versions)
      const mockDirents: MockDirent[] = [
        createDirent('v20.0.0', true),
        createDirent('v22.17.0', true),
        createDirent('v18.20.0', true),
      ];
      vi.mocked(readdirSync).mockReturnValue(mockDirents);

      // Mock execFileSync to simulate successful version check
      vi.mocked(execFileSync).mockReturnValue('claude-code version 1.0.0\n');

      const result = getToolInfo('claude');

      expect(result.found).toBe(true);
      // Path should contain version and claude (works with both / and \ separators)
      expect(result.path).toMatch(/v22\.17\.0[/\\]bin[/\\]claude/);
      expect(result.version).toBe('1.0.0');
      expect(result.source).toBe('nvm');
      expect(result.message).toContain('Using NVM Claude CLI');
    });

    it('should skip NVM path detection on Windows', () => {
      // Set platform to Windows
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        writable: true
      });

      vi.mocked(os.homedir).mockReturnValue('C:\\Users\\test');
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(readdirSync).mockReturnValue([]);

      const result = getToolInfo('claude');

      // readdirSync should not be called for NVM on Windows
      expect(readdirSync).not.toHaveBeenCalled();
      expect(result.source).toBe('fallback'); // Should fallback since no other paths exist
    });

    it('should handle missing NVM directory gracefully', () => {
      vi.mocked(os.homedir).mockReturnValue(mockHomeDir);

      // NVM directory doesn't exist
      vi.mocked(existsSync).mockReturnValue(false);

      const result = getToolInfo('claude');

      // Should not crash, should continue to platform paths
      expect(result).toBeDefined();
      expect(result.found).toBe(false);
    });

    it('should try next version if Claude not found in newest Node version', () => {
      vi.mocked(os.homedir).mockReturnValue(mockHomeDir);

      // NVM directory exists, but Claude only exists in v20.0.0
      vi.mocked(existsSync).mockImplementation((filePath) => {
        const pathStr = String(filePath);
        // Check for claude binary paths first (more specific)
        if (pathStr.includes('claude')) {
          // Claude only exists in v20.0.0, not in v22.17.0
          return pathStr.includes('v20.0.0');
        }
        // NVM versions directory exists
        if (pathStr.includes('.nvm')) {
          return true;
        }
        return false;
      });

      const mockDirents: MockDirent[] = [
        createDirent('v22.17.0', true),
        createDirent('v20.0.0', true),
      ];
      vi.mocked(readdirSync).mockReturnValue(mockDirents);
      vi.mocked(execFileSync).mockReturnValue('claude-code version 1.5.0\n');

      const result = getToolInfo('claude');

      expect(result.found).toBe(true);
      expect(result.path).toMatch(/v20\.0\.0[/\\]bin[/\\]claude/);
    });

    it('should validate Claude CLI before returning NVM path', () => {
      vi.mocked(os.homedir).mockReturnValue(mockHomeDir);

      vi.mocked(existsSync).mockImplementation((filePath) => {
        const pathStr = String(filePath);
        // Check for claude binary paths first
        if (pathStr.includes('claude')) {
          return pathStr.includes('v22.17.0');
        }
        // NVM directory exists
        if (pathStr.includes('.nvm')) return true;
        return false;
      });

      const mockDirents: MockDirent[] = [
        createDirent('v22.17.0', true),
      ];
      vi.mocked(readdirSync).mockReturnValue(mockDirents);

      // Mock validation failure
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('Command not found or invalid');
      });

      const result = getToolInfo('claude');

      // Should not return invalid Claude path, should continue to platform paths
      expect(result.found).toBe(false);
      expect(result.source).toBe('fallback');
    });

    it('should use version sorting to prioritize newest Node version', () => {
      vi.mocked(os.homedir).mockReturnValue(mockHomeDir);

      vi.mocked(existsSync).mockImplementation((filePath) => {
        const pathStr = String(filePath);
        if (pathStr.includes('.nvm/versions/node') || pathStr.includes('.nvm\\versions\\node')) return true;
        // Claude exists in all versions
        if (pathStr.includes('/bin/claude') || pathStr.includes('\\bin\\claude')) return true;
        return false;
      });

      // Versions in random order
      const mockDirents: MockDirent[] = [
        createDirent('v18.20.0', true),
        createDirent('v22.17.0', true),
        createDirent('v20.5.0', true),
      ];
      vi.mocked(readdirSync).mockReturnValue(mockDirents);
      vi.mocked(execFileSync).mockReturnValue('claude-code version 1.0.0\n');

      const result = getToolInfo('claude');

      expect(result.found).toBe(true);
      expect(result.path).toContain('v22.17.0'); // Highest version
    });
  });

  describe('Platform-specific path detection', () => {
    it('should detect Claude CLI in Windows AppData npm global path', () => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        writable: true
      });

      vi.mocked(os.homedir).mockReturnValue('C:\\Users\\test');

      vi.mocked(existsSync).mockImplementation((filePath) => {
        const pathStr = String(filePath);
        // Check path components (path.join uses host OS separator)
        if (pathStr.includes('AppData') &&
            pathStr.includes('npm') &&
            pathStr.includes('claude.cmd')) {
          return true;
        }
        return false;
      });

      vi.mocked(execFileSync).mockReturnValue('claude-code version 1.0.0\n');

      const result = getToolInfo('claude');

      expect(result.found).toBe(true);
      expect(result.path).toMatch(/AppData[/\\]Roaming[/\\]npm[/\\]claude\.cmd/);
      expect(result.source).toBe('system-path');
    });

    it('should ignore insecure Windows Claude CLI path from where.exe', () => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        writable: true
      });

      vi.mocked(os.homedir).mockReturnValue('C:\\Users\\test');
      vi.mocked(findExecutable).mockReturnValue(null);
      vi.mocked(findWindowsExecutableViaWhere).mockReturnValue(
        'D:\\Tools\\claude.cmd'
      );
      vi.mocked(isSecurePath).mockReturnValueOnce(false);

      vi.mocked(existsSync).mockImplementation((filePath) => {
        const pathStr = String(filePath);
        if (pathStr.includes('Tools') && pathStr.includes('claude.cmd')) {
          return true;
        }
        return false;
      });

      const result = getToolInfo('claude');

      expect(result.found).toBe(false);
      expect(result.source).toBe('fallback');
      expect(execFileSync).not.toHaveBeenCalled();
      expect(isSecurePath).toHaveBeenCalledWith('D:\\Tools\\claude.cmd');
    });

    it('should detect Claude CLI in Unix .local/bin path', () => {
      vi.mocked(os.homedir).mockReturnValue('/home/user');

      vi.mocked(existsSync).mockImplementation((filePath) => {
        const pathStr = String(filePath);
        if (pathStr.includes('.local/bin/claude') || pathStr.includes('.local\\bin\\claude')) {
          return true;
        }
        return false;
      });

      vi.mocked(execFileSync).mockReturnValue('claude-code version 2.0.0\n');

      const result = getToolInfo('claude');

      expect(result.found).toBe(true);
      expect(result.path).toMatch(/\.local[/\\]bin[/\\]claude/);
      expect(result.version).toBe('2.0.0');
    });

    it('should return fallback when Claude CLI not found anywhere', () => {
      vi.mocked(os.homedir).mockReturnValue('/home/user');
      vi.mocked(existsSync).mockReturnValue(false);

      const result = getToolInfo('claude');

      expect(result.found).toBe(false);
      expect(result.source).toBe('fallback');
      expect(result.message).toContain('Claude CLI not found');
    });
  });

});

/**
 * Unit tests for helper functions
 */
describe('cli-tool-manager - Helper Functions', () => {
  describe('getClaudeDetectionPaths', () => {
    it('should return homebrew paths on macOS', () => {
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        writable: true
      });

      const paths = getClaudeDetectionPaths('/Users/test');

      expect(paths.homebrewPaths).toContain('/opt/homebrew/bin/claude');
      expect(paths.homebrewPaths).toContain('/usr/local/bin/claude');
    });

    it('should return Windows paths on win32', () => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        writable: true
      });

      const paths = getClaudeDetectionPaths('C:\\Users\\test');

      // Windows paths should include AppData and Program Files
      expect(paths.platformPaths.some(p => p.includes('AppData'))).toBe(true);
      expect(paths.platformPaths.some(p => p.includes('Program Files'))).toBe(true);
    });

    it('should return Unix paths on Linux', () => {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        writable: true
      });

      const paths = getClaudeDetectionPaths('/home/test');

      // Check for paths containing the expected components (works with both / and \ separators)
      expect(paths.platformPaths.some(p => p.includes('.local') && p.includes('bin') && p.includes('claude'))).toBe(true);
      expect(paths.platformPaths.some(p => p.includes('bin') && p.includes('claude'))).toBe(true);
    });

    it('should return correct NVM versions directory', () => {
      const paths = getClaudeDetectionPaths('/home/test');

      // Check path components exist (works with both / and \ separators)
      expect(paths.nvmVersionsDir).toContain('.nvm');
      expect(paths.nvmVersionsDir).toContain('versions');
      expect(paths.nvmVersionsDir).toContain('node');
    });
  });

  describe('sortNvmVersionDirs', () => {
    it('should sort versions in descending order (newest first)', () => {
      const entries = [
        { name: 'v18.20.0', isDirectory: () => true },
        { name: 'v22.17.0', isDirectory: () => true },
        { name: 'v20.5.0', isDirectory: () => true },
      ];

      const sorted = sortNvmVersionDirs(entries);

      expect(sorted).toEqual(['v22.17.0', 'v20.5.0', 'v18.20.0']);
    });

    it('should filter out non-version directories', () => {
      const entries = [
        { name: 'v20.0.0', isDirectory: () => true },
        { name: 'current', isDirectory: () => true },
        { name: '.DS_Store', isDirectory: () => false },
        { name: 'system', isDirectory: () => true },
      ];

      const sorted = sortNvmVersionDirs(entries);

      expect(sorted).toEqual(['v20.0.0']);
      expect(sorted).not.toContain('current');
      expect(sorted).not.toContain('system');
    });

    it('should handle malformed version strings', () => {
      const entries = [
        { name: 'v22.17.0', isDirectory: () => true },
        { name: 'v20.abc.1', isDirectory: () => true }, // Invalid version
        { name: 'v18.20.0', isDirectory: () => true },
      ];

      const sorted = sortNvmVersionDirs(entries);

      // Should filter out malformed versions
      expect(sorted).toContain('v22.17.0');
      expect(sorted).toContain('v18.20.0');
      expect(sorted).not.toContain('v20.abc.1');
    });

    it('should handle patch version comparison correctly', () => {
      const entries = [
        { name: 'v20.0.1', isDirectory: () => true },
        { name: 'v20.0.10', isDirectory: () => true },
        { name: 'v20.0.2', isDirectory: () => true },
      ];

      const sorted = sortNvmVersionDirs(entries);

      expect(sorted).toEqual(['v20.0.10', 'v20.0.2', 'v20.0.1']);
    });
  });

  describe('buildClaudeDetectionResult', () => {
    it('should return null when validation fails', () => {
      const result = buildClaudeDetectionResult(
        '/path/to/claude',
        { valid: false, message: 'Not valid' },
        'nvm',
        'Found via NVM'
      );

      expect(result).toBeNull();
    });

    it('should return proper result when validation succeeds', () => {
      const result = buildClaudeDetectionResult(
        '/path/to/claude',
        { valid: true, version: '1.0.0', message: 'Valid' },
        'nvm',
        'Found via NVM'
      );

      expect(result).not.toBeNull();
      expect(result?.found).toBe(true);
      expect(result?.path).toBe('/path/to/claude');
      expect(result?.version).toBe('1.0.0');
      expect(result?.source).toBe('nvm');
      expect(result?.message).toContain('Found via NVM');
      expect(result?.message).toContain('/path/to/claude');
    });

    it('should include path in message', () => {
      const result = buildClaudeDetectionResult(
        '/home/user/.nvm/versions/node/v22.17.0/bin/claude',
        { valid: true, version: '2.0.0', message: 'OK' },
        'nvm',
        'Detected Claude CLI'
      );

      expect(result?.message).toContain('Detected Claude CLI');
      expect(result?.message).toContain('/home/user/.nvm/versions/node/v22.17.0/bin/claude');
    });
  });
});

/**
 * Unit tests for Claude CLI Windows where.exe detection
 */
describe('cli-tool-manager - Claude CLI Windows where.exe detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      writable: true
    });
  });

  afterEach(() => {
    clearToolCache();
  });

  it('should detect Claude CLI via where.exe when not in PATH', () => {
    vi.mocked(os.homedir).mockReturnValue('C:\\Users\\test');

    // Mock findExecutable returns null (not in PATH)
    vi.mocked(findExecutable).mockReturnValue(null);

    // Mock where.exe finds it in nvm-windows location
    vi.mocked(findWindowsExecutableViaWhere).mockReturnValue(
      'D:\\Program Files\\nvm4w\\nodejs\\claude.cmd'
    );

    // Mock file system checks
    vi.mocked(existsSync).mockImplementation((filePath) => {
      const pathStr = String(filePath);
      if (pathStr.includes('nvm4w') && pathStr.includes('claude.cmd')) {
        return true;
      }
      return false;
    });

    // Mock validation success
    vi.mocked(execFileSync).mockReturnValue('claude-code version 1.0.0\n');

    const result = getToolInfo('claude');

    expect(result.found).toBe(true);
    expect(result.path).toContain('nvm4w');
    expect(result.path).toContain('claude.cmd');
    expect(result.source).toBe('system-path');
    expect(result.message).toContain('Using Windows Claude CLI');
  });

  it('should skip where.exe on non-Windows platforms', () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      writable: true
    });

    vi.mocked(findWindowsExecutableViaWhere).mockReturnValue(null);

    // Mock other detection methods to fail
    vi.mocked(existsSync).mockReturnValue(false);

    getToolInfo('claude');

    // where.exe should not be called on macOS
    expect(findWindowsExecutableViaWhere).not.toHaveBeenCalled();
  });

  it('should validate Claude CLI before returning where.exe path', () => {
    vi.mocked(os.homedir).mockReturnValue('C:\\Users\\test');

    vi.mocked(findExecutable).mockReturnValue(null);

    vi.mocked(findWindowsExecutableViaWhere).mockReturnValue(
      'D:\\Tools\\claude.cmd'
    );

    // Mock file system to return false for all paths except where.exe result
    vi.mocked(existsSync).mockImplementation((filePath) => {
      const pathStr = String(filePath);
      if (pathStr.includes('Tools') && pathStr.includes('claude.cmd')) {
        return true;
      }
      return false;
    });

    // Mock validation failure (executable doesn't respond correctly)
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('Command failed');
    });

    const result = getToolInfo('claude');

    // Should not return the unvalidated path, fallback to not found
    expect(result.found).toBe(false);
    expect(result.source).toBe('fallback');
  });

  it('should fallback to platform paths if where.exe fails', () => {
    vi.mocked(os.homedir).mockReturnValue('C:\\Users\\test');

    vi.mocked(findExecutable).mockReturnValue(null);

    vi.mocked(findWindowsExecutableViaWhere).mockReturnValue(null);

    // Mock platform path exists (AppData npm global)
    vi.mocked(existsSync).mockImplementation((filePath) => {
      const pathStr = String(filePath);
      if (pathStr.includes('AppData') && pathStr.includes('npm') && pathStr.includes('claude.cmd')) {
        return true;
      }
      return false;
    });

    vi.mocked(execFileSync).mockReturnValue('claude-code version 1.0.0\n');

    const result = getToolInfo('claude');

    expect(result.found).toBe(true);
    expect(result.path).toContain('AppData');
    expect(result.path).toContain('npm');
    expect(result.path).toContain('claude.cmd');
  });

  it('should prefer .cmd/.exe paths when where.exe returns multiple results', () => {
    vi.mocked(os.homedir).mockReturnValue('C:\\Users\\test');

    vi.mocked(findExecutable).mockReturnValue(null);

    // Simulate where.exe returning path with .cmd extension (preferred over no extension)
    vi.mocked(findWindowsExecutableViaWhere).mockReturnValue(
      'D:\\Program Files\\nvm4w\\nodejs\\claude.cmd'
    );

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execFileSync).mockReturnValue('claude-code version 1.0.0\n');

    const result = getToolInfo('claude');

    expect(result.found).toBe(true);
    expect(result.path).toBe('D:\\Program Files\\nvm4w\\nodejs\\claude.cmd');
    expect(result.path).toMatch(/\.(cmd|exe)$/i);
  });

  it('should handle where.exe execution errors gracefully', () => {
    vi.mocked(os.homedir).mockReturnValue('C:\\Users\\test');

    vi.mocked(findExecutable).mockReturnValue(null);

    // Simulate where.exe error (returns null as designed)
    vi.mocked(findWindowsExecutableViaWhere).mockReturnValue(null);

    vi.mocked(existsSync).mockReturnValue(false);

    // Should not crash, should continue to next detection method
    const result = getToolInfo('claude');

    expect(result).toBeDefined();
    expect(result.found).toBe(false);
    expect(result.source).toBe('fallback');
  });
});

/**
 * Unit tests for async Claude CLI Windows where.exe detection
 */
describe('cli-tool-manager - Claude CLI async Windows where.exe detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      writable: true
    });
  });

  afterEach(() => {
    clearToolCache();
  });

  it('should detect Claude CLI via where.exe asynchronously', async () => {
    vi.mocked(os.homedir).mockReturnValue('C:\\Users\\test');

    vi.mocked(findExecutableAsync).mockResolvedValue(null);

    vi.mocked(findWindowsExecutableViaWhereAsync).mockResolvedValue(null);

    // Mock file system - no platform paths exist
    vi.mocked(existsSync).mockReturnValue(false);

    await getToolPathAsync('claude');

    // Verify where.exe was called on Windows
    expect(findWindowsExecutableViaWhereAsync).toHaveBeenCalledWith('claude', '[Claude CLI]');
  });

  it('should handle async where.exe errors gracefully', async () => {
    vi.mocked(os.homedir).mockReturnValue('C:\\Users\\test');

    vi.mocked(findExecutableAsync).mockResolvedValue(null);

    vi.mocked(findWindowsExecutableViaWhereAsync).mockResolvedValue(null);

    vi.mocked(existsSync).mockReturnValue(false);

    // Should not crash
    const result = await getToolPathAsync('claude');

    expect(result).toBe('claude'); // Fallback
  });
});

// ============================================================================
// Sync/async parity
// ============================================================================

type ParityOs = 'darwin' | 'win32' | 'linux';

interface ParityScenario {
  name: string;
  tool: CLITool;
  os: ParityOs;
  homeDir: string;
  /** Paths for which existsSync/existsAsync return true */
  existing?: string[];
  /** Version output keyed by command ("<cmd> <args without --version>"); 'error' throws */
  versionOutput?: Record<string, string>;
  /** findExecutable(cmd) results keyed by command name */
  pathLookup?: Record<string, string>;
  /** findWindowsExecutableViaWhere results keyed by tool name */
  where?: Record<string, string>;
  /** getWindowsExecutablePaths results keyed by log label (e.g. '[Git]') */
  windowsPatterns?: Record<string, string[]>;
  /** NVM-style directory listings: dir -> entry names */
  dirs?: Record<string, string[]>;
  /** Paths for which isSecurePath returns false */
  insecure?: string[];
  userConfig?: ToolConfig;
  expected: {
    found: boolean;
    path: string;
    source?: string;
    version?: string;
    messageContains?: string;
  };
}

const HOMES: Record<ParityOs, string> = {
  linux: '/home/u',
  darwin: '/Users/u',
  win32: 'C:\\Users\\u'
};

const TOOL_META: Record<
  CLITool,
  { label: string; configKey: keyof ToolConfig; lookup: string; output: (v: string) => string; notFound: string }
> = {
  python: {
    label: 'Python',
    configKey: 'pythonPath',
    lookup: 'python3',
    output: (v) => `Python ${v}`,
    notFound: 'Python 3.10.0+ not found'
  },
  git: {
    label: 'Git',
    configKey: 'gitPath',
    lookup: 'git',
    output: (v) => `git version ${v}`,
    notFound: 'Git not found'
  },
  gh: {
    label: 'GitHub CLI',
    configKey: 'githubCLIPath',
    lookup: 'gh',
    output: (v) => `gh version ${v} (2024-01-01)`,
    notFound: 'GitHub CLI (gh) not found'
  },
  glab: {
    label: 'GitLab CLI',
    configKey: 'gitlabCLIPath',
    lookup: 'glab',
    output: (v) => `glab ${v} (2024-01-01)`,
    notFound: 'GitLab CLI (glab) not found'
  },
  claude: {
    label: 'Claude CLI',
    configKey: 'claudePath',
    lookup: 'claude',
    output: (v) => `${v} (Claude Code)`,
    notFound: 'Claude CLI not found'
  }
};

const ALL_TOOLS: CLITool[] = ['python', 'git', 'gh', 'glab', 'claude'];

/** Key used to look up version output: command + args minus the trailing --version */
function versionKey(cmd: string, args: readonly string[]): string {
  // Windows .cmd/.bat files are run through cmd.exe /d /s /c ""<path>" --version"
  if (args[2] === '/c' && typeof args[3] === 'string') {
    const m = /^""(.*)" --version"$/.exec(args[3]);
    if (m) return m[1];
  }
  return [cmd, ...args.filter((a) => a !== '--version')].join(' ');
}

/** Build the generic scenarios that apply to every tool */
function commonScenarios(tool: CLITool): ParityScenario[] {
  const meta = TOOL_META[tool];
  const out = meta.output('3.12.1');
  const sysPath = `/usr/bin/${meta.lookup}`;
  const homebrewPath = `/opt/homebrew/bin/${tool}`;
  const label = (s: string) => `${tool}: ${s}`;

  const scenarios: ParityScenario[] = [
    {
      name: label('user-config valid'),
      tool,
      os: 'linux',
      homeDir: HOMES.linux,
      userConfig: { [meta.configKey]: `/opt/custom/${tool}` },
      versionOutput: { [`/opt/custom/${tool}`]: out, [sysPath]: out },
      pathLookup: { [meta.lookup]: sysPath },
      expected: {
        found: true,
        path: `/opt/custom/${tool}`,
        source: 'user-config',
        version: out.match(/\d+\.\d+\.\d+/)?.[0],
        messageContains: `Using user-configured ${meta.label}`
      }
    },
    {
      name: label('user-config from the wrong platform is ignored'),
      tool,
      os: 'linux',
      homeDir: HOMES.linux,
      userConfig: { [meta.configKey]: `C:\\Tools\\${tool}.exe` },
      versionOutput: { [`C:\\Tools\\${tool}.exe`]: out, [sysPath]: out },
      pathLookup: { [meta.lookup]: sysPath },
      expected: { found: true, path: sysPath, source: 'system-path' }
    },
    {
      name: label('user-config invalid falls through'),
      tool,
      os: 'linux',
      homeDir: HOMES.linux,
      userConfig: { [meta.configKey]: `/opt/broken/${tool}` },
      versionOutput: { [sysPath]: out },
      pathLookup: { [meta.lookup]: sysPath },
      expected: { found: true, path: sysPath, source: 'system-path', messageContains: `Using system ${meta.label}` }
    },
    {
      name: label('PATH lookup'),
      tool,
      os: 'linux',
      homeDir: HOMES.linux,
      versionOutput: { [sysPath]: out },
      pathLookup: { [meta.lookup]: sysPath },
      expected: { found: true, path: sysPath, source: 'system-path', version: out.match(/\d+\.\d+\.\d+/)?.[0] }
    },
    {
      name: label('Homebrew skipped on linux'),
      tool,
      os: 'linux',
      homeDir: HOMES.linux,
      existing: [homebrewPath],
      versionOutput: { [homebrewPath]: out, [sysPath]: out },
      pathLookup: { [meta.lookup]: sysPath },
      expected: { found: true, path: sysPath, source: 'system-path' }
    },
    {
      name: label('Homebrew skipped on win32'),
      tool,
      os: 'win32',
      homeDir: HOMES.win32,
      existing: [homebrewPath],
      versionOutput: { [homebrewPath]: out, 'C:\\Tools\\path.exe': out },
      pathLookup: { [meta.lookup]: 'C:\\Tools\\path.exe' },
      expected: { found: true, path: 'C:\\Tools\\path.exe', source: 'system-path' }
    },
    {
      name: label('not found falls back to tool name'),
      tool,
      os: 'linux',
      homeDir: HOMES.linux,
      expected: {
        found: false,
        path: tool,
        source: 'fallback',
        messageContains: meta.notFound
      }
    }
  ];

  // Python's Homebrew candidates are a list; it has its own scenario in EXTRA_SCENARIOS
  if (tool !== 'python') {
    scenarios.push({
      name: label('Homebrew wins over PATH on darwin'),
      tool,
      os: 'darwin',
      homeDir: HOMES.darwin,
      existing: [homebrewPath],
      versionOutput: { [homebrewPath]: out, [sysPath]: out },
      pathLookup: { [meta.lookup]: sysPath },
      expected: {
        found: true,
        path: homebrewPath,
        source: 'homebrew',
        messageContains: `Using Homebrew ${meta.label}`
      }
    });
  }

  return scenarios;
}

const nvmDir = (home: string) => nodePath.join(home, '.nvm', 'versions', 'node');
const nvmClaude = (home: string, v: string) => nodePath.join(nvmDir(home), v, 'bin', 'claude');
const claudeOut = TOOL_META.claude.output('1.2.3');

const EXTRA_SCENARIOS: ParityScenario[] = [
  {
    name: 'git win32: where.exe',
    tool: 'git',
    os: 'win32',
    homeDir: HOMES.win32,
    where: { git: 'D:\\Dev\\Git\\git.exe' },
    versionOutput: { 'D:\\Dev\\Git\\git.exe': TOOL_META.git.output('2.40.0') },
    expected: {
      found: true,
      path: 'D:\\Dev\\Git\\git.exe',
      source: 'system-path',
      version: '2.40.0',
      messageContains: 'Using Windows Git'
    }
  },
  {
    name: 'claude win32: where.exe',
    tool: 'claude',
    os: 'win32',
    homeDir: HOMES.win32,
    where: { claude: 'D:\\Tools\\claude.exe' },
    versionOutput: { 'D:\\Tools\\claude.exe': claudeOut },
    expected: {
      found: true,
      path: 'D:\\Tools\\claude.exe',
      source: 'system-path',
      version: '1.2.3',
      messageContains: 'Using Windows Claude CLI'
    }
  },
  {
    name: 'git win32: Windows pattern paths',
    tool: 'git',
    os: 'win32',
    homeDir: HOMES.win32,
    windowsPatterns: { '[Git]': ['C:\\Missing\\git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe'] },
    versionOutput: { 'C:\\Program Files\\Git\\cmd\\git.exe': TOOL_META.git.output('2.41.0') },
    expected: {
      found: true,
      path: 'C:\\Program Files\\Git\\cmd\\git.exe',
      source: 'system-path',
      messageContains: 'Using Windows Git'
    }
  },
  {
    name: 'glab win32: Windows pattern paths',
    tool: 'glab',
    os: 'win32',
    homeDir: HOMES.win32,
    windowsPatterns: { '[GitLab CLI]': ['C:\\Program Files\\glab\\glab.exe'] },
    versionOutput: { 'C:\\Program Files\\glab\\glab.exe': TOOL_META.glab.output('1.40.0') },
    expected: {
      found: true,
      path: 'C:\\Program Files\\glab\\glab.exe',
      source: 'system-path',
      version: '1.40.0',
      messageContains: 'Using Windows GitLab CLI'
    }
  },
  {
    name: 'gh win32: Program Files path',
    tool: 'gh',
    os: 'win32',
    homeDir: HOMES.win32,
    existing: ['C:\\Program Files\\GitHub CLI\\gh.exe'],
    versionOutput: { 'C:\\Program Files\\GitHub CLI\\gh.exe': TOOL_META.gh.output('2.40.0') },
    expected: {
      found: true,
      path: 'C:\\Program Files\\GitHub CLI\\gh.exe',
      source: 'system-path',
      messageContains: 'Using Windows GitHub CLI'
    }
  },
  ...(['linux', 'darwin'] as const).map(
    (os): ParityScenario => ({
      name: `claude ${os}: NVM newest version first`,
      tool: 'claude',
      os,
      homeDir: HOMES[os],
      existing: [nvmDir(HOMES[os]), nvmClaude(HOMES[os], 'v18.0.0'), nvmClaude(HOMES[os], 'v22.1.0'), nvmClaude(HOMES[os], 'v20.5.0')],
      dirs: { [nvmDir(HOMES[os])]: ['v18.0.0', 'v22.1.0', 'v20.5.0'] },
      versionOutput: {
        [nvmClaude(HOMES[os], 'v18.0.0')]: claudeOut,
        [nvmClaude(HOMES[os], 'v22.1.0')]: claudeOut,
        [nvmClaude(HOMES[os], 'v20.5.0')]: claudeOut
      },
      expected: {
        found: true,
        path: nvmClaude(HOMES[os], 'v22.1.0'),
        source: 'nvm',
        version: '1.2.3',
        messageContains: 'Using NVM Claude CLI'
      }
    })
  ),
  {
    name: 'claude win32: NVM skipped',
    tool: 'claude',
    os: 'win32',
    homeDir: HOMES.win32,
    existing: [nvmDir(HOMES.win32), nvmClaude(HOMES.win32, 'v22.1.0')],
    dirs: { [nvmDir(HOMES.win32)]: ['v22.1.0'] },
    versionOutput: { [nvmClaude(HOMES.win32, 'v22.1.0')]: claudeOut },
    expected: { found: false, path: 'claude', source: 'fallback' }
  },
  {
    name: 'claude linux: .local/bin platform path',
    tool: 'claude',
    os: 'linux',
    homeDir: HOMES.linux,
    existing: [nodePath.join(HOMES.linux, '.local', 'bin', 'claude')],
    versionOutput: { [nodePath.join(HOMES.linux, '.local', 'bin', 'claude')]: claudeOut },
    expected: {
      found: true,
      path: nodePath.join(HOMES.linux, '.local', 'bin', 'claude'),
      source: 'system-path',
      messageContains: 'Using Claude CLI'
    }
  },
  {
    name: 'claude win32: AppData npm claude.cmd platform path',
    tool: 'claude',
    os: 'win32',
    homeDir: HOMES.win32,
    existing: [nodePath.join(HOMES.win32, 'AppData', 'Roaming', 'npm', 'claude.cmd')],
    versionOutput: { [nodePath.join(HOMES.win32, 'AppData', 'Roaming', 'npm', 'claude.cmd')]: claudeOut },
    expected: {
      found: true,
      path: nodePath.join(HOMES.win32, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
      source: 'system-path',
      version: '1.2.3'
    }
  },
  {
    name: 'claude win32: insecure user-config rejected',
    tool: 'claude',
    os: 'win32',
    homeDir: HOMES.win32,
    userConfig: { claudePath: 'C:\\Tools\\claude.exe' },
    insecure: ['C:\\Tools\\claude.exe'],
    versionOutput: { 'C:\\Tools\\claude.exe': claudeOut, 'C:\\Other\\claude.exe': claudeOut },
    pathLookup: { claude: 'C:\\Other\\claude.exe' },
    expected: { found: true, path: 'C:\\Other\\claude.exe', source: 'system-path' }
  },
  {
    name: 'python: 3.9 rejected as too old, next candidate used',
    tool: 'python',
    os: 'linux',
    homeDir: HOMES.linux,
    pathLookup: { python3: '/usr/bin/python3', python: '/usr/bin/python' },
    versionOutput: { '/usr/bin/python3': 'Python 3.9.18', '/usr/bin/python': 'Python 3.11.2' },
    expected: { found: true, path: '/usr/bin/python', source: 'system-path', version: '3.11.2' }
  },
  {
    name: 'python: only 3.9 available -> not found',
    tool: 'python',
    os: 'linux',
    homeDir: HOMES.linux,
    pathLookup: { python3: '/usr/bin/python3' },
    versionOutput: { '/usr/bin/python3': 'Python 3.9.18' },
    expected: { found: false, path: 'python', source: 'fallback' }
  },
  {
    name: 'python: 3.10 accepted',
    tool: 'python',
    os: 'linux',
    homeDir: HOMES.linux,
    pathLookup: { python3: '/usr/bin/python3' },
    versionOutput: { '/usr/bin/python3': 'Python 3.10.0' },
    expected: { found: true, path: '/usr/bin/python3', source: 'system-path', version: '3.10.0' }
  },
  {
    name: "python win32: 'py -3' launcher used first",
    tool: 'python',
    os: 'win32',
    homeDir: HOMES.win32,
    pathLookup: { python: 'C:\\Python\\python.exe' },
    versionOutput: { 'py -3': 'Python 3.12.0', 'C:\\Python\\python.exe': 'Python 3.11.0' },
    expected: { found: true, path: 'py -3', source: 'system-path', version: '3.12.0' }
  },
  {
    name: 'python darwin: Homebrew python3.12 found by both sync and async',
    tool: 'python',
    os: 'darwin',
    homeDir: HOMES.darwin,
    existing: ['/opt/homebrew/bin/python3.12'],
    versionOutput: { '/opt/homebrew/bin/python3.12': 'Python 3.12.4' },
    expected: {
      found: true,
      path: '/opt/homebrew/bin/python3.12',
      source: 'homebrew',
      version: '3.12.4',
      messageContains: 'Using Homebrew Python'
    }
  }
];

const PARITY_SCENARIOS: ParityScenario[] = [...ALL_TOOLS.flatMap(commonScenarios), ...EXTRA_SCENARIOS];

describe('cli-tool-manager - sync/async parity', () => {
  const originalPlatform = process.platform;

  function arrange(s: ParityScenario): void {
    Object.defineProperty(process, 'platform', { value: s.os, writable: true });
    vi.mocked(os.homedir).mockReturnValue(s.homeDir);

    const existing = new Set(s.existing ?? []);
    vi.mocked(existsSync).mockImplementation((p) => existing.has(String(p)));

    const direntsFor = (dir: unknown): MockDirent[] =>
      (s.dirs?.[String(dir)] ?? []).map((name) => createDirent(name, true));
    vi.mocked(readdirSync).mockImplementation(((dir: unknown) => direntsFor(dir)) as unknown as typeof readdirSync);
    vi.mocked(fsPromises.readdir).mockImplementation((async (dir: unknown) =>
      direntsFor(dir)) as unknown as typeof fsPromises.readdir);

    // One table drives both execFileSync and promisified execFile
    vi.mocked(execFileSync).mockImplementation(((cmd: string, args: readonly string[] = []) => {
      const key = versionKey(cmd, args);
      const output = s.versionOutput?.[key];
      if (output === undefined) {
        throw new Error(`ENOENT: ${key}`);
      }
      return `${output}\n`;
    }) as unknown as typeof execFileSync);

    const lookup = (cmd: string) => s.pathLookup?.[cmd] ?? null;
    vi.mocked(findExecutable).mockImplementation(lookup);
    vi.mocked(findExecutableAsync).mockImplementation(async (cmd: string) => lookup(cmd));

    const where = (tool: string) => s.where?.[tool] ?? null;
    vi.mocked(findWindowsExecutableViaWhere).mockImplementation(where);
    vi.mocked(findWindowsExecutableViaWhereAsync).mockImplementation(async (tool: string) => where(tool));

    const patterns = (_paths: unknown, logPrefix?: string) => s.windowsPatterns?.[logPrefix ?? ''] ?? [];
    vi.mocked(getWindowsExecutablePaths).mockImplementation(patterns as unknown as typeof getWindowsExecutablePaths);
    vi.mocked(getWindowsExecutablePathsAsync).mockImplementation((async (...a: [unknown, string?]) =>
      patterns(...a)) as unknown as typeof getWindowsExecutablePathsAsync);

    const insecure = new Set(s.insecure ?? []);
    vi.mocked(isSecurePath).mockImplementation((p: string) => !insecure.has(p));
  }

  async function run(s: ParityScenario) {
    arrange(s);

    configureTools(s.userConfig ?? {});
    clearToolCache();
    const syncPath = getToolPath(s.tool);
    const info = getToolInfo(s.tool);
    const asyncInfo = await getToolInfoAsync(s.tool);

    configureTools(s.userConfig ?? {});
    clearToolCache();
    const asyncPath = await getToolPathAsync(s.tool);

    return { syncPath, asyncPath, info, asyncInfo };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    configureTools({});
    clearToolCache();
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
  });

  describe.each(PARITY_SCENARIOS)('$name', (scenario) => {
    it('sync and async return the same expected path', async () => {
      const { syncPath, asyncPath } = await run(scenario);
      expect(syncPath).toBe(scenario.expected.path);
      expect(asyncPath).toBe(syncPath);
    });

    it('getToolInfo reports the expected metadata', async () => {
      const { info } = await run(scenario);
      const { expected } = scenario;
      expect(info.found).toBe(expected.found);
      if (expected.found) expect(info.path).toBe(expected.path);
      if (expected.source) expect(info.source).toBe(expected.source);
      if (expected.version) expect(info.version).toBe(expected.version);
      if (expected.messageContains) expect(info.message).toContain(expected.messageContains);
    });

    it('getToolInfoAsync matches getToolInfo', async () => {
      const { info, asyncInfo } = await run(scenario);
      expect(asyncInfo.found).toBe(info.found);
      expect(asyncInfo.path).toBe(info.path);
      expect(asyncInfo.version).toBe(info.version);
      expect(asyncInfo.source).toBe(info.source);
      expect(asyncInfo.message).toBe(info.message);
    });
  });
});
