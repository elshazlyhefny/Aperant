import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createAutoFixStore,
  DEFAULT_AUTOFIX_CONFIG,
  getDefaultAutoFixConfig,
} from '../autofix-store';
import type { Project } from '../../../../shared/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
const githubParams = {
  providerDir: 'github' as const,
  extraConfigKeys: { botToken: 'bot_token' },
  mapQueueItem: (data: any) => ({
    issueNumber: data.issue_number,
    repo: data.repo,
    status: data.status,
    specId: data.spec_id,
    prNumber: data.pr_number,
    error: data.error,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  }),
  mapBatch: (data: any) => ({
    batchId: data.batch_id,
    repo: data.repo,
    primaryIssue: data.primary_issue,
    issues: data.issues.map((i: any) => ({
      issueNumber: i.issue_number,
      title: i.title,
      similarityToPrimary: i.similarity_to_primary,
    })),
    commonThemes: data.common_themes ?? [],
    status: data.status,
    createdAt: data.created_at,
  }),
  compareBatches: (a: any, b: any) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
};

const gitlabParams = {
  providerDir: 'gitlab' as const,
  mapQueueItem: (data: any) => ({
    issueIid: data.issue_iid,
    project: data.project,
    status: data.status,
    specId: data.spec_id,
    mrIid: data.mr_iid,
    error: data.error,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  }),
  mapBatch: (data: any) => ({
    id: data.batch_id,
    issues: data.issues.map((i: any) => ({
      iid: i.iid,
      title: i.title,
      similarity: (i.similarity as number) ?? 1.0,
    })),
    commonThemes: data.common_themes ?? [],
    confidence: data.confidence ?? 1.0,
    reasoning: data.reasoning ?? '',
  }),
};

let tmpDir: string;
let project: Project;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-store-'));
  project = { path: tmpDir } as Project;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(rel: string, content: unknown): void {
  const full = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content), 'utf-8');
}

describe.each([
  ['github', githubParams],
  ['gitlab', gitlabParams],
] as const)('autofix store (%s)', (name, params) => {
  const store = createAutoFixStore<any, any, any>(params as any);
  const configRel = `.auto-claude/${name}/config.json`;

  it('returns defaults when no file exists', () => {
    expect(store.getConfig(project)).toEqual(DEFAULT_AUTOFIX_CONFIG);
  });

  it('returns defaults on corrupt JSON', () => {
    write(configRel, '{not json');
    expect(store.getConfig(project)).toEqual(DEFAULT_AUTOFIX_CONFIG);
  });

  it('round-trips save then get', () => {
    const config = {
      enabled: true,
      labels: ['bug', 'fix'],
      requireHumanApproval: false,
      model: 'm',
      thinkingLevel: 'high',
    };
    store.saveConfig(project, config);
    expect(store.getConfig(project)).toMatchObject(config);
  });

  it('preserves unknown keys already on disk', () => {
    write(configRel, { custom_key: 'keep', auto_fix_enabled: false });
    store.saveConfig(project, { ...getDefaultAutoFixConfig(), enabled: true });
    const disk = JSON.parse(fs.readFileSync(path.join(tmpDir, configRel), 'utf-8'));
    expect(disk.custom_key).toBe('keep');
    expect(disk.auto_fix_enabled).toBe(true);
  });

  it('writes the expected on-disk keys', () => {
    store.saveConfig(project, getDefaultAutoFixConfig());
    const disk = JSON.parse(fs.readFileSync(path.join(tmpDir, configRel), 'utf-8'));
    expect(disk).toMatchObject({
      auto_fix_enabled: false,
      auto_fix_labels: ['auto-fix'],
      require_human_approval: true,
      model: 'claude-sonnet-4-6',
      thinking_level: 'medium',
    });
  });

  it('handles botToken per provider', () => {
    store.saveConfig(project, { ...getDefaultAutoFixConfig(), botToken: 'tok' });
    const disk = JSON.parse(fs.readFileSync(path.join(tmpDir, configRel), 'utf-8'));
    if (name === 'github') {
      expect(disk.bot_token).toBe('tok');
      expect(store.getConfig(project).botToken).toBe('tok');
    } else {
      expect(disk).not.toHaveProperty('bot_token');
    }
  });

  it('sorts the queue newest first', () => {
    write(`.auto-claude/${name}/issues/autofix_1.json`, { issue_number: 1, issue_iid: 1, created_at: '2024-01-01T00:00:00Z' });
    write(`.auto-claude/${name}/issues/autofix_2.json`, { issue_number: 2, issue_iid: 2, created_at: '2024-03-01T00:00:00Z' });
    write(`.auto-claude/${name}/issues/autofix_3.json`, { issue_number: 3, issue_iid: 3, created_at: '2024-02-01T00:00:00Z' });
    const ids = store.getQueue(project).map((q: any) => q.issueNumber ?? q.issueIid);
    expect(ids).toEqual([2, 3, 1]);
  });

  it('skips non-matching and corrupt queue files', () => {
    write(`.auto-claude/${name}/issues/autofix_1.json`, { issue_number: 1, issue_iid: 1, created_at: '2024-01-01T00:00:00Z' });
    write(`.auto-claude/${name}/issues/autofix_bad.json`, 'oops');
    write(`.auto-claude/${name}/issues/other_2.json`, { issue_number: 2, created_at: '2024-01-01T00:00:00Z' });
    write(`.auto-claude/${name}/issues/autofix_3.txt`, { issue_number: 3 });
    expect(store.getQueue(project)).toHaveLength(1);
  });

  it('returns [] for a missing queue or batches dir', () => {
    expect(store.getQueue(project)).toEqual([]);
    expect(store.getBatches(project)).toEqual([]);
  });

  it('maps batches and skips corrupt ones', () => {
    write(`.auto-claude/${name}/batches/batch_bad.json`, '{');
    if (name === 'gitlab') {
      write(`.auto-claude/${name}/batches/batch_a.json`, {
        batch_id: 'a',
        issues: [{ iid: 4, title: 'T' }],
      });
      expect(store.getBatches(project)).toEqual([
        {
          id: 'a',
          issues: [{ iid: 4, title: 'T', similarity: 1.0 }],
          commonThemes: [],
          confidence: 1.0,
          reasoning: '',
        },
      ]);
    } else {
      write(`.auto-claude/${name}/batches/batch_old.json`, {
        batch_id: 'old',
        created_at: '2024-01-01T00:00:00Z',
        issues: [{ issue_number: 1, title: 'x', similarity_to_primary: 0.5 }],
      });
      write(`.auto-claude/${name}/batches/batch_new.json`, {
        batch_id: 'new',
        created_at: '2024-05-01T00:00:00Z',
        issues: [],
      });
      const batches = store.getBatches(project);
      expect(batches.map((b: any) => b.batchId)).toEqual(['new', 'old']);
      expect(batches[1].issues[0]).toEqual({ issueNumber: 1, title: 'x', similarityToPrimary: 0.5 });
    }
  });

  it('getDir returns the provider directory inside the project', () => {
    expect(store.getDir(project)).toBe(path.join(tmpDir, '.auto-claude', name));
  });
});

describe('path traversal', () => {
  it('rejects a providerDir that escapes the project', () => {
    const store = createAutoFixStore<any, any, any>({
      ...gitlabParams,
      providerDir: '../../../escape' as any,
    });
    expect(() => store.getDir(project)).toThrow('Invalid path: path traversal detected');
    expect(() => store.getConfig(project)).toThrow('Invalid path: path traversal detected');
    expect(() => store.saveConfig(project, getDefaultAutoFixConfig())).toThrow(
      'Invalid path: path traversal detected'
    );
    expect(() => store.getQueue(project)).toThrow('Invalid path: path traversal detected');
  });
});

describe('DEFAULT_AUTOFIX_CONFIG', () => {
  it('has the expected values', () => {
    expect(DEFAULT_AUTOFIX_CONFIG).toEqual({
      enabled: false,
      labels: ['auto-fix'],
      requireHumanApproval: true,
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'medium',
    });
  });

  it('is not mutated when a caller edits the returned labels', () => {
    const store = createAutoFixStore<any, any, any>(gitlabParams as any);
    store.getConfig(project).labels.push('mutated');
    getDefaultAutoFixConfig().labels.push('mutated');
    expect(store.getConfig(project).labels).toEqual(['auto-fix']);
    expect(DEFAULT_AUTOFIX_CONFIG.labels).toEqual(['auto-fix']);
  });
});
