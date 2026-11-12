/**
 * zeenha fork: the PR body model is given the project's own running/testing
 * conventions and the QA report, so its Testing section stops inventing
 * commands (PR #219 told reviewers to run `php artisan migrate` on the host).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  appendIssueLines,
  buildPRBodyPrompt,
  extractConventionSections,
  readSourceIssueLines,
} from '../pr-creator';

const CLAUDE_MD = `# CLAUDE.md

## What this is
Multi-tenant POS.

## Running things
- **Docker only.** \`docker compose exec app php artisan <cmd>\`
- **Tests:** \`scripts/test-backend.sh [--filter=<TestName>]\`

### Dev overlay
pass both compose files

## Tenancy rules (load-bearing)
never trust X-Tenant-Id

## Testing
see docs/guides/testing.md
`;

describe('extractConventionSections', () => {
  it('keeps the running and testing sections with their subsections, and nothing else', () => {
    const out = extractConventionSections(CLAUDE_MD);
    expect(out).toContain('scripts/test-backend.sh');
    expect(out).toContain('### Dev overlay\npass both compose files');
    expect(out).toContain('## Testing\nsee docs/guides/testing.md');
    expect(out).not.toContain('Multi-tenant POS');
    expect(out).not.toContain('X-Tenant-Id');
  });

  it('is empty when no heading is about running or testing, and is capped', () => {
    expect(extractConventionSections('# T\n\n## Overview\ntext\n')).toBe('');
    expect(extractConventionSections(`## Running\n${'x'.repeat(20_000)}`).length).toBeLessThanOrEqual(6_000);
  });
});

describe('buildPRBodyPrompt', () => {
  const ctx = { specId: '039-x', title: 'T', baseBranch: 'main', branchName: 'auto-claude/039-x', diffSummary: 'd', commitLog: 'c' };

  it('includes the conventions and the QA report', () => {
    const prompt = buildPRBodyPrompt({ ...ctx, conventions: 'Docker only', qaReport: 'Status: PASSED' });
    expect(prompt).toContain('Docker only');
    expect(prompt).toContain('Status: PASSED');
  });

  it('tells the model to write no commands when it knows none', () => {
    const prompt = buildPRBodyPrompt({ ...ctx, conventions: '', qaReport: '' });
    expect(prompt).toContain('(none found: do not write any commands)');
    expect(prompt).toContain('(no QA report: say that verification was not recorded)');
  });
});

describe('appendIssueLines', () => {
  it('returns the body unchanged when there are no lines', () => {
    expect(appendIssueLines('body', [])).toBe('body');
  });

  it('appends the lines after a body that lacks them', () => {
    expect(appendIssueLines('## Summary\ntext', ['Fixes #5', 'PROJ-1'])).toBe('## Summary\ntext\n\nFixes #5\nPROJ-1');
  });

  it('does not duplicate a line the body already has', () => {
    const body = 'text\n\nFixes #5';
    expect(appendIssueLines(body, ['Fixes #5'])).toBe(body);
  });

  it('still appends "Fixes #5" when the body only has "Fixes #55"', () => {
    expect(appendIssueLines('text\nFixes #55', ['Fixes #5'])).toBe('text\nFixes #55\n\nFixes #5');
  });

  it('works on the spec-summary fallback text', () => {
    expect(appendIssueLines('Implements 054-x', ['Closes #7'])).toBe('Implements 054-x\n\nCloses #7');
  });
});

describe('readSourceIssueLines', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const makeRoot = (meta?: unknown): string => {
    const root = mkdtempSync(join(tmpdir(), 'pr-creator-'));
    dirs.push(root);
    if (meta !== undefined) {
      const specDir = join(root, '.auto-claude', 'specs', '054-x');
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, 'task_metadata.json'), JSON.stringify(meta));
    }
    return root;
  };

  it('reads github, gitlab, jira and linear refs', () => {
    const none = makeRoot();
    expect(readSourceIssueLines(none, makeRoot({ githubIssueNumber: 12 }), '054-x')).toEqual(['Fixes #12']);
    expect(readSourceIssueLines(none, makeRoot({ gitlabIssueIid: 8 }), '054-x')).toEqual(['Closes #8']);
    expect(readSourceIssueLines(none, makeRoot({ jiraIssueKey: 'PROJ-123' }), '054-x')).toEqual(['PROJ-123']);
    expect(readSourceIssueLines(none, makeRoot({ linearIdentifier: 'ABC-123' }), '054-x')).toEqual(['Fixes ABC-123']);
  });

  it('prefers the main project over the worktree', () => {
    const main = makeRoot({ githubIssueNumber: 1 });
    const wt = makeRoot({ githubIssueNumber: 2 });
    expect(readSourceIssueLines(wt, main, '054-x')).toEqual(['Fixes #1']);
  });

  it('falls back to the worktree when main has none', () => {
    const wt = makeRoot({ githubIssueNumber: 2 });
    expect(readSourceIssueLines(wt, makeRoot(), '054-x')).toEqual(['Fixes #2']);
    expect(readSourceIssueLines(wt, makeRoot({ title: 'no refs' }), '054-x')).toEqual(['Fixes #2']);
  });

  it('yields no lines for invalid values or a missing spec dir', () => {
    const bad = makeRoot({ githubIssueNumber: -3, jiraIssueKey: 'proj 1; rm', linearIdentifier: 5 });
    expect(readSourceIssueLines(makeRoot(), bad, '054-x')).toEqual([]);
    expect(readSourceIssueLines(makeRoot(), makeRoot(), '054-x')).toEqual([]);
  });
});
