/**
 * zeenha fork: headless command line entry (`node out/main/cli.js run <spec>`).
 * Runs one task through the planner -> coder -> QA pipeline without Electron.
 * `serve` is long-running: it runs the project's task queue and recurring schedules until stopped.
 * No Sentry, no app-logger and no electron import may appear below this file.
 */
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHeadlessSpec } from './new-spec';
import { runHeadlessTask } from './run-task';
import { runServe } from './serve';

const FALLBACK_VERSION = 'unknown';

export const USAGE = `Usage: cli.js <command> [options]

Commands:
  run <spec>      Run the spec's build (plan, code, QA) and open a pull request
  new "<description>"  Create a spec from a description (add --run to build it too)
  serve           Run the project's task queue and recurring schedules until stopped
  help            Show this help

Options for run (they also apply to new --run):
  --project <dir>       Project directory (default: current directory)
  --config <file>       JSON config file
  --base-branch <name>  Branch the task worktree is created from
  --no-push             Do not push the task branch
  --json                Print machine-readable events
  --verbose             Print detailed progress
  --run                 With new: run the build after the spec is created
  --help                Show this help
  --version             Print the version

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

Exit codes for serve:
  0  stopped cleanly
  1  error
  3  the project queue is held by another process
`;

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface CliDeps extends Partial<CliIo> {
  workerPath?: string;
  readVersion?: () => string;
  runServe?: typeof runServe;
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
