/**
 * zeenha fork: headless command line entry (`node out/main/cli.js run <spec>`).
 * Runs one task through the planner -> coder -> QA pipeline without Electron.
 * No Sentry, no app-logger and no electron import may appear below this file.
 */
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runHeadlessTask } from './run-task';

const FALLBACK_VERSION = 'unknown';

export const USAGE = `Usage: cli.js <command> [options]

Commands:
  run <spec>      Run the spec's build (plan, code, QA) and open a pull request
  help            Show this help

Options for run:
  --project <dir>       Project directory (default: current directory)
  --config <file>       JSON config file
  --base-branch <name>  Branch the task worktree is created from
  --no-push             Do not push the task branch
  --json                Print machine-readable events
  --verbose             Print detailed progress
  --help                Show this help
  --version             Print the version
`;

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface CliDeps extends Partial<CliIo> {
  workerPath?: string;
  readVersion?: () => string;
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
  const [command, spec, ...extra] = positionals;
  if (values.help || command === 'help') {
    out(USAGE);
    return 0;
  }
  if (command !== 'run') {
    err(`${command ? `Unknown command: ${command}` : 'Missing command'}\n\n${USAGE}`);
    return 1;
  }
  if (!spec || extra.length > 0) {
    err(`${spec ? 'Too many arguments' : 'Missing <spec> argument'}\n\n${USAGE}`);
    return 1;
  }

  return runHeadlessTask({
    projectPath: path.resolve(values.project ?? process.cwd()),
    spec,
    configPath: values.config,
    baseBranch: values['base-branch'],
    noPush: values['no-push'],
    json: values.json,
    verbose: values.verbose,
    workerPath: deps.workerPath ?? defaultWorkerPath(),
    out,
    err,
  });
}

const OPTIONS = {
  project: { type: 'string' },
  config: { type: 'string' },
  'base-branch': { type: 'string' },
  'no-push': { type: 'boolean' },
  json: { type: 'boolean' },
  verbose: { type: 'boolean' },
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
