/**
 * zeenha fork: Verify the Node runtime floor of the built headless CLI without
 * live credentials. Run from apps/desktop: node scripts/cli-runtime-smoke.mjs [path/to/cli.js]
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createFixtureRepo, worktreeSpecDir } from './cli-smoke/fixture-repo.mjs';
import { startMockAnthropic } from './cli-smoke/mock-anthropic.mjs';

const exec = promisify(execFile);
const desktopDir = fileURLToPath(new URL('../', import.meta.url));
const specId = '001-cli-runtime-smoke';
const commandTimeout = 15_000;
const workerTimeout = 60_000;

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function replyFromPlan(body, planPath, qaReportPath) {
  const lastMessage = body.messages?.at(-1);
  // Choose coding vs. QA from the actual worktree, not the agent's prompt text.
  const plan = readJson(planPath);
  if (Array.isArray(lastMessage?.content) && lastMessage.content.some((block) => block.type === 'tool_result')) {
    if (plan.qa_signoff?.status === 'approved' && !existsSync(qaReportPath)) {
      // BuildOrchestrator requires a verdict in the review report, not just the plan.
      return {
        toolUse: { name: 'Write', input: { file_path: qaReportPath, content: '# CLI smoke QA\n\nStatus: PASSED\n' } },
      };
    }
    return { text: 'Fixture files updated.' };
  }

  const subtasks = plan.phases.flatMap((phase) => phase.subtasks);
  const unfinished = subtasks.find((subtask) => subtask.status !== 'completed');
  if (unfinished) {
    // The orchestrator may already have marked the pending subtask in_progress.
    unfinished.status = 'completed';
  } else {
    plan.qa_signoff = { status: 'approved', timestamp: new Date().toISOString(), issues_found: [] };
  }

  return {
    toolUse: {
      name: 'Write',
      input: { file_path: planPath, content: `${JSON.stringify(plan, null, 2)}\n` },
    },
  };
}

async function check(name, run) {
  try {
    await run();
    process.stdout.write(`ok ${name}\n`);
  } catch (error) {
    throw new Error(`${name}: ${error.message}`, { cause: error });
  }
}

async function smoke() {
  const cliPath = process.argv[2] ? resolve(process.argv[2]) : join(desktopDir, 'out', 'main', 'cli.js');
  const { repo, cleanup } = createFixtureRepo({ specId });
  const specDir = worktreeSpecDir(repo, specId);
  const planPath = join(specDir, 'implementation_plan.json');
  const qaReportPath = join(specDir, 'qa_report.md');
  const home = join(repo, '.auto-claude', 'smoke-home');
  const configHome = join(home, '.config');
  // Never inherit provider credentials, webhooks, Node options or Git overrides.
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_AUTHOR_NAME: 'CLI Smoke',
    GIT_AUTHOR_EMAIL: 'cli-smoke@example.invalid',
    GIT_COMMITTER_NAME: 'CLI Smoke',
    GIT_COMMITTER_EMAIL: 'cli-smoke@example.invalid',
    ANTHROPIC_API_KEY: 'cli-smoke-placeholder',
    APERANT_CLAUDE_ENGINE: 'api',
  };
  const runChild = async (file, args, timeout = commandTimeout) => {
    try {
      return await exec(file, args, { cwd: repo, env, timeout, killSignal: 'SIGKILL' });
    } catch (error) {
      const reason = error.killed && error.signal === 'SIGKILL' ? `timed out after ${timeout}ms` : error.message;
      const output = [error.stdout, error.stderr].filter(Boolean).map((text) => text.trim().slice(-4000));
      throw new Error(`${args.join(' ')}: ${[reason, ...output].join('\n')}`, { cause: error });
    }
  };
  // Use the same binary for the CLI and its worker thread as for this script.
  const runCli = (args, timeout) => runChild(process.execPath, [cliPath, ...args], timeout);

  let mock;
  try {
    mkdirSync(configHome, { recursive: true });
    await check('startup', async () => {
      const { version } = readJson(join(desktopDir, 'package.json'));
      const { stdout: actualVersion } = await runCli(['--version']);
      assert.equal(actualVersion.trim(), version, 'CLI version must match apps/desktop/package.json');
      const { stdout: help } = await runCli(['--help']);
      assert.match(help, /Usage: cli\.js/, 'CLI help is missing its usage line');
    });

    await check('list', async () => {
      const { stdout } = await runCli(['list', '--json', '--project', repo]);
      const tasks = JSON.parse(stdout);
      assert.ok(Array.isArray(tasks), 'list --json must print an array');
      const task = tasks.find((entry) => entry?.specId === specId);
      assert.ok(task && typeof task.status === 'string' && typeof task.title === 'string', 'fixture task needs a status and title');
    });

    await check('worker run', async () => {
      mock = await startMockAnthropic({ script: (body) => replyFromPlan(body, planPath, qaReportPath) });
      env.ANTHROPIC_BASE_URL = mock.baseUrl;
      const { stdout } = await runCli(['run', specId, '--project', repo, '--no-push', '--base-branch', 'main', '--json'], workerTimeout);
      const result = JSON.parse(stdout.trimEnd().split('\n').at(-1));
      assert.equal(result?.type, 'result', 'run --json must end with a result event');
      assert.equal(result.exitCode, 0, 'result event must report success');
      const unexpected = mock.requests.find((request) => request.status !== 200);
      assert.ok(!unexpected, unexpected && `mock rejected ${unexpected.method} ${unexpected.path} (HTTP ${unexpected.status})`);
      assert.ok(
        mock.requests.some(({ body }) => Array.isArray(body?.tools) && body.tools.length > 0),
        'no worker request with tools reached the mock',
      );
      const plan = readJson(planPath);
      assert.equal(plan.phases[0].subtasks[0].status, 'completed', 'worker did not update the subtask');
      assert.equal(plan.qa_signoff?.status, 'approved', 'worker did not write QA approval');
      assert.match(readFileSync(qaReportPath, 'utf8'), /^Status: PASSED$/m, 'worker did not write a passing QA report');
    });
  } finally {
    try {
      await mock?.close();
      // Remove the disposable linked worktree before pruning its Git metadata.
      rmSync(join(repo, '.auto-claude', 'worktrees', 'tasks', specId), { recursive: true, force: true });
      await runChild('git', ['worktree', 'prune', '--expire', 'now']);
    } finally {
      cleanup();
    }
  }
}

process.stdout.write(`node ${process.version}\n`);
try {
  await smoke();
  process.stdout.write(`CLI runtime smoke passed on node ${process.version}\n`);
} catch (error) {
  process.stderr.write(`FAIL ${error.message}\n`);
  process.exitCode = 1;
}
