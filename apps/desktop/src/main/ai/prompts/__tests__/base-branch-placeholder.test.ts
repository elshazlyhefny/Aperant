/**
 * zeenha fork: qa_reviewer.md diffs against {{BASE_BRANCH}}; injectContext must
 * substitute it (it used to reach the agent literally).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { injectContext } from '../prompt-loader';

const template = 'git diff {{BASE_BRANCH}}...HEAD\nReady for merge to {{BASE_BRANCH}}.';

describe('{{BASE_BRANCH}} substitution', () => {
  it('replaces every occurrence with the task base branch', () => {
    const out = injectContext(template, { specDir: '', projectDir: '/p', baseBranch: 'zeenha' });
    expect(out).toBe('git diff zeenha...HEAD\nReady for merge to zeenha.');
  });

  it('falls back to main when no base branch is known', () => {
    const out = injectContext(template, { specDir: '', projectDir: '/p' });
    expect(out).toBe('git diff main...HEAD\nReady for merge to main.');
  });

  it('leaves no placeholder in the real QA reviewer prompt', () => {
    const prompt = readFileSync(join(__dirname, '../../../../../prompts/qa_reviewer.md'), 'utf-8');
    expect(prompt).toContain('{{BASE_BRANCH}}');
    const out = injectContext(prompt, { specDir: '', projectDir: '/p', baseBranch: 'develop' });
    expect(out).not.toContain('{{BASE_BRANCH}}');
    expect(out).toContain('git diff develop...HEAD');
  });
});
