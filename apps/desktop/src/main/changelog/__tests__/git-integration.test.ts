/**
 * Tests that option-like git refs are rejected before reaching git.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockExecFileSync } = vi.hoisted(() => ({ mockExecFileSync: vi.fn(() => '') }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: mockExecFileSync
  };
});

vi.mock('../../cli-tool-manager', () => ({
  getToolPath: vi.fn(() => 'git')
}));

import { getCommits, getBranchDiffCommits } from '../git-integration';

const UNSAFE_REFS = ['--output=/tmp/x', '-n1', '--upload-pack=evil'];

describe('git-integration ref validation', () => {
  beforeEach(() => {
    mockExecFileSync.mockClear();
  });

  describe('getCommits', () => {
    for (const ref of UNSAFE_REFS) {
      it(`rejects fromTag ${ref} (tag-range)`, () => {
        expect(getCommits('/tmp/p', { type: 'tag-range', fromTag: ref, toTag: 'v2.0.0' })).toEqual([]);
        expect(mockExecFileSync).not.toHaveBeenCalled();
      });

      it(`rejects toTag ${ref} (tag-range)`, () => {
        expect(getCommits('/tmp/p', { type: 'tag-range', fromTag: 'v1.0.0', toTag: ref })).toEqual([]);
        expect(mockExecFileSync).not.toHaveBeenCalled();
      });

      it(`rejects fromTag ${ref} (since-version)`, () => {
        expect(getCommits('/tmp/p', { type: 'since-version', fromTag: ref })).toEqual([]);
        expect(mockExecFileSync).not.toHaveBeenCalled();
      });
    }

    it('rejects refs containing newline or NUL', () => {
      expect(getCommits('/tmp/p', { type: 'since-version', fromTag: 'v1\nx' })).toEqual([]);
      expect(getCommits('/tmp/p', { type: 'since-version', fromTag: 'v1\0x' })).toEqual([]);
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('passes normal tag refs to git', () => {
      getCommits('/tmp/p', { type: 'tag-range', fromTag: 'v1.0.0', toTag: 'v2.0.0' });
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
      const args = (mockExecFileSync.mock.calls[0] as unknown as [string, string[]])[1];
      expect(args).toContain('v1.0.0..v2.0.0');
    });

    it('defaults toTag to HEAD', () => {
      getCommits('/tmp/p', { type: 'tag-range', fromTag: 'v1.0.0' });
      const args = (mockExecFileSync.mock.calls[0] as unknown as [string, string[]])[1];
      expect(args).toContain('v1.0.0..HEAD');
    });

    it('passes since-version ref to git', () => {
      getCommits('/tmp/p', { type: 'since-version', fromTag: 'v1.0.0' });
      const args = (mockExecFileSync.mock.calls[0] as unknown as [string, string[]])[1];
      expect(args).toContain('v1.0.0..HEAD');
    });
  });

  describe('getBranchDiffCommits', () => {
    for (const ref of UNSAFE_REFS) {
      it(`rejects baseBranch ${ref}`, () => {
        expect(getBranchDiffCommits('/tmp/p', { baseBranch: ref, compareBranch: 'feature/foo' })).toEqual([]);
        expect(mockExecFileSync).not.toHaveBeenCalled();
      });

      it(`rejects compareBranch ${ref}`, () => {
        expect(getBranchDiffCommits('/tmp/p', { baseBranch: 'origin/main', compareBranch: ref })).toEqual([]);
        expect(mockExecFileSync).not.toHaveBeenCalled();
      });
    }

    it('passes normal branches to git', () => {
      getBranchDiffCommits('/tmp/p', { baseBranch: 'origin/main', compareBranch: 'feature/foo' });
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
      const args = (mockExecFileSync.mock.calls[0] as unknown as [string, string[]])[1];
      expect(args).toContain('origin/main..feature/foo');
    });
  });
});
