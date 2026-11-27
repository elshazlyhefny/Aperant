// zeenha fork: rehearse the manual AppImage installer without touching a real install.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync, appendFileSync, constants, copyFileSync, createReadStream, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { arch, homedir, platform, userInfo } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';

const SOURCE = dirname(dirname(fileURLToPath(import.meta.url)));
const TARGET = { platform: 'linux', arch: 'x64' };
const BUILD_MS = 30 * 60_000;
const STOP_MS = 5_000;
const OUTPUT_CAP = 1_000_000;
const PROBE_CHECKS = ['fixture-before', 'profile-before', 'ipc-version', 'project', 'pty', 'libsql', 'fixture-after'];
const USAGE = `Usage:
  node scripts/smoke-desktop-linux.mjs --run --baseline-ref <local-ref> [--candidate-ref <local-ref>] [--keep-diagnostics]

Use trusted committed refs on a fresh, credential-free Linux x64 account or VM,
with Node 24, build tools and an X11 display (or xvfb-run --auto-servernum).
--run attests that this is a disposable runner; do not run on your everyday account.
A candidate ref must have a higher desktop version. Without one, a generated copy
of the same ref gets a zeenha.N bump: this tests swapping, not migration compatibility.
Builds never publish; the installer only writes to a temporary override.
--keep-diagnostics retains only the sanitized JSON report in a separate temporary directory.
`;

class SmokeError extends Error {}

function check(condition, message) {
  if (!condition) throw new SmokeError(message);
}

function entry(path) {
  return lstatSync(path, { throwIfNoEntry: false });
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function disjoint(path, protectedRoots) {
  check(protectedRoots.every((root) => root !== path && !inside(root, path) && !inside(path, root)),
    'Disposable path overlaps a protected root');
}

function canonical(path, root, kind) {
  check(isAbsolute(path) && resolve(path) === path && (!root || inside(root, path)), 'Path escapes its disposable root');
  const stat = entry(path);
  check(stat && realpathSync(path) === path && (kind === 'file' ? stat.isFile() && stat.size > 0 : stat.isDirectory()),
    `Expected a canonical ${kind}`);
  return stat;
}

function sameEntry(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

export function createOwnedDirectory(parent, prefix, protectedRoots) {
  canonical(parent, null, 'directory');
  check(/^[a-z-]+-$/.test(prefix), 'Invalid disposable directory prefix');
  // A protected sibling (e.g. a checkout under /tmp) is fine, but never create
  // children inside a protected path. Verify the owned inode before deletion.
  check(protectedRoots.every((root) => root !== parent && !inside(root, parent)),
    'Temporary directory parent is protected');
  const path = mkdtempSync(join(parent, prefix));
  disjoint(path, protectedRoots);
  const identity = canonical(path, parent, 'directory');
  return {
    path,
    verify() {
      disjoint(path, protectedRoots);
      check(sameEntry(canonical(path, parent, 'directory'), identity), 'Disposable directory was replaced');
      return path;
    },
    remove() {
      rmSync(this.verify(), { recursive: true });
    },
  };
}

function makeDirectory(parent, name) {
  const path = join(parent, name);
  mkdirSync(path, { mode: 0o700 });
  return path;
}

function preparePaths(root) {
  const paths = Object.fromEntries(['cwd', 'home', 'config', 'cache', 'data', 'state', 'runtime', 'tmp']
    .map((name) => [name, makeDirectory(root, name)]));
  paths.emptyConfig = join(root, 'empty-config');
  writeFileSync(paths.emptyConfig, '', { flag: 'wx', mode: 0o600 });
  return paths;
}

export function buildEnvironment(inherited, paths, nodePath = process.execPath) {
  const path = inherited.PATH || '/usr/bin:/bin';
  check(path.split(delimiter).every(isAbsolute), 'Use only absolute tool directories in PATH');
  const env = Object.fromEntries(['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM']
    .filter((key) => inherited[key]).map((key) => [key, inherited[key]]));
  return {
    ...env,
    PATH: `${dirname(nodePath)}${delimiter}${path}`,
    HOME: paths.home,
    SHELL: '/bin/sh',
    XDG_CONFIG_HOME: paths.config,
    XDG_CACHE_HOME: paths.cache,
    XDG_DATA_HOME: paths.data,
    XDG_STATE_HOME: paths.state,
    XDG_RUNTIME_DIR: paths.runtime,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(paths.runtime, 'no-session-bus')}`,
    TMPDIR: paths.tmp,
    TMP: paths.tmp,
    TEMP: paths.tmp,
    GIT_CONFIG_GLOBAL: paths.emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    npm_config_userconfig: paths.emptyConfig,
    npm_config_globalconfig: paths.emptyConfig,
    npm_config_cache: join(paths.cache, 'npm'),
    npm_config_devdir: join(paths.cache, 'node-gyp'),
    ELECTRON_CACHE: join(paths.cache, 'electron'),
    ELECTRON_BUILDER_CACHE: join(paths.cache, 'electron-builder'),
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  };
}

function semver(value) {
  const m = typeof value === 'string' && value.length <= 128 &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  check(m && m[0] === value, 'Expected a valid desktop SemVer');
  const pre = m[4]?.split('.') ?? [];
  check(!pre.some((part) => /^0\d+$/.test(part)), 'Numeric SemVer prerelease identifiers cannot have leading zeroes');
  return { core: m.slice(1, 4).map(BigInt), pre };
}

function compare(left, right) {
  return left === right ? 0 : left > right ? 1 : -1;
}

export function compareVersions(left, right) {
  const a = semver(left);
  const b = semver(right);
  for (let i = 0; i < 3; i++) {
    const order = compare(a.core[i], b.core[i]);
    if (order) return order;
  }
  if (!a.pre.length || !b.pre.length) return compare(!a.pre.length, !b.pre.length);
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const [x, y] = [a.pre[i], b.pre[i]];
    if (x === y) continue;
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx !== ny) return nx ? -1 : 1;
    return nx ? compare(BigInt(x), BigInt(y)) : compare(x, y);
  }
  return compare(a.pre.length, b.pre.length);
}

export function nextForkVersion(version) {
  semver(version);
  const m = /^(.*\.zeenha\.)(\d+)$/.exec(version);
  check(m, 'Same-revision mode requires a desktop version ending in .zeenha.N');
  const next = `${m[1]}${BigInt(m[2]) + 1n}`;
  semver(next);
  return next;
}

export function selectAppImage(dist, source) {
  canonical(dist, source, 'directory');
  const images = readdirSync(dist).filter((name) => name.endsWith('.AppImage'));
  check(images.length === 1, 'Expected exactly one AppImage in the fresh build output');
  check(/^[0-9A-Za-z_.+-]{1,200}$/.test(images[0]), 'Unexpected AppImage basename');
  const image = join(dist, images[0]);
  canonical(image, dist, 'file');
  accessSync(image, constants.X_OK);
  return image;
}

async function artifactIdentity(path, signal) {
  const sha = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) sha.update(chunk);
  return { name: basename(path), bytes: lstatSync(path).size, sha256: sha.digest('hex') };
}

function signalGroup(pid, signal) {
  if (!pid) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function groupExited(pid, grace) {
  const end = performance.now() + grace;
  while (signalGroup(pid, 0)) {
    if (performance.now() >= end) return false;
    await sleep(50);
  }
  return true;
}

/** Own one detached Linux process group per command. Never kill by name or install path. */
export async function runSmokeCommand(file, args, { cwd, env, signal, timeout = BUILD_MS, capture = false }) {
  check(!signal?.aborted, 'Interrupted');
  const child = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = { stdout: 0, stderr: 0 };
  let text = '';
  let spawnFailed = false;
  let closed = false;
  let reaped = false;
  child.once('error', () => { spawnFailed = true; });
  const done = new Promise((done) => child.once('close', (code) => { closed = true; done(code); }));
  for (const stream of ['stdout', 'stderr']) {
    child[stream].on('data', (chunk) => {
      output[stream] = Math.min(OUTPUT_CAP, output[stream] + chunk.length);
      if (capture && stream === 'stdout' && output.stdout <= 512) text += chunk.toString('utf8');
    });
  }
  let timer;
  let abort;
  try {
    const interrupted = new Promise((_, reject) => {
      abort = () => reject(new SmokeError('Interrupted'));
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(new SmokeError('Command deadline expired')), timeout);
    });
    const code = await Promise.race([done, interrupted]);
    check(!spawnFailed, 'Could not start command; check runner prerequisites');
    check(code === 0, Number.isInteger(code) ? `Command exited with code ${code}` : 'Command was terminated');
    reaped = await groupExited(child.pid, 1000);
    check(reaped, 'Command left an owned process running');
    check(!signal?.aborted, 'Interrupted');
    check(!capture || output.stdout <= 512, 'Unexpected command response size');
    return { text, output };
  } catch (error) {
    error.output = output;
    try {
      if (!reaped && signalGroup(child.pid, 'SIGTERM') && !await groupExited(child.pid, 1000)) {
        signalGroup(child.pid, 'SIGKILL');
      }
      const exited = reaped || await groupExited(child.pid, STOP_MS);
      if (!closed) await Promise.race([done, sleep(STOP_MS, undefined, { ref: false })]);
      error.cleanupUnconfirmed = !exited || !closed;
    } catch {
      error.cleanupUnconfirmed = true;
    } finally {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function auditExport(path) {
  for (const item of readdirSync(path, { withFileTypes: true })) {
    check(item.isFile() || item.isDirectory(), 'Build export contains a link or special file');
    check(!['node_modules', '.git', '.npmrc'].includes(item.name), 'Build export includes dependency or tool configuration state');
    check(!/^\.env(?:\.|$)/.test(item.name) || (item.isFile() && item.name === '.env.example'), 'Build export includes a dotenv file');
    if (item.isDirectory()) auditExport(join(path, item.name));
  }
}

function manifest(source) {
  return join(source, 'apps', 'desktop', 'package.json');
}

function readVersion(source) {
  const file = manifest(source);
  canonical(file, source, 'file');
  const { version } = JSON.parse(readFileSync(file, 'utf8'));
  semver(version);
  return version;
}

function installState(root, path) {
  check(inside(root, path), 'Install path escapes the disposable root');
  if (!entry(path)) return null;
  const state = canonical(path, root, 'directory');
  const executable = join(path, 'aperant');
  canonical(executable, path, 'file');
  accessSync(executable, constants.X_OK);
  return state;
}

function requireProbeEvidence(result, expected, profile, fixture, baseline) {
  check(result?.platform === expected.platform && result.arch === expected.arch && result.version === expected.version &&
    result.evidence?.version === expected.version, 'Observed packaged architecture or IPC version differs');
  check(result.evidence.userData === profile && result.evidence.project?.path === fixture.path &&
    result.evidence.project.id && result.evidence.project.settings?.mainBranch, 'Probe did not confirm the isolated profile and fixture');
  check(!baseline || isDeepStrictEqual(result.evidence.project, baseline.project), 'Persisted project identity or settings changed');
  check(result.diagnostics?.startup === 'passed' && result.diagnostics.cleanup === 'closed' &&
    PROBE_CHECKS.every((name) => result.diagnostics.checks?.[name] === 'passed'), 'Packaged runtime proof or clean shutdown is incomplete');
  canonical(join(profile, 'memory.db'), profile, 'file');
}

/** Run stages serially. Injection points permit orchestration tests with no installer or Electron. */
export async function rehearseLinux({ work, source, baselineRef, candidateRef, signal, emit,
  inherited = process.env, command = runSmokeCommand, loadProbe = (file) => import(pathToFileURL(file).href) }) {
  const stage = async (name, fn, evidence = () => ({})) => {
    try {
      check(!signal?.aborted, 'Interrupted');
      work.verify();
      const result = await fn();
      check(!signal?.aborted, 'Interrupted');
      emit({ stage: name, status: 'passed', ...evidence(result) });
      return result;
    } catch (error) {
      emit({ stage: name, status: 'failed', message: error instanceof SmokeError ? error.message : 'Stage failed', output: error.output });
      throw error;
    }
  };
  const invoke = (file, args, options) => command(file, args, { signal, ...options });
  const commandEvidence = (result) => ({ output: result.output });
  const root = work.verify();
  const setupPaths = preparePaths(makeDirectory(root, 'tool-state'));
  const toolEnv = buildEnvironment(inherited, setupPaths);
  const installer = join(makeDirectory(root, 'installer'), 'zeenha-release.sh');
  const profile = makeDirectory(root, 'profile');
  const install = join(makeDirectory(root, 'installation'), 'live');
  const previous = `${install}.previous`;
  const probeDir = makeDirectory(root, 'probe');
  await stage('prepare', () => {
    copyFileSync(join(source, 'scripts', 'zeenha-release.sh'), installer, constants.COPYFILE_EXCL);
    copyFileSync(join(source, 'apps', 'desktop', 'scripts', 'smoke-desktop-runtime.mjs'), join(probeDir, 'probe.mjs'), constants.COPYFILE_EXCL);
  });

  const exportRef = async (slot, ref) => {
    const commit = await stage(`${slot}:resolve`, async () => {
      check(typeof ref === 'string' && /^[0-9A-Za-z_][0-9A-Za-z_./-]{0,199}$/.test(ref), 'Use a local ref name or commit ID');
      const { text } = await invoke('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
        { cwd: source, env: toolEnv, timeout: 10_000, capture: true });
      const oid = text.trim();
      check(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid), 'Could not resolve a committed local ref');
      return oid;
    }, (commit) => ({ ref, commit }));
    return stage(`${slot}:export`, async () => {
      const tree = makeDirectory(root, `source-${slot}`);
      const archive = join(root, `source-${slot}.tar`);
      await invoke('git', ['archive', '--format=tar', `--output=${archive}`, commit], { cwd: source, env: toolEnv });
      canonical(archive, root, 'file');
      await invoke('tar', ['-xf', archive, '--no-same-owner', '--no-same-permissions'], { cwd: tree, env: toolEnv });
      rmSync(archive);
      auditExport(tree);
      return { tree, version: readVersion(tree), commit };
    }, ({ version }) => ({ version }));
  };

  const a = await exportRef('A', baselineRef);
  const b = await exportRef('B', candidateRef ?? baselineRef);
  await stage('version-order', () => {
    check(candidateRef !== undefined || a.commit === b.commit, 'Baseline ref moved during export');
    b.expected = candidateRef === undefined ? nextForkVersion(a.version) : b.version;
    check(compareVersions(b.expected, a.version) > 0, 'Candidate desktop version must be higher than baseline');
    a.expected = a.version;
  }, () => ({ baseline: a.expected, candidate: b.expected, mode: candidateRef === undefined ? 'swap-only' : 'two-ref' }));

  const build = async (slot, { tree, version, expected, commit }) => {
    const env = buildEnvironment(inherited, preparePaths(makeDirectory(root, `build-${slot}`)));
    const desktop = join(tree, 'apps', 'desktop');
    const dist = join(desktop, 'dist');
    await stage(`${slot}:npm-ci`, () => invoke('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], { cwd: tree, env }), commandEvidence);
    await stage(`${slot}:build`, async () => {
      check(readVersion(tree) === version && !entry(dist), 'Build inputs changed or contain stale dist output');
      if (version !== expected) {
        const file = manifest(tree);
        const before = readFileSync(file, 'utf8');
        const after = before.replace(/("version"\s*:\s*")[^"]+("\s*[,}])/, (_, start, end) => `${start}${expected}${end}`);
        check(after !== before && JSON.parse(after).version === expected, 'Could not bump the generated desktop manifest');
        writeFileSync(file, after);
      }
      return invoke('npm', ['run', 'build'], { cwd: tree, env });
    }, commandEvidence);
    await stage(`${slot}:package`, async () => {
      check(!entry(dist) && readVersion(tree) === expected, 'Unexpected dist output or changed desktop version before packaging');
      const builder = [desktop, tree].map((dir) => join(dir, 'node_modules', '.bin', 'electron-builder')).find(entry);
      check(builder, 'electron-builder is missing from the isolated workspace');
      const executable = realpathSync(builder);
      canonical(executable, tree, 'file');
      return invoke(executable, ['--linux', 'AppImage', '--x64', '--publish', 'never', '--config.directories.output=dist'], { cwd: desktop, env });
    }, commandEvidence);
    return stage(`${slot}:artifact`, async () => {
      const image = selectAppImage(dist, tree);
      return { image, commit, expected, ...(await artifactIdentity(image, signal)) };
    }, ({ commit, expected, name, bytes, sha256 }) => ({ commit, version: expected, artifact: { name, bytes, sha256 } }));
  };
  const baselineArtifact = await build('A', a);
  const candidateArtifact = await build('B', b);

  const probe = await stage('prepare-probe', async () => {
    // Match the probe dependencies in the current lockfile, independently of either tested ref.
    writeFileSync(join(probeDir, 'package.json'), JSON.stringify({ private: true, dependencies: { playwright: '1.58.2', '@electron/asar': '3.4.1' } }), { flag: 'wx' });
    const { output } = await invoke('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: probeDir, env: toolEnv });
    for (const pkg of ['playwright', '@electron/asar']) canonical(join(probeDir, 'node_modules', pkg), probeDir, 'directory');
    return { ...await loadProbe(join(probeDir, 'probe.mjs')), output };
  }, commandEvidence);
  const opts = { workRoot: root, protectedRoots: [source], disposableRunner: true, signal };
  const fixture = await stage('fixture', () => probe.createSmokeFixture(opts));
  let baseline;
  const launch = (slot, artifact) => stage(`${slot}:runtime`, async () => {
    const expected = { ...TARGET, version: artifact.expected };
    let result;
    try {
      result = await probe.probePackagedRuntime({ ...opts, expected, fixtureState: fixture, userData: profile,
        artifactRoot: install, executablePath: join(install, 'aperant'), mode: baseline ? 'resume' : 'baseline', baseline });
    } catch (error) {
      if (error.diagnostics?.cleanup === 'unconfirmed') error.cleanupUnconfirmed = true;
      // The shared probe only supplies a message with diagnostics after sanitizing
      // Playwright and application errors. Never report unexpected raw exceptions.
      if (error.diagnostics) {
        emit({ stage: `${slot}:probe`, status: 'failed', check: error.stage, message: error.message.slice(0, 256), diagnostics: error.diagnostics });
      }
      throw error;
    }
    if (result?.diagnostics?.cleanup === 'unconfirmed') {
      throw Object.assign(new SmokeError('Probe process exit could not be confirmed'), { cleanupUnconfirmed: true });
    }
    requireProbeEvidence(result, expected, profile, fixture, baseline);
    return result;
  }, ({ evidence, arch, diagnostics }) => ({ version: evidence.version, arch, diagnostics }));

  const swap = (name, artifact, before, after) => stage(name, async () => {
    canonical(dirname(install), root, 'directory');
    const live = installState(root, install);
    const saved = installState(root, previous);
    before(live, saved);
    if (artifact) {
      canonical(artifact.image, root, 'file');
      accessSync(artifact.image, constants.X_OK);
      const identity = await artifactIdentity(artifact.image, signal);
      check(artifact.sha256 === identity.sha256, 'AppImage changed before installation');
    }
    // These are the only installer modes that do not build, commit or publish.
    const result = await invoke('/bin/bash', [installer, ...(artifact ? ['--install', artifact.image] : ['--rollback'])], {
      cwd: setupPaths.cwd, env: { ...toolEnv, APERANT_INSTALL_DIR: install }, timeout: 5 * 60_000,
    });
    const installed = after(installState(root, install), installState(root, previous));
    return { installed, output: result.output };
  }, commandEvidence);

  const installedA = (await swap('install:A', baselineArtifact,
    (live, saved) => check(!live && !saved, 'Expected an empty initial installation'),
    (live, saved) => { check(live && !saved, 'First install unexpectedly has no live app or has a previous app'); return live; })).installed;
  baseline = (await launch('A', baselineArtifact)).evidence;
  const installedB = (await swap('install:B', candidateArtifact,
    (live, saved) => check(sameEntry(live, installedA) && !saved, 'Baseline installation changed before upgrade'),
    (live, saved) => { check(live && !sameEntry(live, installedA) && sameEntry(saved, installedA), 'Upgrade did not retain baseline as .previous'); return live; })).installed;
  await launch('B', candidateArtifact);
  await swap('rollback:A', null,
    (live, saved) => check(sameEntry(live, installedB) && sameEntry(saved, installedA), 'Upgrade installation changed before rollback'),
    (live, saved) => check(sameEntry(live, installedA) && sameEntry(saved, installedB), 'Rollback did not swap live and .previous installs'));
  await launch('rollback', baselineArtifact);
}

async function main() {
  const { values } = parseArgs({ options: {
    help: { type: 'boolean', short: 'h' }, run: { type: 'boolean' }, 'baseline-ref': { type: 'string' },
    'candidate-ref': { type: 'string' }, 'keep-diagnostics': { type: 'boolean' },
  } });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  check(values.run && values['baseline-ref'], 'Use --help; --run and --baseline-ref are required');
  check(platform() === TARGET.platform && arch() === TARGET.arch && process.versions.node.split('.')[0] === '24', 'Use Linux x64 with Node 24');
  check(process.geteuid() !== 0, 'Use a non-root disposable user');
  check(process.env.DISPLAY, 'A working X11 display or Xvfb is required');
  check(!process.env.XAUTHORITY || isAbsolute(process.env.XAUTHORITY), 'Use an absolute XAUTHORITY path');

  const parent = realpathSync('/tmp');
  const source = realpathSync(SOURCE);
  const protectedRoots = [source, realpathSync(process.cwd()), realpathSync(userInfo().homedir), resolve(homedir())];
  process.exitCode = await runLinuxSmoke({ parent, source, protectedRoots, baselineRef: values['baseline-ref'],
    candidateRef: values['candidate-ref'], keepDiagnostics: values['keep-diagnostics'] });
}

// The CLI owns its disposable paths and reporting, independently of the runtime worker.
export async function runLinuxSmoke({ parent, source, protectedRoots, baselineRef, candidateRef, keepDiagnostics }, rehearse = rehearseLinux) {
  const controller = new AbortController();
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map((name) => [name, () => controller.abort()]));
  for (const [name, handler] of handlers) process.on(name, handler);
  const records = [];
  let journal;
  let journalFailed = false;
  const emit = (record) => {
    records.push(record);
    const line = `${JSON.stringify(record)}\n`;
    if (journal && !journalFailed) {
      try {
        appendFileSync(journal, line, { mode: 0o600 });
      } catch {
        journalFailed = true;
      }
    }
    process.stdout.write(line);
  };
  let work;
  let safeToRemove = true;
  let passed = false;
  try {
    work = createOwnedDirectory(parent, 'aperant-smoke-', protectedRoots);
    journal = join(makeDirectory(work.verify(), 'logs'), 'stages.jsonl');
    writeFileSync(journal, '', { flag: 'wx', mode: 0o600 });
    await rehearse({ work, source, baselineRef, candidateRef, signal: controller.signal, emit });
    passed = !controller.signal.aborted;
  } catch (error) {
    safeToRemove = !error.cleanupUnconfirmed && error.diagnostics?.cleanup !== 'unconfirmed';
    if (!work || records.at(-1)?.status !== 'failed') {
      emit({ stage: 'setup', status: 'failed', message: error instanceof SmokeError ? error.message : 'Could not prepare the disposable run' });
    }
  } finally {
    journal = undefined;
    if (journalFailed) {
      passed = false;
      emit({ stage: 'logs', status: 'failed', message: 'Could not write the temporary stage log' });
    }
    try {
      if (work && safeToRemove) {
        work.remove();
        emit({ stage: 'cleanup', status: 'passed' });
      } else if (work) {
        emit({ stage: 'cleanup', status: 'failed', message: 'Owned process exit unconfirmed; retire the disposable runner without reusing its paths' });
      }
    } catch {
      passed = false;
      emit({ stage: 'cleanup', status: 'failed', message: 'Guarded work directory removal failed; retire the disposable runner' });
    }
    passed &&= !controller.signal.aborted;
    emit({ stage: 'rehearsal', status: passed ? 'passed' : 'failed',
      ...(controller.signal.aborted ? { message: 'Interrupted' } : {}) });
    try {
      if (keepDiagnostics) {
        const report = createOwnedDirectory(parent, 'aperant-smoke-report-', protectedRoots);
        try {
          // Retain only stage evidence. Never copy npm/app output, builds, or the profile.
          writeFileSync(join(report.verify(), 'report.json'), `${JSON.stringify(records, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        } catch (error) {
          report.remove();
          throw error;
        }
        process.stdout.write(`Diagnostics: ${report.path}/report.json\n`);
      }
    } catch {
      passed = false;
      emit({ stage: 'diagnostics', status: 'failed', message: 'Could not retain sanitized diagnostics' });
    } finally {
      for (const [name, handler] of handlers) process.removeListener(name, handler);
    }
  }
  return passed ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    const message = error instanceof SmokeError ? error.message : 'Invalid option or runner setup; see --help';
    process.stderr.write(`${JSON.stringify({ stage: 'preflight', status: 'failed', message })}\n`);
    process.exitCode = 1;
  });
}
