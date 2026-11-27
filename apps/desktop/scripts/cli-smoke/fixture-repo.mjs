/**
 * zeenha fork: Use disposable Git state to verify the built CLI's Node runtime
 * floor without developer credentials, Git configuration, or a remote.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function worktreeSpecDir(repo, specId) {
  return join(repo, '.auto-claude', 'worktrees', 'tasks', specId, '.auto-claude', 'specs', specId);
}

export function createFixtureRepo({ specId }) {
  if (typeof specId !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(specId)) {
    throw new Error('Fixture specId must be a single alphanumeric, hyphen or underscore path component');
  }

  const dir = mkdtempSync(join(tmpdir(), 'aperant-cli-smoke-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });

  try {
    const repo = realpathSync(dir);
    const env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(repo, 'unused-gitconfig'),
    };
    const git = (...args) => execFileSync('git', args, { cwd: repo, env, stdio: 'pipe' });
    git('init', '-q', '-b', 'main', '--template=');
    writeFileSync(join(repo, 'README.md'), '# CLI runtime smoke fixture\n');
    writeFileSync(join(repo, '.gitignore'), '.auto-claude/\n');
    git('add', 'README.md', '.gitignore');
    git('-c', 'user.name=CLI Smoke', '-c', 'user.email=cli-smoke@example.invalid', 'commit', '-q', '-m', 'Initial fixture');

    const title = 'CLI runtime smoke';
    const specDir = join(repo, '.auto-claude', 'specs', specId);
    mkdirSync(specDir, { recursive: true });
    // Keep Context7 from starting an external npx-managed MCP server.
    writeFileSync(join(repo, '.auto-claude', '.env'), 'CONTEXT7_ENABLED=false\n');
    writeFileSync(join(specDir, 'spec.md'), `# ${title}\n`);
    // A completed plan short-circuits the worker, and a preapproved plan skips QA.
    const plan = {
      feature: title,
      workflow_type: 'feature',
      phases: [
        {
          id: 'phase-1',
          name: 'Smoke fixture',
          subtasks: [
            {
              id: 'subtask-1-1',
              title: 'Complete the fixture subtask',
              description: 'Mark this fixture subtask completed in the implementation plan.',
              status: 'pending',
            },
          ],
        },
      ],
    };
    writeFileSync(join(specDir, 'implementation_plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    return { repo, specDir, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
