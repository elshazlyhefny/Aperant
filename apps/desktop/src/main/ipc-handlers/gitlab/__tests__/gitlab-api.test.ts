import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../../../shared/types';
import {
  GitLabAPIError,
  encodeProjectPath,
  normalizeProjectReference,
  readGitLabEnvConfig
} from '../gitlab-api';
import * as utils from '../utils';

describe('gitlab-api', () => {
  let dir: string;
  const makeProject = (env: string): Project => {
    mkdirSync(path.join(dir, '.auto-claude'), { recursive: true });
    writeFileSync(path.join(dir, '.auto-claude', '.env'), env);
    return { id: 'p', name: 'p', path: dir, autoBuildPath: '.auto-claude' } as Project;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'gl-api-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses .env with default instance URL', async () => {
    const cfg = await readGitLabEnvConfig(makeProject('GITLAB_TOKEN=tok\nGITLAB_PROJECT=g/p\n'));
    expect(cfg).toEqual({ token: 'tok', instanceUrl: 'https://gitlab.com', project: 'g/p' });
  });

  it('honours a custom instance URL', async () => {
    const cfg = await readGitLabEnvConfig(
      makeProject('GITLAB_TOKEN=tok\nGITLAB_PROJECT=g/p\nGITLAB_INSTANCE_URL=https://git.example.com/\n')
    );
    expect(cfg?.instanceUrl).toBe('https://git.example.com');
  });

  it('returns null when GITLAB_ENABLED=false', async () => {
    const cfg = await readGitLabEnvConfig(
      makeProject('GITLAB_ENABLED=false\nGITLAB_TOKEN=tok\nGITLAB_PROJECT=g/p\n')
    );
    expect(cfg).toBeNull();
  });

  it('handles a missing token with and without fallback', async () => {
    const project = makeProject('GITLAB_PROJECT=g/p\n');
    expect(await readGitLabEnvConfig(project)).toBeNull();
    const fallback = vi.fn(() => 'fb');
    expect(await readGitLabEnvConfig(project, fallback)).toEqual({
      token: 'fb',
      instanceUrl: 'https://gitlab.com',
      project: 'g/p'
    });
    expect(fallback).toHaveBeenCalledWith('https://gitlab.com');
  });

  it('normalizes and encodes project references', () => {
    expect(normalizeProjectReference('https://gitlab.com/g/sub/p.git')).toBe('g/sub/p');
    expect(normalizeProjectReference('git@gitlab.com:g/p.git')).toBe('g/p');
    expect(normalizeProjectReference('42')).toBe('42');
    expect(encodeProjectPath('g/p')).toBe('g%2Fp');
    expect(encodeProjectPath('42')).toBe('42');
  });

  it('keeps GitLabAPIError identity across utils re-export', () => {
    expect(utils.GitLabAPIError).toBe(GitLabAPIError);
    expect(new GitLabAPIError('x', 404)).toBeInstanceOf(Error);
  });
});
