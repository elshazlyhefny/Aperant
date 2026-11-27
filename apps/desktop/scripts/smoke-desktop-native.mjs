// zeenha fork: verify extract-and-run from a built native distribution, not builder output.
import { execFile } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { arch, homedir, platform, tmpdir, userInfo } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createSmokeFixture, probePackagedRuntime } from './smoke-desktop-runtime.mjs';

const SOURCE = fileURLToPath(new URL('../../../', import.meta.url));
const TARGETS = {
  'macos-arm64': { platform: 'darwin', arch: 'arm64', extension: '.dmg' },
  'macos-x64': { platform: 'darwin', arch: 'x64', extension: '.dmg' },
  'windows-x64': { platform: 'win32', arch: 'x64', extension: '.zip' },
};
const USAGE = `Usage:
  node apps/desktop/scripts/smoke-desktop-native.mjs --run --target <macos-arm64|macos-x64|windows-x64>
    --artifact <local DMG or ZIP> --version <embedded version> --source <full commit SHA> [--temp-parent <directory>]

--run attests this is a fresh, interactive, credential-free disposable runner or account.
Use Node 24 and prepared dependencies. Only run a trusted artifact from the indicated source.
The temporary parent (default: RUNNER_TEMP or OS temp) must allow a fresh directory outside the
account home and checkout. Standard output is one sanitized JSON result (except for --help).
Exit codes: 0 pass, 1 fail, 2 not run. This does not test NSIS, signing, or notarization.
`;
const STAGE_MS = 180_000;
const SYSTEM_MS = 10_000;

class SmokeError extends Error {}

function check(condition, message) {
  if (!condition) throw new SmokeError(message);
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function ownedDirectory(path, identity) {
  const entry = lstatSync(path, { bigint: true });
  check(entry.isDirectory() && relative(path, realpathSync(path)) === '' &&
    entry.dev === identity.dev && entry.ino === identity.ino, 'Temporary directory was replaced');
}

export function removeNativeStaging(workRoot, workIdentity, cleanupUnconfirmed) {
  check(!cleanupUnconfirmed, 'Mount or process cleanup unconfirmed; retire the disposable runner');
  ownedDirectory(workRoot, workIdentity);
  rmSync(workRoot, { recursive: true, maxRetries: 3, retryDelay: 100 });
}

function nativeCommand(file, args, { cwd, env, timeout = STAGE_MS }) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { cwd, env, timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true },
      (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
    child.stdin.end();
  });
}

async function interactiveRunner(target, systemRoot) {
  if (target.platform === 'darwin') {
    if (process.getuid() === 0 || statSync('/dev/console').uid !== process.getuid()) return false;
    // Reject x64 Node under Rosetta on Apple Silicon.
    const arm64 = await nativeCommand('/usr/sbin/sysctl', ['-in', 'hw.optional.arm64'], { env: {}, timeout: SYSTEM_MS });
    return (arm64 === '1') === (target.arch === 'arm64');
  }
  return (await nativeCommand(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[Environment]::UserInteractive -and ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq "X64")',
  ], { env: { SystemRoot: systemRoot }, timeout: SYSTEM_MS })) === 'True';
}

export async function stageMac(artifact, stageRoot, workRoot, command, signal) {
  const mount = join(workRoot, 'dmg-mount');
  mkdirSync(mount, { mode: 0o700 });
  const mountDir = lstatSync(mount, { bigint: true });
  const mounted = () => lstatSync(mount, { bigint: true }).dev !== mountDir.dev;
  const bundle = join(stageRoot, 'Aperant.app');
  let stage = 'mount';
  let failure;
  let detachFailure;
  let attachTimedOut = false;
  try {
    // A single-volume builder DMG is mounted at this run's private, empty directory.
    await command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mount', 'required', '-mountpoint', mount, artifact]);
    check(mounted(), 'DMG did not mount at the owned mount point');
    stage = 'copy-bundle';
    signal.throwIfAborted();
    const sourceBundle = join(mount, 'Aperant.app');
    check(lstatSync(sourceBundle).isDirectory(), 'DMG does not contain Aperant.app');
    await command('/usr/bin/ditto', ['--rsrc', '--extattr', '--acl', sourceBundle, bundle]);
  } catch (error) {
    attachTimedOut = stage === 'mount' && error.killed === true;
    failure = Object.assign(new SmokeError(stage === 'mount' ? 'DMG mount failed' : 'Bundle copy failed'), { stage });
  } finally {
    // Never follow an interrupt out of this block before attempting to unmount.
    // Only the known mount point in our private directory is eligible for detach.
    try {
      if (mounted()) {
        await command('/usr/bin/hdiutil', ['detach', mount], SYSTEM_MS).catch(() => {});
        if (mounted()) await command('/usr/bin/hdiutil', ['detach', mount, '-force'], SYSTEM_MS);
      } else if (attachTimedOut) {
        // DiskImages may still be servicing an interrupted attach request.
        detachFailure = new SmokeError('Mount state is unconfirmed');
      }
      ownedDirectory(mount, mountDir);
    } catch (error) {
      detachFailure = error;
    }
  }
  if (detachFailure) {
    throw Object.assign(new SmokeError('DMG detach could not be confirmed; retire the disposable runner', { cause: detachFailure }), {
      stage: 'detach', cleanupUnconfirmed: true,
    });
  }
  if (failure) throw failure;
  return join(bundle, 'Contents', 'MacOS', 'Aperant');
}

async function run(values, signal) {
  const target = Object.hasOwn(TARGETS, values.target) ? TARGETS[values.target] : undefined;
  const source = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(values.source ?? '') ? values.source : null;
  const version = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(values.version ?? '') &&
    values.version.length <= 128 ? values.version : null;
  const result = { target: target ? values.target : null, artifact: 'not-produced', source, expectedVersion: version, stage: 'preflight', status: 'fail' };
  let workRoot;
  let workIdentity;
  let cleanupUnconfirmed = false;
  try {
    check(values.run && target && source && version && values.artifact, 'Missing or invalid arguments; see --help');
    const hostMatches = target.platform === platform() && target.arch === arch();
    if (!hostMatches || process.versions.node.split('.')[0] !== '24') {
      return { ...result, status: 'not run', reason: 'Requires a matching native host and Node 24' };
    }
    const systemRoot = target.platform === 'win32' ? process.env.SystemRoot : undefined;
    check(target.platform !== 'win32' || (systemRoot && isAbsolute(systemRoot)), 'SystemRoot is required');
    result.stage = 'artifact';
    const path = resolve(values.artifact);
    check(extname(path).toLowerCase() === target.extension, 'Expected a built distribution artifact, not builder unpacked output');
    const entry = lstatSync(path, { throwIfNoEntry: false });
    check(entry?.isFile() && entry.size > 0, 'Artifact is missing or not a nonempty regular file');
    const artifact = realpathSync(path);
    result.artifact = basename(path).replace(/[^A-Za-z0-9_.+ -]/g, '_').slice(0, 160);

    result.stage = 'runner';
    const interactive = await interactiveRunner(target, systemRoot);
    signal.throwIfAborted();
    if (!interactive) {
      return { ...result, status: 'not run', reason: 'Requires an interactive native desktop session' };
    }
    result.stage = 'setup';
    const parent = realpathSync(values['temp-parent'] ?? process.env.RUNNER_TEMP ?? tmpdir());
    const protectedRoots = [SOURCE, process.cwd(), homedir(), userInfo().homedir].map((path) => realpathSync(path));
    check(protectedRoots.every((root) => relative(root, parent) !== '' && !inside(root, parent)),
      'Temporary parent must be outside the account home and checkout');
    workRoot = mkdtempSync(join(parent, 'aperant-native-smoke-'));
    workIdentity = lstatSync(workRoot, { bigint: true });
    check(protectedRoots.every((root) => !inside(workRoot, root)), 'Temporary root overlaps a protected path');
    ownedDirectory(workRoot, workIdentity);
    const stageRoot = join(workRoot, 'staged');
    const userData = join(workRoot, 'profile');
    const scratch = join(workRoot, 'scratch');
    for (const dir of [stageRoot, userData, scratch]) mkdirSync(dir, { mode: 0o700 });
    const env = { HOME: scratch, TMPDIR: scratch, TEMP: scratch, TMP: scratch, ...(systemRoot ? { SystemRoot: systemRoot } : {}) };
    const command = (file, args, timeout) => nativeCommand(file, args, { cwd: scratch, env, timeout });
    const disposable = { workRoot, disposableRunner: true, protectedRoots, signal };

    result.stage = 'fixture';
    const fixtureState = await createSmokeFixture(disposable);
    result.stage = 'stage-artifact';
    signal.throwIfAborted();
    let executablePath;
    if (target.platform === 'darwin') {
      executablePath = await stageMac(artifact, stageRoot, workRoot, command, signal);
    } else {
      // Windows' system bsdtar extracts ZIPs without treating a filename as shell or PowerShell code.
      result.stage = 'extract-zip';
      await command(join(systemRoot, 'System32', 'tar.exe'), ['-xf', artifact, '-C', stageRoot]);
      executablePath = join(stageRoot, 'Aperant.exe');
    }

    result.stage = 'probe';
    signal.throwIfAborted();
    const proof = await probePackagedRuntime({
      ...disposable, artifactRoot: stageRoot, executablePath, userData, fixtureState,
      mode: 'baseline', expected: { platform: target.platform, arch: target.arch, version },
    });
    result.observed = { version: proof.version, arch: proof.arch };
    result.diagnostics = proof.diagnostics;
    signal.throwIfAborted();
    result.stage = 'complete';
    result.status = 'pass';
  } catch (error) {
    cleanupUnconfirmed = error.cleanupUnconfirmed === true || error.diagnostics?.cleanup === 'unconfirmed';
    result.stage = error.stage ?? result.stage;
    // The shared probe supplies only stage markers, runtime identity and byte counts.
    // Never include raw native command errors, stdout/stderr, or probe evidence.
    if (error.diagnostics) result.diagnostics = error.diagnostics;
    if (error.diagnostics?.observed) {
      const { version, arch } = error.diagnostics.observed;
      result.observed = { version, arch };
    }
    result.reason = signal.aborted ? 'Interrupted' : error instanceof SmokeError ? error.message : 'Stage did not complete';
  } finally {
    if (workRoot) {
      try {
        removeNativeStaging(workRoot, workIdentity, cleanupUnconfirmed);
      } catch (error) {
        result.status = 'fail';
        result.stage = 'cleanup';
        result.reason = error instanceof SmokeError ? error.message : 'Could not remove staging; retire the disposable runner';
      }
    }
  }
  return result;
}

async function main() {
  const { values } = parseArgs({ options: {
    help: { type: 'boolean', short: 'h' }, run: { type: 'boolean' }, target: { type: 'string' },
    artifact: { type: 'string' }, version: { type: 'string' }, source: { type: 'string' }, 'temp-parent': { type: 'string' },
  } });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const name of signals) process.on(name, abort);
  try {
    const result = await run(values, controller.signal);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.status === 'pass' ? 0 : result.status === 'not run' ? 2 : 1;
  } finally {
    for (const name of signals) process.removeListener(name, abort);
  }
}

if (process.argv[1] && relative(fileURLToPath(import.meta.url), resolve(process.argv[1])) === '') {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({ target: null, artifact: 'not-produced', source: null, expectedVersion: null,
      stage: 'preflight', status: 'fail', reason: 'Invalid runner setup or arguments; see --help' })}\n`);
    process.exitCode = 1;
  });
}
