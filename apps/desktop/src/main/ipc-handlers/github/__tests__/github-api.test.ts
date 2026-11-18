import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../../../shared/types';
import { normalizeRepoReference, readGitHubEnvConfig } from '../github-api';

describe('github-api', () => {
  let dir: string;
  const makeProject = (env?: string): Project => {
    if (env !== undefined) {
      mkdirSync(path.join(dir, '.auto-claude'), { recursive: true });
      writeFileSync(path.join(dir, '.auto-claude', '.env'), env);
    }
    return { id: 'p', name: 'p', path: dir, autoBuildPath: '.auto-claude' } as Project;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'gh-api-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses token and repo from .env', () => {
    expect(readGitHubEnvConfig(makeProject('GITHUB_TOKEN=abc\nGITHUB_REPO=o/r\n'))).toEqual({
      token: 'abc',
      repo: 'o/r'
    });
  });

  it('returns null when token missing and no fallback', () => {
    expect(readGitHubEnvConfig(makeProject('GITHUB_REPO=o/r\n'))).toBeNull();
  });

  it('uses the fallback when token missing', () => {
    const fallback = vi.fn(() => 'fb');
    expect(readGitHubEnvConfig(makeProject('GITHUB_REPO=o/r\n'), fallback)).toEqual({
      token: 'fb',
      repo: 'o/r'
    });
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('does not call the fallback when .env has a token', () => {
    const fallback = vi.fn(() => 'fb');
    readGitHubEnvConfig(makeProject('GITHUB_TOKEN=abc\nGITHUB_REPO=o/r\n'), fallback);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('returns null without autoBuildPath or .env file', () => {
    expect(readGitHubEnvConfig({ id: 'p', name: 'p', path: dir } as Project)).toBeNull();
    expect(readGitHubEnvConfig(makeProject())).toBeNull();
  });

  it('normalizes repo references', () => {
    expect(normalizeRepoReference('o/r')).toBe('o/r');
    expect(normalizeRepoReference('https://github.com/o/r.git')).toBe('o/r');
    expect(normalizeRepoReference('git@github.com:o/r.git')).toBe('o/r');
    expect(normalizeRepoReference('')).toBe('');
  });
});
