/**
 * zeenha fork: the PR body model is given the project's own running/testing
 * conventions and the QA report, so its Testing section stops inventing
 * commands (PR #219 told reviewers to run `php artisan migrate` on the host).
 */
import { describe, expect, it } from 'vitest';

import { buildPRBodyPrompt, extractConventionSections } from '../pr-creator';

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
