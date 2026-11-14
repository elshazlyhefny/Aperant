import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';

vi.mock('child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('fs', () => ({ existsSync: vi.fn(), readdirSync: vi.fn() }));
vi.mock('../../cli-tool-manager', () => ({ getToolPath: vi.fn(() => 'git') }));
vi.mock('../../../shared/utils/debug-logger', () => ({
  debugLog: vi.fn(),
  debugError: vi.fn(),
}));

import { execFileSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { fixMisconfiguredBareRepo, GIT_BRANCH_REGEX } from '../git-repo-repair';

const mockExec = vi.mocked(execFileSync);
const mockExists = vi.mocked(existsSync);
const mockReaddir = vi.mocked(readdirSync);

const projectPath = '/tmp/project';

function unsetCalls() {
  return mockExec.mock.calls.filter(
    (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('--unset')
  );
}

describe('fixMisconfiguredBareRepo', () => {
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GIT_DIR = '/some/other/.git';
    process.env.GIT_WORK_TREE = '/some/other';
    mockExists.mockReturnValue(false);
    mockReaddir.mockReturnValue([] as never);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('returns false when repo is not bare', () => {
    mockExec.mockReturnValueOnce('false\n' as never);
    expect(fixMisconfiguredBareRepo(projectPath)).toBe(false);
    expect(unsetCalls()).toHaveLength(0);
  });

  it('fixes a bare repo that has package.json', () => {
    mockExec.mockReturnValue('true\n' as never);
    mockExists.mockImplementation((p) => p === path.join(projectPath, 'package.json'));
    expect(fixMisconfiguredBareRepo(projectPath)).toBe(true);
    expect(unsetCalls()).toHaveLength(1);
  });

  it('fixes a bare repo that only has a *.csproj', () => {
    mockExec.mockReturnValue('true\n' as never);
    mockReaddir.mockReturnValue(['App.csproj'] as never);
    expect(fixMisconfiguredBareRepo(projectPath)).toBe(true);
    expect(unsetCalls()).toHaveLength(1);
  });

  it('leaves a truly bare repo alone', () => {
    mockExec.mockReturnValue('true\n' as never);
    mockReaddir.mockReturnValue(['HEAD', 'objects', 'refs'] as never);
    expect(fixMisconfiguredBareRepo(projectPath)).toBe(false);
    expect(unsetCalls()).toHaveLength(0);
  });

  it('returns false when config --get throws', () => {
    mockExec.mockImplementation(() => {
      throw new Error('exit 1');
    });
    expect(fixMisconfiguredBareRepo(projectPath)).toBe(false);
  });

  it('passes an isolated env to every git call', () => {
    mockExec.mockReturnValue('true\n' as never);
    mockExists.mockImplementation((p) => p === path.join(projectPath, 'package.json'));
    fixMisconfiguredBareRepo(projectPath);
    expect(mockExec).toHaveBeenCalledTimes(2);
    for (const call of mockExec.mock.calls) {
      const env = (call[2] as { env?: NodeJS.ProcessEnv }).env;
      expect(env).toBeDefined();
      expect(env).not.toHaveProperty('GIT_DIR');
      expect(env).not.toHaveProperty('GIT_WORK_TREE');
      expect(env?.HUSKY).toBe('0');
    }
  });
});

describe('GIT_BRANCH_REGEX', () => {
  it('accepts valid branch names', () => {
    expect(GIT_BRANCH_REGEX.test('main')).toBe(true);
    expect(GIT_BRANCH_REGEX.test('feature/x')).toBe(true);
  });

  it('rejects invalid branch names', () => {
    expect(GIT_BRANCH_REGEX.test('')).toBe(false);
    expect(GIT_BRANCH_REGEX.test('-bad')).toBe(false);
  });
});
