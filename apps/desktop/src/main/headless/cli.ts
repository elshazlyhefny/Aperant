/**
 * zeenha fork: headless command line entry (`node out/main/cli.js run <spec>`).
 * Runs one task through the planner -> coder -> QA pipeline without Electron.
 * `serve` is long-running: it runs the project's task queue and recurring schedules until stopped.
 * `stop <spec>` asks a running serve daemon to stop one task (it writes a stop request file).
 * `check [<spec>]` checks readiness without starting an agent.
 * No Sentry, no app-logger and no electron import may appear below this file.
 */
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readDeliveryReceipts } from '../delivery-receipts';
import { isValidTaskId } from '../utils/spec-path-helpers';
import { createHeadlessSpec } from './new-spec';
import { renderPreflightJson, renderPreflightText, runPreflight } from './preflight';
import { createProgressReporter } from './progress';
import { runHeadlessTask } from './run-task';
import { runServe } from './serve';
import { HeadlessSetupError, resolveDeliveryReceiptRoot, resolveHeadlessProject } from './shared';
import { findLiveDaemon, writeStopRequest } from './stop-request';
import { listHeadlessTasks, queueHeadlessTask, resolveSpecId } from './task-store';

const FALLBACK_VERSION = 'unknown';

export const USAGE = `Usage: cli.js <command> [options]

Commands:
  run <spec>      Run the spec's build (plan, code, QA) and open a pull request
  new "<description>"  Create a spec from a description (add --run to build it too)
  check [<spec>]   Check that the project (and spec) are ready to run, without starting an agent
  serve           Run the project's task queue and recurring schedules until stopped
  list            List the project's tasks (id, status, title)
  queue <spec>    Move a backlog task to the queue for a running serve daemon
  receipts <spec> Read the task's local delivery history (supports --project and --json)
  stop <spec>     Ask a running serve daemon to stop one task
  help            Show this help

Options for run (they also apply to new --run):
  --project <dir>       Project directory (default: current directory)
  --config <file>       JSON config file
  --base-branch <name>  Branch the task worktree is created from
  --no-push             Do not push the task branch
  --json                Print machine-readable events (also for list, queue, stop and receipts)
  --verbose             Print detailed progress
  --run                 With new: run the build after the spec is created
  --queue               With new: queue the spec for a running serve daemon
  --requeue             With stop: put the task back in the queue instead of leaving it stopped
  --help                Show this help
  --version             Print the version

Options for check:
  --project <dir>       Project directory (default: current directory)
  --config <file>       JSON config file
  --base-branch <name>  Branch the task worktree is created from
  --daemon              Also check what serve needs: the queue lock and the strict webhook rule
  --json                Print a machine-readable readiness report

Options for serve:
  --project <dir>            Project directory (default: current directory)
  --config <file>            JSON config file
  --schedules <file>         JSON schedules file
  --project-id <id>          Project id used for the queue and schedules
  --base-branch <name>       Branch the task worktrees are created from
  --no-push                  Do not push task branches
  --shutdown-timeout <sec>   Seconds to wait for running tasks on SIGTERM/SIGINT
  --json                     Print machine-readable events
  --verbose                  Print detailed progress

Exit codes for check:
  0  ready (warnings and unverified items allowed)
  1  at least one blocking problem or bad arguments

Exit codes for serve:
  0  stopped cleanly
  1  error
  3  the project queue is held by another process

Exit codes for list, queue, stop and receipts:
  0  ok
  1  error, such as an unknown spec, a task that is not in the backlog (queue),
     a task that is not running or no running serve daemon (stop)
`;

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface CliDeps extends Partial<CliIo> {
  workerPath?: string;
  readVersion?: () => string;
  runServe?: typeof runServe;
  runPreflight?: typeof runPreflight;
}

function readPackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const rel of ['../../package.json', '../package.json', './package.json']) {
      try {
        const pkg = JSON.parse(readFileSync(path.resolve(here, rel), 'utf-8')) as { name?: string; version?: string };
        if (pkg.version) return pkg.version;
      } catch {
        // try the next candidate
      }
    }
  } catch {
    // fall through
  }
  return FALLBACK_VERSION;
}

function defaultWorkerPath(): string {
  // cli.js sits in out/main next to ai/agent/worker.js. Computed here, not in shared code,
  // because a shared chunk would change the directory it resolves against.
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'ai', 'agent', 'worker.js');
}

/** Parse argv (without node and script) and run. Returns the process exit code. */
export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? ((text: string) => void process.stdout.write(text));
  const err = deps.err ?? ((text: string) => void process.stderr.write(text));

  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 1;
  }
  const { values, positionals } = parsed;

  if (values.version) {
    out(`${(deps.readVersion ?? readPackageVersion)()}\n`);
    return 0;
  }
  const [command, arg, ...extra] = positionals;
  if (values.help || command === 'help') {
    out(USAGE);
    return 0;
  }
  if (values.queue && command !== 'new') {
    err(`--queue only applies to the new command\n\n${USAGE}`);
    return 1;
  }
  if (values.requeue && command !== 'stop') {
    err(`--requeue only applies to the stop command\n\n${USAGE}`);
    return 1;
  }
  if (values.daemon && command !== 'check') {
    err(`--daemon only applies to the check command\n\n${USAGE}`);
    return 1;
  }
  if (command === 'list' || command === 'queue') {
    if (command === 'list' ? arg || extra.length > 0 : extra.length > 0) {
      err(`Too many arguments\n\n${USAGE}`);
      return 1;
    }
    if (command === 'queue' && !arg) {
      err(`Missing <spec> argument\n\n${USAGE}`);
      return 1;
    }
    if (values.run) {
      err(`--run only applies to the new command\n\n${USAGE}`);
      return 1;
    }
    let project: ReturnType<typeof resolveHeadlessProject>;
    try {
      project = resolveHeadlessProject(values.project);
    } catch (error) {
      if (error instanceof HeadlessSetupError) {
        err(`${error.message}\n`);
        return 1;
      }
      throw error;
    }
    if (command === 'list') {
      const tasks = listHeadlessTasks(project)
        .map((t) => ({ specId: t.specId, status: t.status, title: t.title }))
        .sort((a, b) => (a.specId < b.specId ? -1 : a.specId > b.specId ? 1 : 0));
      if (values.json) {
        out(`${JSON.stringify(tasks)}\n`);
      } else {
        const idWidth = Math.max(0, ...tasks.map((t) => t.specId.length));
        const statusWidth = Math.max(0, ...tasks.map((t) => t.status.length));
        for (const t of tasks) out(`${t.specId.padEnd(idWidth)}  ${t.status.padEnd(statusWidth)}  ${t.title}\n`);
      }
      return 0;
    }
    const queued = await queueHeadlessTask(project, arg as string);
    if (!queued.ok) {
      err(`${queued.error}\n`);
      return 1;
    }
    out(values.json ? `${JSON.stringify({ specId: queued.specId, status: 'queue' })}\n` : `Queued ${queued.specId}\n`);
    return 0;
  }
  if (command === 'receipts') {
    if (!arg || extra.length > 0 || values.run) {
      err(`${values.run ? '--run only applies to the new command' : arg ? 'Too many arguments' : 'Missing <spec> argument'}\n\n${USAGE}`);
      return 1;
    }
    let project: ReturnType<typeof resolveHeadlessProject>;
    try {
      project = resolveHeadlessProject(values.project);
    } catch (error) {
      if (error instanceof HeadlessSetupError) {
        err(`${error.message}\n`);
        return 1;
      }
      throw error;
    }
    const receiptRoot = resolveDeliveryReceiptRoot(project.path);
    if (!receiptRoot) {
      err('Could not read delivery history\n');
      return 1;
    }
    if (!isValidTaskId(arg)) {
      err('Invalid spec ID for delivery history\n');
      return 1;
    }
    try {
      // An exact ID can have durable history even after its only spec copy was removed.
      // Try it verbatim, as `run` hashes the exact ID and the store can't resolve prefixes.
      let specId = arg;
      let receipts = await readDeliveryReceipts(receiptRoot, specId);
      if (receipts.length === 0) {
        const tasks = listHeadlessTasks({ ...project, path: receiptRoot });
        if (project.path !== receiptRoot) {
          for (const task of listHeadlessTasks(project)) {
            if (!tasks.some((known) => known.specId === task.specId)) tasks.push(task);
          }
        }
        if (!tasks.some((task) => task.specId === arg)) {
          const resolved = resolveSpecId(tasks.filter((task) => isValidTaskId(task.specId)), arg);
          if ('error' in resolved) {
            err(`${resolved.error}\n`);
            return 1;
          }
          specId = resolved.specId;
          receipts = await readDeliveryReceipts(receiptRoot, specId);
        }
      }
      createProgressReporter({ json: values.json, out }).deliveryReceipts(specId, receipts);
      return 0;
    } catch {
      err('Could not read delivery history\n');
      return 1;
    }
  }
  if (command === 'stop') {
    if (!arg || extra.length > 0) {
      err(`${arg ? 'Too many arguments' : 'Missing <spec> argument'}\n\n${USAGE}`);
      return 1;
    }
    if (values.run) {
      err(`--run only applies to the new command\n\n${USAGE}`);
      return 1;
    }
    let project: ReturnType<typeof resolveHeadlessProject>;
    try {
      project = resolveHeadlessProject(values.project);
    } catch (error) {
      if (error instanceof HeadlessSetupError) {
        err(`${error.message}\n`);
        return 1;
      }
      throw error;
    }
    const daemon = findLiveDaemon(project.path);
    if (!daemon.ok) {
      err(`${daemon.message}\n`);
      return 1;
    }
    const tasks = listHeadlessTasks(project);
    const resolved = resolveSpecId(tasks, arg);
    if ('error' in resolved) {
      err(`${resolved.error}\n`);
      return 1;
    }
    const task = tasks.find((t) => t.specId === resolved.specId);
    if (!task || task.status !== 'in_progress') {
      err(`Task ${resolved.specId} is ${task?.status ?? 'unknown'}, only running tasks can be stopped\n`);
      return 1;
    }
    const requeue = !!values.requeue;
    try {
      writeStopRequest(project.path, { specId: resolved.specId, requeue });
    } catch (error) {
      err(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    out(
      values.json
        ? `${JSON.stringify({ specId: resolved.specId, requeue, requested: true })}\n`
        : `Requested stop of ${resolved.specId}${requeue ? ', it will be requeued' : ''}\n`,
    );
    return 0;
  }
  if (command === 'serve') {
    if (arg || extra.length > 0) {
      err(`Too many arguments\n\n${USAGE}`);
      return 1;
    }
    if (values.run) {
      err(`--run only applies to the new command\n\n${USAGE}`);
      return 1;
    }
    let shutdownTimeoutMs: number | undefined;
    if (values['shutdown-timeout'] !== undefined) {
      const seconds = Number(values['shutdown-timeout']);
      if (!Number.isFinite(seconds) || seconds < 0) {
        err(`Invalid --shutdown-timeout: ${values['shutdown-timeout']}\n\n${USAGE}`);
        return 1;
      }
      shutdownTimeoutMs = seconds * 1000;
    }
    return (deps.runServe ?? runServe)({
      projectPath: path.resolve(values.project ?? process.cwd()),
      projectId: values['project-id'],
      configPath: values.config,
      schedulesPath: values.schedules,
      baseBranch: values['base-branch'],
      noPush: values['no-push'],
      shutdownTimeoutMs,
      json: values.json,
      verbose: values.verbose,
      workerPath: deps.workerPath ?? defaultWorkerPath(),
      out,
      err,
    });
  }
  if (command === 'check') {
    if (extra.length > 0) {
      err(`Too many arguments\n\n${USAGE}`);
      return 1;
    }
    if (values.run) {
      err(`--run only applies to the new command\n\n${USAGE}`);
      return 1;
    }
    try {
      const report = await (deps.runPreflight ?? runPreflight)({
        projectPath: values.project,
        spec: arg,
        configPath: values.config,
        baseBranch: values['base-branch'],
        daemon: values.daemon,
      });
      out(values.json ? renderPreflightJson(report) : renderPreflightText(report));
      return report.ok ? 0 : 1;
    } catch (error) {
      err(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  if (command !== 'run' && command !== 'new') {
    err(`${command ? `Unknown command: ${command}` : 'Missing command'}\n\n${USAGE}`);
    return 1;
  }
  if (!arg || extra.length > 0) {
    const missing = command === 'new' ? 'Missing <description> argument' : 'Missing <spec> argument';
    err(`${arg ? 'Too many arguments' : missing}\n\n${USAGE}`);
    return 1;
  }
  if (command === 'run' && values.run) {
    err(`--run only applies to the new command\n\n${USAGE}`);
    return 1;
  }

  if (command === 'new' && values.queue && values.run) {
    err(`--queue cannot be combined with --run\n\n${USAGE}`);
    return 1;
  }

  const projectPath = path.resolve(values.project ?? process.cwd());
  const workerPath = deps.workerPath ?? defaultWorkerPath();
  let spec = arg;

  if (command === 'new') {
    const created = await createHeadlessSpec({
      projectPath,
      description: arg,
      configPath: values.config,
      json: values.json,
      verbose: values.verbose,
      workerPath,
      summary: !values.run,
      out,
      err,
    });
    if (created.exitCode !== 0) return created.exitCode;
    if (values.queue && created.specId) {
      try {
        const queued = await queueHeadlessTask(resolveHeadlessProject(projectPath), created.specId, {
          requireBacklog: false,
        });
        if (!queued.ok) {
          err(`${queued.error}\n`);
          return 1;
        }
      } catch (error) {
        err(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
      return 0;
    }
    if (!values.run || !created.specId) return 0;
    spec = created.specId;
  }

  return runHeadlessTask({
    projectPath,
    spec,
    configPath: values.config,
    baseBranch: values['base-branch'],
    noPush: values['no-push'],
    json: values.json,
    verbose: values.verbose,
    workerPath,
    out,
    err,
  });
}

const OPTIONS = {
  project: { type: 'string' },
  config: { type: 'string' },
  schedules: { type: 'string' },
  'project-id': { type: 'string' },
  'shutdown-timeout': { type: 'string' },
  'base-branch': { type: 'string' },
  'no-push': { type: 'boolean' },
  json: { type: 'boolean' },
  verbose: { type: 'boolean' },
  run: { type: 'boolean' },
  queue: { type: 'boolean' },
  requeue: { type: 'boolean' },
  daemon: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

function flushThenExit(code: number): void {
  process.stdout.write('', () => process.exit(code));
}

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
  flushThenExit(1);
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.on('unhandledRejection', fail);
  runCli(process.argv.slice(2)).then(flushThenExit, fail);
}
