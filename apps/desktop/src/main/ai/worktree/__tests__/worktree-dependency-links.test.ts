import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readProjectRepoConfig } from '../project-repo-config';
import { linkWorktreeDependencies } from '../worktree-dependency-links';
import { createOrGetWorktree } from '../worktree-manager';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

describe('project repo config and dependency links', () => {
  let project: string;

  const declare = (config: unknown) =>
    writeFileSync(join(project, '.aperant.json'), JSON.stringify(config));

  beforeEach(() => {
    // realpath: macOS and Windows temp paths are aliases git reports differently.
    project = realpathSync.native(mkdtempSync(join(tmpdir(), 'worktree-links-')));
    git(project, 'init', '-q', '-b', 'main');
    git(project, 'config', 'user.email', 'test@example.com');
    git(project, 'config', 'user.name', 'Test');
    writeFileSync(join(project, '.gitignore'), 'node_modules\napps/desktop/node_modules\n.auto-claude/\n');
    writeFileSync(join(project, 'file.txt'), 'x');
    git(project, 'add', '.');
    git(project, 'commit', '-q', '-m', 'init');
    mkdirSync(join(project, 'node_modules/pkg'), { recursive: true });
    mkdirSync(join(project, 'apps/desktop/node_modules'), { recursive: true });
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  describe('readProjectRepoConfig', () => {
    it('returns nothing for a project without the file', () => {
      expect(readProjectRepoConfig(project)).toEqual({ linkDependencies: [] });
    });

    it('survives malformed JSON', () => {
      writeFileSync(join(project, '.aperant.json'), '{ nope');
      expect(readProjectRepoConfig(project)).toEqual({ linkDependencies: [] });
    });

    it('drops paths that leave the project and unsafe branch names', () => {
      declare({
        baseBranch: '--upload-pack=evil',
        linkDependencies: ['node_modules', '../outside', '/etc', 'a/../../b', '', 7],
      });

      expect(readProjectRepoConfig(project)).toEqual({
        baseBranch: undefined,
        linkDependencies: ['node_modules'],
      });
    });

    it('reads a declared base branch', () => {
      declare({ baseBranch: 'zeenha' });
      expect(readProjectRepoConfig(project).baseBranch).toBe('zeenha');
    });
  });

  describe('createOrGetWorktree', () => {
    const spec = '001-task';
    const create = () => createOrGetWorktree(project, spec, 'main', true, false);

    it('leaves a project that declares nothing without links', async () => {
      const { worktreePath } = await create();
      expect(existsSync(join(worktreePath, 'node_modules'))).toBe(false);
    });

    it('links declared dependencies to the main checkout', async () => {
      declare({ linkDependencies: ['node_modules', 'apps/desktop/node_modules'] });
      const { worktreePath } = await create();

      for (const rel of ['node_modules', 'apps/desktop/node_modules']) {
        const link = join(worktreePath, rel);
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(realpathSync.native(link)).toBe(join(project, rel));
      }
    });

    it('keeps the links out of git status', async () => {
      declare({ linkDependencies: ['node_modules', 'apps/desktop/node_modules'] });
      const { worktreePath } = await create();

      expect(git(worktreePath, 'status', '--porcelain')).toBe('');
    });

    it('adds links to a worktree that existed before they were declared', async () => {
      const { worktreePath } = await create();
      declare({ linkDependencies: ['node_modules'] });

      await create();
      expect(lstatSync(join(worktreePath, 'node_modules')).isSymbolicLink()).toBe(true);
    });
  });

  describe('linkWorktreeDependencies', () => {
    let worktree: string;

    beforeEach(async () => {
      ({ worktreePath: worktree } = await createOrGetWorktree(project, '002-task', 'main', true, false));
    });

    it('keeps a link out of git when .gitignore only matches directories', async () => {
      mkdirSync(join(project, 'vendor'));
      writeFileSync(join(project, '.gitignore'), 'vendor/\nnode_modules\napps/desktop/node_modules\n.auto-claude/\n');
      git(project, 'add', '.gitignore');
      git(project, 'commit', '-q', '-m', 'ignore vendor as a directory');
      git(worktree, 'pull', '-q', '--no-rebase', project, 'main');
      declare({ linkDependencies: ['vendor'] });

      expect(await linkWorktreeDependencies(project, worktree)).toEqual(['vendor']);
      expect(git(worktree, 'status', '--porcelain')).toBe('');
    });

    it('repairs a dangling link', async () => {
      symlinkSync(join(project, 'gone'), join(worktree, 'node_modules'), 'junction');
      declare({ linkDependencies: ['node_modules'] });

      expect(await linkWorktreeDependencies(project, worktree)).toEqual(['node_modules']);
      expect(realpathSync.native(join(worktree, 'node_modules'))).toBe(join(project, 'node_modules'));
    });

    it('does not replace a real install in the worktree', async () => {
      mkdirSync(join(worktree, 'node_modules'));
      declare({ linkDependencies: ['node_modules'] });

      expect(await linkWorktreeDependencies(project, worktree)).toEqual([]);
      expect(lstatSync(join(worktree, 'node_modules')).isDirectory()).toBe(true);
    });

    it('skips a dependency the main checkout does not have', async () => {
      rmSync(join(project, 'node_modules'), { recursive: true });
      declare({ linkDependencies: ['node_modules'] });

      expect(await linkWorktreeDependencies(project, worktree)).toEqual([]);
    });
  });
});
