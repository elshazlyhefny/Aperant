/**
 * zeenha fork: a coder session is told its subtask and what already changed.
 * Uses a real git repository, because the failure that matters is git
 * answering for the wrong folder.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildSubtaskBrief, changedFilesOnBranch } from '../subtask-brief';

let repo: string;
let specDir: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
const subtask = { id: 'st-2', description: 'orchestrator text', status: 'pending', filesToModify: ['fallback.ts'] };

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'brief-')));
  specDir = join(repo, '.auto-claude', 'specs', '001');
  mkdirSync(specDir, { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, '.gitignore'), '.auto-claude\n');
  writeFileSync(join(repo, 'base.txt'), 'x');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'auto-claude/001');
  writeFileSync(join(specDir, 'implementation_plan.json'), JSON.stringify({
    phases: [{
      name: 'Backend',
      subtasks: [
        { id: 'st-1', title: 'First', status: 'completed' },
        {
          id: 'st-2', title: 'Second part', description: 'plan text', status: 'pending',
          files_to_modify: ['app/A.php'], files_to_create: ['app/B.php'], patterns_from: ['app/C.php'],
          verification: { type: 'command', command: 'phpunit' },
        },
      ],
    }],
  }));
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('buildSubtaskBrief', () => {
  it('names the subtask from the plan, with files, patterns, verification and progress', async () => {
    const brief = await buildSubtaskBrief({ specDir, projectDir: repo, subtask, attemptCount: 1 });
    expect(brief).toContain('## YOUR SUBTASK');
    expect(brief).toContain('`st-2`');
    expect(brief).toContain('Second part');
    expect(brief).toContain('plan text');
    expect(brief).toContain('`app/A.php`');
    expect(brief).toContain('`app/B.php`');
    expect(brief).toContain('`app/C.php`');
    expect(brief).toContain('phpunit');
    expect(brief).toContain('1 of 2 subtasks completed');
    expect(brief).toContain('**Phase**: Backend');
    expect(brief).not.toContain('**Attempt');
  });

  it('flags a retry', async () => {
    const brief = await buildSubtaskBrief({ specDir, projectDir: repo, subtask, attemptCount: 2 });
    expect(brief).toContain('**Attempt 2**');
  });

  it('falls back to the orchestrator when the plan is unreadable', async () => {
    writeFileSync(join(specDir, 'implementation_plan.json'), '{broken');
    const brief = await buildSubtaskBrief({ specDir, projectDir: repo, subtask, attemptCount: 1 });
    expect(brief).toContain('orchestrator text');
    expect(brief).toContain('`fallback.ts`');
  });
});

describe('changedFilesOnBranch', () => {
  it('lists committed and uncommitted changes since the base, not the base itself', async () => {
    writeFileSync(join(repo, 'committed.txt'), '1');
    git('add', '-A');
    git('commit', '-qm', 'work');
    writeFileSync(join(repo, 'untracked.txt'), '2');
    expect(await changedFilesOnBranch(repo, specDir)).toEqual(['committed.txt', 'untracked.txt']);
  });

  it('refuses to answer for a folder that is not its own top level', async () => {
    const inner = join(repo, 'leftover');
    mkdirSync(inner);
    expect(await changedFilesOnBranch(inner, specDir)).toBeNull();
  });

  it('gives no list when no base can be found, rather than a wrong one', async () => {
    git('branch', '-m', 'main', 'renamed');
    expect(await changedFilesOnBranch(repo, specDir)).toBeNull();
  });
});
