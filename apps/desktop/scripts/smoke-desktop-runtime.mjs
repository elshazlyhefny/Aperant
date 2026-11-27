// zeenha fork: prove that a staged distribution starts without using a developer's profile.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { arch, homedir, platform, userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { parentPort, Worker, workerData } from 'node:worker_threads';

const STARTUP_MS = 60_000;
const SHUTDOWN_MS = 5_000;
const CHECK_MS = 20_000;
const WORKER_ROLE = 'aperant-packaged-smoke';
const WORKER_MS = 2 * STARTUP_MS + 2 * CHECK_MS + 5 * SHUTDOWN_MS;
const MARKER_FILE = 'smoke-marker.txt';
const INITIAL_BRANCH = 'main';
const TARGET_BRANCH = 'smoke-target';
const runFile = promisify(execFile);

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function overlaps(left, right) {
  return relative(left, right) === '' || inside(left, right) || inside(right, left);
}

function requireCheck(condition, message) {
  if (!condition) throw new SmokeCheckError(message);
}

class SmokeCheckError extends Error {}

function canonicalEntry(path, root, kind) {
  requireCheck(isAbsolute(path) && resolve(path) === path, `Use a normalized absolute ${kind} path`);
  requireCheck(!root || inside(root, path), `${kind} must be inside its disposable root`);
  const resolved = realpathSync(path);
  requireCheck(relative(resolved, path) === '' && !lstatSync(path).isSymbolicLink(), `${kind} path must not follow a link`);
  const entry = lstatSync(resolved);
  requireCheck(kind === 'file' ? entry.isFile() && entry.size > 0 : entry.isDirectory(), `Expected a nonempty file or directory (${kind})`);
  return resolved;
}

function requireAbsent(path, message) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new SmokeCheckError(message);
}

/** Only these inherited values may reach Electron. Pass tool paths from a clean runner. */
export function smokeRuntimeEnvironment(inherited, paths, target = platform()) {
  const windows = target === 'win32';
  const allow = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM'];
  if (windows) allow.push('SystemRoot', 'WINDIR', 'SystemDrive', 'PATHEXT', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432');
  if (target === 'linux') allow.push('DISPLAY', 'XAUTHORITY');
  const env = Object.fromEntries(allow.flatMap((name) => {
    const key = windows ? Object.keys(inherited).find((key) => key.toUpperCase() === name.toUpperCase()) : name;
    const value = key === undefined ? undefined : inherited[key];
    return typeof value === 'string' && value.length ? [[name, value]] : [];
  }));
  Object.assign(env, {
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.config,
    XDG_DATA_HOME: paths.data,
    XDG_CACHE_HOME: paths.cache,
    XDG_STATE_HOME: paths.state,
    XDG_RUNTIME_DIR: paths.runtime,
    TMPDIR: paths.temp,
    TEMP: paths.temp,
    TMP: paths.temp,
    GIT_CONFIG_GLOBAL: paths.gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    // Do not autolaunch a session bus using the display or the account's sockets.
    ...(target === 'linux' ? { DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(paths.runtime, 'no-session-bus')}` } : {}),
  });
  if (windows) {
    requireCheck(env.SystemRoot && win32.isAbsolute(env.SystemRoot), 'Windows probe requires SystemRoot');
    Object.assign(env, {
      USERPROFILE: paths.home,
      HOMEDRIVE: win32.parse(paths.home).root.slice(0, 2),
      HOMEPATH: paths.home.slice(2),
      APPDATA: paths.appData,
      LOCALAPPDATA: paths.localAppData,
      ComSpec: win32.join(env.SystemRoot, 'System32', 'cmd.exe'),
    });
  } else {
    Object.assign(env, { SHELL: '/bin/sh', ZDOTDIR: paths.home });
    if (target === 'darwin') env.CFFIXED_USER_HOME = paths.home;
  }
  return env;
}

function prepareLaunchPaths(root, target) {
  const launch = mkdtempSync(join(root, 'runtime-'));
  const paths = {};
  for (const key of ['cwd', 'home', 'config', 'data', 'cache', 'state', 'runtime', 'temp']) {
    paths[key] = join(launch, key);
    mkdirSync(paths[key], { mode: 0o700 });
  }
  if (target === 'win32') {
    mkdirSync(join(paths.home, 'AppData'), { mode: 0o700 });
    paths.appData = join(paths.home, 'AppData', 'Roaming');
    paths.localAppData = join(paths.home, 'AppData', 'Local');
    mkdirSync(paths.appData, { mode: 0o700 });
    mkdirSync(paths.localAppData, { mode: 0o700 });
  }
  paths.gitConfig = join(paths.home, '.gitconfig');
  writeFileSync(paths.gitConfig, '', { flag: 'wx', mode: 0o600 });
  return paths;
}

function disposableWorkRoot(options) {
  requireCheck(options.disposableRunner === true, 'Require a fresh, credential-free disposable account, VM or runner');
  requireCheck(!options.signal?.aborted, 'Interrupted');
  const root = canonicalEntry(options.workRoot, null, 'work root');
  const accountHome = realpathSync(userInfo().homedir);
  for (const protectedPath of [accountHome, homedir(), process.cwd(), ...(options.protectedRoots ?? [])]) {
    requireCheck(!overlaps(root, realpathSync(protectedPath)), 'Work root overlaps the account home or source tree');
  }
  return { root, accountHome };
}

function fixtureLineEnding() {
  return platform() === 'win32' ? '\r\n' : '\n';
}

async function fixtureGit(cwd, env, signal, ...args) {
  requireCheck(!signal?.aborted, 'Interrupted');
  try {
    const { stdout } = await runFile('git', args, { cwd, env, signal, timeout: 5_000, maxBuffer: 8192, windowsHide: true });
    return stdout;
  } catch {
    throw new SmokeCheckError('Fixture Git command failed or was interrupted');
  }
}

/** Create once in a caller-owned disposable root, before any packaged launches. */
export async function createSmokeFixture(options) {
  const { root } = disposableWorkRoot(options);
  const { signal } = options;
  const paths = prepareLaunchPaths(root, platform());
  const env = smokeRuntimeEnvironment(process.env, paths);
  const path = mkdtempSync(join(root, 'fixture-'));
  const git = (...args) => fixtureGit(path, env, signal, ...args);
  const line = `aperant-smoke-${randomUUID()}`;
  await git('init', '--template=', `--initial-branch=${INITIAL_BRANCH}`);
  writeFileSync(join(path, MARKER_FILE), line + fixtureLineEnding(), { flag: 'wx' });
  await git('-c', 'core.autocrlf=false', 'add', '--', MARKER_FILE);
  // Set identity just for this fixture commit, not in any Git user configuration.
  await git('-c', 'user.name=Aperant Smoke Fixture', '-c', 'user.email=smoke@aperant.invalid', 'commit', '-m', 'Add desktop smoke marker');
  await git('branch', TARGET_BRANCH);
  return { path, head: (await git('rev-parse', 'HEAD')).trim(), line };
}

async function verifyFixture(fixture, state, env, signal) {
  requireCheck(state?.path === fixture && /^aperant-smoke-[0-9a-f-]{36}$/.test(state.line), 'Expected the original committed fixture');
  canonicalEntry(join(fixture, '.git'), fixture, 'fixture Git directory');
  const marker = canonicalEntry(join(fixture, MARKER_FILE), fixture, 'file');
  const git = (...args) => fixtureGit(fixture, env, signal, ...args);
  const expected = state.line + fixtureLineEnding();
  const [head, target] = (await git('rev-parse', 'HEAD', `refs/heads/${TARGET_BRANCH}`)).trim().split(/\r?\n/);
  requireCheck(head === state.head && target === state.head, 'Fixture HEAD or target branch changed');
  requireCheck((await git('show', `HEAD:${MARKER_FILE}`)) === expected && readFileSync(marker, 'utf8') === expected, 'Committed or working fixture marker changed');
  requireCheck((await git('remote')).trim() === '', 'Fixture has an unexpected Git remote');
}

async function deadline(action, ms, signal) {
  requireCheck(!signal?.aborted, 'Interrupted');
  let timer;
  let interrupt;
  const limit = new Promise((_, reject) => {
    interrupt = () => reject(new SmokeCheckError('Interrupted'));
    signal?.addEventListener('abort', interrupt, { once: true });
    timer = setTimeout(() => reject(new SmokeCheckError('Stage deadline expired')), ms);
  });
  try {
    return await Promise.race([limit, Promise.resolve().then(action)]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', interrupt);
  }
}

async function confirmUnixGroupExited(pid) {
  if (platform() === 'win32') return;
  const end = performance.now() + SHUTDOWN_MS;
  do {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    // A sandbox helper can take a moment to exit and be reaped by init.
    await delay(50);
  } while (performance.now() < end);
  throw new SmokeCheckError('Owned process group exit could not be confirmed');
}

function trackChild(child, diagnostics) {
  let closed = false;
  const done = new Promise((done) => {
    // A successful launch normally returns a live child. Check it before adding listeners.
    if (child.exitCode !== null || child.signalCode !== null) {
      closed = true;
      done();
    } else {
      child.once('close', () => {
        closed = true;
        done();
      });
    }
  });
  for (const stream of ['stdout', 'stderr']) {
    // App logs and Playwright launch errors can contain paths, URLs and private data.
    // Keep counts only, including a cap, and never store raw output.
    child[stream]?.on('data', (chunk) => {
      diagnostics[stream] = Math.min(1_000_000, diagnostics[stream] + chunk.length);
    });
  }
  return { done, isClosed: () => closed };
}

async function closeRuntime(app, child, tracked, env) {
  try {
    if (!tracked.isClosed()) {
      await deadline(async () => {
        await app.close();
        await tracked.done;
      }, SHUTDOWN_MS);
    }
  } catch {
    if (!tracked.isClosed()) {
      if (platform() === 'win32') {
        // Playwright launches via cmd.exe on Windows; target that owned process tree.
        if (child.exitCode === null && child.signalCode === null) {
          await runFile(join(env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
            env, timeout: SHUTDOWN_MS, maxBuffer: 8192, windowsHide: true,
          }).catch(() => {});
        }
      } else if (child.exitCode === null && child.signalCode === null) {
        // Playwright launches Electron in a new process group on Unix. Never
        // signal a group after its leader has already been reaped.
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    }
    await deadline(() => tracked.done, SHUTDOWN_MS);
    await confirmUnixGroupExited(child.pid);
    return 'forced-close';
  }
  await confirmUnixGroupExited(child.pid);
  return child.exitCode === 0 ? 'closed' : 'unexpected-exit';
}

function runtimePathMatches(observed, expected) {
  return isAbsolute(observed) && relative(realpathSync(observed), expected) === '';
}

function launchFailureMessage(error, stage) {
  if (error instanceof SmokeCheckError) return error.message;
  if (stage === 'launch' && /Unable to open X display|Missing X server/.test(error?.message)) return 'Electron could not open the display';
  if (stage === 'launch' && /sandbox/i.test(error?.message)) return 'Electron could not start with its sandbox enabled';
  if (error?.name === 'TimeoutError') return 'Stage deadline expired';
  if (error?.code === 'ERR_MODULE_NOT_FOUND') return 'Prepare isolated Playwright and packaging dependencies first';
  return 'Stage failed';
}

/**
 * Run with a trusted staged artifact on a fresh, credential-free native runner/account.
 * disposableRunner is an explicit operator (or fresh CI job) attestation, not sandbox detection.
 * The caller owns workRoot and its lifecycle. Never swap/delete on a cleanup='unconfirmed' error;
 * retire the disposable runner instead. Run serially, and forward interrupts through signal.
 */
async function withPackagedRuntime(options, exercise, checkBeforeLaunch) {
  let stage = 'preflight';
  const diagnostics = { startup: 'pending', cleanup: 'not-launched', stdout: 0, stderr: 0 };
  let app;
  let child;
  let tracked;
  let env;
  let result;
  let failure;
  try {
    const { expected, signal } = options;
    const target = platform();
    const { root: workRoot, accountHome } = disposableWorkRoot(options);
    requireCheck(['linux', 'darwin', 'win32'].includes(target) && expected?.platform === target && expected.arch === arch(), 'Probe requires a matching native platform and architecture');
    requireCheck(typeof expected.version === 'string' && expected.version.length > 0, 'Expected embedded version is required');
    requireCheck(target !== 'linux' || process.geteuid() !== 0, 'Do not run the Linux probe as root');
    requireCheck(!signal?.aborted, 'Interrupted');

    const artifactRoot = canonicalEntry(options.artifactRoot, workRoot, 'artifact root');
    const executablePath = canonicalEntry(options.executablePath, artifactRoot, 'file');
    const fixture = canonicalEntry(options.fixture, workRoot, 'fixture');
    const userData = canonicalEntry(options.userData, workRoot, 'profile');
    requireCheck(!overlaps(artifactRoot, fixture) && !overlaps(artifactRoot, userData) && !overlaps(fixture, userData), 'Artifact, fixture and profile must be separate');
    // Playwright uses cmd.exe on Windows, where expansion can happen inside quoted arguments.
    requireCheck(target !== 'win32' || ![executablePath, userData].some((path) => /[%!"\r\n]/.test(path)), 'Windows launch paths must be safe in cmd.exe');
    accessSync(executablePath, constants.X_OK);
    const resources = canonicalEntry(
      target === 'darwin' ? join(dirname(dirname(executablePath)), 'Resources') : join(dirname(executablePath), 'resources'),
      artifactRoot,
      'resources directory',
    );
    const archive = canonicalEntry(join(resources, 'app.asar'), resources, 'file');
    requireAbsent(join(resources, '.env'), 'Packaged startup can discover a .env file');
    const { getRawHeader } = await import('@electron/asar');
    // Read the current header directly; the installer may replace the archive at
    // this same path between launches. Do not use ASAR's cached stat or listing.
    const { header } = getRawHeader(archive);
    requireCheck(header?.files && !Object.hasOwn(header.files, '.env'), 'Invalid archive or packaged startup can discover a bundled .env file');

    const paths = prepareLaunchPaths(workRoot, target);
    env = smokeRuntimeEnvironment(process.env, paths, target);
    requireCheck(target !== 'linux' || env.DISPLAY, 'Linux probe requires X11 or Xvfb');
    const runStage = async (name, action) => {
      stage = name;
      diagnostics.checks ??= {};
      diagnostics.checks[name] = 'failed';
      const value = await deadline(action, CHECK_MS, signal);
      diagnostics.checks[name] = 'passed';
      return value;
    };
    if (checkBeforeLaunch) await checkBeforeLaunch({ fixture, userData, env, signal, runStage });
    stage = 'launch';
    const { _electron } = await import('playwright');
    requireCheck(!signal?.aborted, 'Interrupted');

    const start = performance.now();
    const remaining = () => Math.max(1, STARTUP_MS - (performance.now() - start));
    // Let Playwright finish its launch cleanup or return the child handle. If
    // it never gives us a handle, we cannot independently confirm tree exit.
    diagnostics.cleanup = 'unconfirmed';
    app = await _electron.launch({ executablePath, args: [`--user-data-dir=${userData}`], cwd: paths.cwd, env, timeout: remaining() });
    child = app.process();
    tracked = trackChild(child, diagnostics);
    stage = 'runtime-identity';
    const runtime = await deadline(() => app.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      appPath: app.getAppPath(),
      resources: process.resourcesPath,
      executable: process.execPath,
      platform: process.getBuiltinModule('node:os').platform(),
      arch: process.getBuiltinModule('node:os').arch(),
      version: app.getVersion(),
      home: process.getBuiltinModule('node:os').homedir(),
      electronHome: app.getPath('home'),
      userData: app.getPath('userData'),
      cwd: process.cwd(),
    })), remaining(), signal);
    requireCheck(runtime.packaged === true, 'Electron is not running a packaged app');
    requireCheck(runtime.platform === target && runtime.arch === expected.arch, 'Observed runtime platform or architecture differs');
    requireCheck(runtime.version === expected.version, 'Embedded version differs');
    requireCheck(runtimePathMatches(runtime.appPath, archive) && runtimePathMatches(runtime.resources, resources) && runtimePathMatches(runtime.executable, executablePath), 'Runtime did not load from the staged artifact');
    requireCheck(runtimePathMatches(runtime.home, paths.home) && runtimePathMatches(runtime.userData, userData) && runtimePathMatches(runtime.cwd, paths.cwd), 'Effective home, userData or cwd is not isolated');
    // Some native APIs resolve the account profile rather than HOME/USERPROFILE.
    // That must be the attested disposable account, never an arbitrary third path.
    requireCheck(runtimePathMatches(runtime.electronHome, paths.home) || (target !== 'linux' && runtimePathMatches(runtime.electronHome, accountHome)), 'Electron home is not disposable');

    stage = 'renderer-preload';
    const renderer = join(archive, 'out', 'renderer', 'index.html');
    const page = await deadline(async () => {
      const window = await app.firstWindow({ timeout: remaining() });
      await window.waitForURL((url) => url.protocol === 'file:' && relative(fileURLToPath(url), renderer) === '', { timeout: remaining() });
      await window.waitForFunction(() => document.readyState !== 'loading' && typeof window.electronAPI?.getAppVersion === 'function', null, { timeout: remaining() });
      return window;
    }, remaining(), signal);
    diagnostics.startup = 'passed';
    stage = 'exercise';
    const identity = { platform: runtime.platform, arch: runtime.arch, version: runtime.version };
    diagnostics.observed = { ...identity };
    const evidence = await deadline(() => exercise({ page, app, fixture, userData, env, identity, signal, runStage }), STARTUP_MS, signal);
    result = { ...identity, evidence };
  } catch (error) {
    failure = { stage, message: launchFailureMessage(error, stage) };
  } finally {
    if (tracked) {
      try {
        diagnostics.cleanup = await closeRuntime(app, child, tracked, env);
      } catch {
        // Cleanup status tells the caller not to reuse this runner's paths.
      }
    }
  }
  if (app && diagnostics.cleanup !== 'closed') {
    failure ??= { stage: 'cleanup', message: 'Electron did not shut down cleanly' };
  }
  if (failure) throw Object.assign(new Error(`${failure.stage}: ${failure.message}`), { stage: failure.stage, diagnostics });
  return { ...result, diagnostics };
}

async function listSmokeProjects(page) {
  const listed = await page.evaluate(() => window.electronAPI.getProjects());
  requireCheck(listed?.success === true && Array.isArray(listed.data), 'Could not list projects through preload');
  return listed.data;
}

async function checkProject(page, fixture, mode, baseline) {
  // Read first in both modes; do not use addProject's idempotency to hide a bad restore.
  let projects = await listSmokeProjects(page);
  let id = baseline?.project?.id;
  if (mode === 'baseline') {
    requireCheck(projects.length === 0, 'Baseline profile already has projects');
    const registered = await page.evaluate((path) => window.electronAPI.addProject(path), fixture);
    requireCheck(registered?.success === true && typeof registered.data?.id === 'string' && registered.data.id.length > 0, 'Could not register fixture through preload');
    id = registered.data.id;
    const git = await page.evaluate((path) => window.electronAPI.checkGitStatus(path), fixture);
    requireCheck(git?.success === true && git.data?.isGitRepo === true && git.data.hasCommits === true && git.data.currentBranch === INITIAL_BRANCH, 'Packaged app did not recognize the committed Git fixture');
    const updated = await page.evaluate(({ id, mainBranch }) => window.electronAPI.updateProjectSettings(id, { mainBranch }), { id, mainBranch: TARGET_BRANCH });
    requireCheck(updated?.success === true, 'Could not set the fixture target branch');
    projects = await listSmokeProjects(page);
  }
  const project = projects[0];
  requireCheck(projects.length === 1 && typeof id === 'string' && project?.id === id && typeof project.path === 'string' && runtimePathMatches(project.path, fixture), 'Listed project ID or path differs from the fixture registration');
  requireCheck(project.settings?.mainBranch === TARGET_BRANCH, 'Listed fixture target branch differs');
  const snapshot = { id, path: fixture, settings: project.settings };
  if (mode === 'resume') {
    requireCheck(isDeepStrictEqual(snapshot, baseline.project), 'Persisted fixture identity or settings changed');
    const git = await page.evaluate((path) => window.electronAPI.checkGitStatus(path), fixture);
    requireCheck(git?.success === true && git.data?.isGitRepo === true && git.data.hasCommits === true && git.data.currentBranch === INITIAL_BRANCH, 'Packaged app did not recognize the committed Git fixture');
  }
  return snapshot;
}

// Executed by Playwright in the packaged renderer, with no Node imports or IPC hooks.
export async function exerciseSmokeTerminal({ id, cwd, input, line, timeout }) {
  const api = window.electronAPI;
  let started = false;
  let sampling = false;
  let timer;
  let output = '';
  let matched;
  const proof = new Promise((resolve) => { matched = resolve; });
  const esc = String.fromCharCode(27);
  const bel = String.fromCharCode(7);
  const ansi = new RegExp(`${esc}\\[[0-?]*[ -/]*[@-~]|${esc}\\][^${bel}${esc}]*(?:${bel}|${esc}\\\\)`, 'g');
  const unsubscribe = api.onTerminalOutput((terminalId, chunk) => {
    if (!sampling || terminalId !== id || typeof chunk !== 'string') return;
    output = (output + chunk).slice(-16_384);
    const lines = output.replace(ansi, '').replace(/\r\n?/g, '\n').split('\n');
    // Only complete lines count. The nonce does not occur in the input at all.
    if (lines.slice(0, -1).includes(line)) matched(true);
  });
  let outcome;
  let destroyed = false;
  try {
    started = (await api.createTerminal({ id, cwd, cols: 120, rows: 24, skipOAuthToken: true }))?.success === true;
    if (!started) return 'create-failed';
    sampling = true;
    timer = setTimeout(() => matched(false), timeout);
    api.sendTerminalInput(id, input);
    outcome = await proof ? 'passed' : 'missing-output';
  } finally {
    clearTimeout(timer);
    try {
      unsubscribe();
    } finally {
      if (started) destroyed = (await api.destroyTerminal(id))?.success === true;
    }
  }
  return destroyed ? outcome : 'destroy-failed';
}

function memoryFile(userData) {
  return canonicalEntry(join(userData, 'memory.db'), userData, 'file');
}

/**
 * Run the full packaged smoke. Pass the state from createSmokeFixture as fixtureState.
 * Use mode='baseline' for a fresh profile and mode='resume' with the baseline
 * result's evidence for an existing profile. Keep evidence in memory: only diagnostics
 * (not fixture/profile paths or project settings) are intended for public reports.
 */
export async function probePackagedRuntime({ signal, ...options }) {
  requireCheck(!signal?.aborted, 'Interrupted');
  // Playwright's Electron launcher installs process-level signal handlers that
  // can call process.exit(130). Only the main thread receives OS signals, and
  // process.exit in a worker stops only that worker, not the owning CLI.
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { role: WORKER_ROLE, options }, execArgv: [], stdout: true, stderr: true,
  });
  worker.stdout.resume();
  worker.stderr.resume();
  let outcome;
  worker.once('message', (message) => { outcome = message; });
  worker.once('error', () => {}); // Missing result is treated as unconfirmed cleanup.
  const exited = new Promise((resolve) => worker.once('exit', resolve));
  const interrupt = () => worker.postMessage('abort');
  signal?.addEventListener('abort', interrupt, { once: true });
  let exitCode;
  try {
    // Do not race against the abort signal: the worker must still close Electron
    // and exit before the caller can swap or remove any of its paths.
    exitCode = await deadline(() => exited, WORKER_MS);
  } catch {
    worker.unref();
    void worker.terminate().catch(() => {});
  } finally {
    signal?.removeEventListener('abort', interrupt);
  }
  if (exitCode !== 0 || !outcome) {
    throw Object.assign(new Error('Probe worker did not confirm shutdown'), {
      stage: 'probe-worker', diagnostics: { cleanup: 'unconfirmed' },
    });
  }
  if (outcome.error) {
    const { message, stage, diagnostics } = outcome.error;
    throw Object.assign(new Error(message), { stage, diagnostics });
  }
  if (signal?.aborted) {
    throw Object.assign(new Error('Interrupted'), { stage: 'probe-worker', diagnostics: outcome.result.diagnostics });
  }
  return outcome.result;
}

async function probeInWorker(options) {
  const { mode, baseline, fixtureState } = options;
  return withPackagedRuntime({ ...options, fixture: fixtureState?.path }, async ({ page, fixture, userData, env, identity, signal, runStage }) => {
    const version = await runStage('ipc-version', async () => {
      const observed = await page.evaluate(() => window.electronAPI.getAppVersion());
      requireCheck(observed === identity.version, 'Preload-reported app version differs from the expected version');
      return observed;
    });
    const project = await runStage('project', () => checkProject(page, fixture, mode, baseline));
    await runStage('pty', async () => {
      // Emit a newline before the marker so even a prompt without a newline cannot mask it.
      const input = identity.platform === 'win32' ? `echo. & type ${MARKER_FILE}\r` : `printf '\\n'; cat ${MARKER_FILE}\r`;
      const outcome = await page.evaluate(exerciseSmokeTerminal, {
        id: randomUUID(), cwd: fixture, input, line: fixtureState.line, timeout: 10_000,
      });
      requireCheck(outcome !== 'create-failed', 'Packaged terminal creation failed');
      requireCheck(outcome !== 'destroy-failed', 'Packaged terminal destruction failed');
      requireCheck(outcome === 'passed', 'Packaged terminal did not emit the fixture marker');
    });
    await runStage('libsql', async () => {
      const status = await page.evaluate((id) => window.electronAPI.getMemoryStatus(id), project.id);
      requireCheck(status?.success === true && status.data?.enabled === true && status.data.available === true, 'Packaged memory service is unavailable');
      requireCheck(status.data.projectMemoryCount === 0, 'Expected a successful libSQL query with numeric zero memories');
      const db = memoryFile(userData);
      requireCheck(typeof status.data.dbPath === 'string' && runtimePathMatches(status.data.dbPath, db), 'Memory IPC database path differs from the isolated profile');
    });
    await runStage('fixture-after', () => verifyFixture(fixture, fixtureState, env, signal));
    return { version, userData, project };
  }, async ({ fixture, userData, env, signal, runStage }) => {
    await runStage('fixture-before', () => verifyFixture(fixture, fixtureState, env, signal));
    await runStage('profile-before', () => {
      requireCheck(mode === 'baseline' || mode === 'resume', 'Use baseline or resume mode');
      if (mode === 'resume') {
        requireCheck(baseline?.userData === userData && baseline.project?.path === fixture, 'Resume requires the same baseline profile and fixture');
        memoryFile(userData);
      } else {
        requireAbsent(join(userData, 'memory.db'), 'Baseline profile already has a memory database');
      }
    });
  });
}

if (parentPort && workerData?.role === WORKER_ROLE) {
  // Playwright 1.58.2 leaves floating rejections ("Process failed to launch!",
  // launch timeouts) even when the awaited _electron.launch() is caught. In a
  // worker those would end the thread before it reports the sanitized stage.
  // Count them only: their messages can contain paths, so never forward them.
  // If the worker still exits without a result, the caller fails closed.
  let asyncErrors = 0;
  const swallow = () => { asyncErrors = Math.min(1_000, asyncErrors + 1); };
  process.on('unhandledRejection', swallow);
  process.on('uncaughtException', swallow);
  const controller = new AbortController();
  parentPort.once('message', () => controller.abort());
  try {
    const result = await probeInWorker({ ...workerData.options, signal: controller.signal });
    parentPort.postMessage({ result: { ...result, diagnostics: { ...result.diagnostics, asyncErrors } } });
  } catch ({ message, stage, diagnostics }) {
    // Only send the sanitized errors produced by withPackagedRuntime.
    if (diagnostics) parentPort.postMessage({ error: { message, stage, diagnostics: { ...diagnostics, asyncErrors } } });
  } finally {
    parentPort.close();
  }
}
