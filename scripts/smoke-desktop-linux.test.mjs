// zeenha fork: test the manual AppImage rehearsal without an installer or Electron.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { arch, platform, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

import { createSmokeFixture, exerciseSmokeTerminal, probePackagedRuntime, smokeRuntimeEnvironment } from '../apps/desktop/scripts/smoke-desktop-runtime.mjs';
import { buildEnvironment, compareVersions, createOwnedDirectory, nextForkVersion, rehearseLinux, runSmokeCommand, selectAppImage } from './smoke-desktop-linux.mjs';

const A = '2.8.0-beta.1.zeenha.9';
const B = '2.8.0-beta.1.zeenha.10';
const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const linux = { skip: platform() !== 'linux' && 'Linux AppImage tooling' };

function temp(t) {
  const path = mkdtempSync(join(realpathSync(tmpdir()), 'desktop-smoke-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function directory(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

function file(path, content = 'synthetic test data', mode = 0o600) {
  directory(dirname(path));
  writeFileSync(path, content, { mode });
  return path;
}

test('owned directory blocks protected roots and symlink escapes and removes only its own tree', linux, (t) => {
  const parent = temp(t);
  const protectedRoot = directory(join(parent, 'protected'));
  const sentinel = file(join(protectedRoot, 'keep'));
  const link = join(parent, 'parent-link');
  symlinkSync(protectedRoot, link);
  assert.throws(() => createOwnedDirectory(link, 'work-', [protectedRoot]), /canonical directory/);
  assert.throws(() => createOwnedDirectory(protectedRoot, 'work-', [protectedRoot]), /parent is protected/);
  assert.throws(() => createOwnedDirectory(parent, '../work-', []), /Invalid disposable directory prefix/);

  const work = createOwnedDirectory(parent, 'work-', [protectedRoot]);
  const moved = join(parent, 'original');
  renameSync(work.path, moved);
  symlinkSync(protectedRoot, work.path);
  assert.throws(() => work.remove(), /canonical directory/);
  rmSync(work.path);
  directory(work.path);
  assert.throws(() => work.remove(), /was replaced/);
  rmSync(work.path, { recursive: true });
  renameSync(moved, work.path);
  symlinkSync(protectedRoot, join(work.path, 'child-link'));
  work.remove();
  assert.equal(existsSync(work.path), false);
  assert.equal(readFileSync(sentinel, 'utf8'), 'synthetic test data');
});

const deniedInputs = {
  APERANT_INSTALL_DIR: '/synthetic/install', ANTHROPIC_API_KEY: 'synthetic',
  GITHUB_TOKEN: 'synthetic', AWS_PROFILE: 'synthetic', CSC_LINK: 'synthetic',
  SSH_AUTH_SOCK: '/synthetic/agent', BASH_ENV: '/synthetic/bashenv',
  DOTENV_CONFIG_PATH: '/synthetic/dotenv', NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '1',
};
const inherited = {
  ...deniedInputs,
  PATH: '/usr/bin:/bin', LANG: 'C', DISPLAY: ':42', XAUTHORITY: '/synthetic/xauth',
  HOME: '/synthetic/home', XDG_CONFIG_HOME: '/synthetic/config', TMPDIR: '/synthetic/tmp',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/synthetic/bus',
  npm_config_userconfig: '/synthetic/npmrc', GIT_CONFIG_GLOBAL: '/synthetic/gitconfig',
};

test('build and runtime envs allowlist inputs and replace inherited state with isolated paths', linux, (t) => {
  const root = temp(t);
  const paths = Object.fromEntries(['home', 'config', 'cache', 'data', 'state', 'runtime', 'tmp', 'emptyConfig']
    .map((key) => [key, join(root, key)]));
  const build = buildEnvironment(inherited, paths, '/tools/node');
  const runtime = smokeRuntimeEnvironment(inherited, { ...paths, temp: paths.tmp, gitConfig: paths.emptyConfig }, 'linux');
  for (const env of [build, runtime]) {
    assert.equal(env.LANG, 'C');
    assert.equal(env.HOME, paths.home);
    assert.equal(env.XDG_CONFIG_HOME, paths.config);
    assert.equal(env.TMPDIR, paths.tmp);
    assert.equal(env.GIT_CONFIG_GLOBAL, paths.emptyConfig);
    assert.equal(env.DBUS_SESSION_BUS_ADDRESS, `unix:path=${join(paths.runtime, 'no-session-bus')}`);
    for (const key of Object.keys(deniedInputs)) {
      assert.equal(Object.hasOwn(env, key), false, `${key} must not be inherited`);
    }
  }
  assert.equal(build.PATH, '/tools:/usr/bin:/bin');
  assert.equal(build.npm_config_userconfig, paths.emptyConfig);
  assert.equal(build.ELECTRON_CACHE, join(paths.cache, 'electron'));
  assert.equal(build.DISPLAY, undefined);
  assert.equal(runtime.npm_config_userconfig, undefined);
  assert.equal(runtime.DISPLAY, inherited.DISPLAY);
  assert.equal(runtime.XAUTHORITY, inherited.XAUTHORITY);
  assert.throws(() => buildEnvironment({ PATH: '/tools:./bin' }, paths), /absolute tool directories/);
});

test('version comparison follows SemVer, including numeric fork suffixes and prerelease ordering', () => {
  assert.equal(nextForkVersion(A), B);
  assert.equal(compareVersions(A, B), -1);
  assert.equal(compareVersions('2.8.0', B), 1);
  assert.equal(compareVersions('2.8.0-alpha.1', '2.8.0-alpha.dev'), -1);
  assert.equal(compareVersions('2.8.0-alpha', '2.8.0-alpha.1'), -1);
  assert.equal(compareVersions('2.8.0+left', '2.8.0+right'), 0);
  for (const invalid of ['2.08.0', '2.8', '2.8.0-zeenha.01', '2.8.0\n']) {
    assert.throws(() => compareVersions(A, invalid), /SemVer/);
  }
  assert.throws(() => nextForkVersion('2.8.0-beta.1'), /requires.*zeenha/);
});

test('artifact selector requires one nonempty executable AppImage in a canonical dist', linux, (t) => {
  const source = temp(t);
  const dist = directory(join(source, 'dist'));
  file(join(dist, 'wrong.zip'), 'not an AppImage', 0o700);
  assert.throws(() => selectAppImage(dist, source), /exactly one AppImage/);
  const image = file(join(dist, 'test.AppImage'), '', 0o700);
  assert.throws(() => selectAppImage(dist, source), /canonical file/);
  writeFileSync(image, 'image');
  chmodSync(image, 0o600);
  assert.throws(() => selectAppImage(dist, source), { code: 'EACCES' });
  chmodSync(image, 0o700);
  assert.equal(selectAppImage(dist, source), image);
  const duplicate = file(join(dist, 'other.AppImage'));
  assert.throws(() => selectAppImage(dist, source), /exactly one AppImage/);
  rmSync(duplicate);
  const outside = file(join(source, 'outside'), 'outside dist', 0o700);
  rmSync(image);
  symlinkSync(outside, image);
  assert.throws(() => selectAppImage(dist, source), /canonical file/);
  const linkedDist = join(source, 'linked-dist');
  symlinkSync(dist, linkedDist);
  assert.throws(() => selectAppImage(linkedDist, source), /canonical directory/);
});

// The only files "built" or "installed" by the stubs are inert fixtures in temp().
function rehearsal(t, { candidateVersion = B, wrongArtifact = false, changeProbe } = {}) {
  const parent = temp(t);
  const source = directory(join(parent, 'caller-checkout'));
  const installer = file(join(source, 'scripts', 'zeenha-release.sh'));
  file(join(source, 'apps', 'desktop', 'scripts', 'smoke-desktop-runtime.mjs'));
  const override = directory(join(parent, 'protected-install'));
  const sentinel = file(join(override, 'aperant'));
  const work = createOwnedDirectory(parent, 'work-', [source, override]);
  const manifest = (tree) => join(tree, 'apps', 'desktop', 'package.json');
  const version = (tree) => JSON.parse(readFileSync(manifest(tree), 'utf8')).version;
  const events = [];
  const records = [];
  const builds = [];
  const launches = [];
  let fixture;
  const response = { output: { stdout: 0, stderr: 0 } };

  async function command(exe, args, { cwd, env }) {
    assert.notEqual(env.HOME, inherited.HOME);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    if (exe !== '/bin/bash') assert.equal(env.APERANT_INSTALL_DIR, undefined);
    if (exe === 'git' && args[0] === 'rev-parse') {
      assert.equal(cwd, source);
      assert.deepEqual(args.slice(0, 3), ['rev-parse', '--verify', '--end-of-options']);
      assert.match(args[3], /^(baseline|candidate)\^\{commit\}$/);
      return { text: args[3].startsWith('baseline') ? COMMIT_A : COMMIT_B };
    }
    if (exe === 'git' && args[0] === 'archive') {
      assert.equal(cwd, source);
      assert.equal(args[1], '--format=tar');
      file(args[2].slice('--output='.length), args[3]);
    } else if (exe === 'tar') {
      const commit = readFileSync(args[1], 'utf8');
      assert.ok([COMMIT_A, COMMIT_B].includes(commit));
      file(manifest(cwd), JSON.stringify({ version: commit === COMMIT_A ? A : candidateVersion }));
    } else if (exe === 'npm' && args[0] === 'ci') {
      events.push(`ci:${basename(cwd)}`);
      builds.push({ cwd, installedVersion: version(cwd), cache: env.npm_config_cache, electronCache: env.ELECTRON_CACHE });
      file(join(cwd, 'node_modules', '.bin', 'electron-builder'));
    } else if (exe === 'npm' && args[0] === 'run') {
      assert.deepEqual(args, ['run', 'build']);
      events.push(`build:${basename(cwd)}`);
    } else if (basename(exe) === 'electron-builder') {
      const tree = dirname(dirname(cwd));
      assert.equal(exe, join(tree, 'node_modules', '.bin', 'electron-builder'));
      assert.deepEqual(args, ['--linux', 'AppImage', '--x64', '--publish', 'never', '--config.directories.output=dist']);
      const slot = basename(tree).at(-1);
      events.push(`package:${slot}`);
      file(join(cwd, 'dist', `${slot}.${wrongArtifact && slot === 'B' ? 'zip' : 'AppImage'}`), version(tree), 0o700);
    } else if (exe === 'npm' && args[0] === 'install') {
      assert.equal(cwd, join(work.path, 'probe'));
      assert.ok(args.includes('--ignore-scripts'));
      directory(join(cwd, 'node_modules', 'playwright'));
      directory(join(cwd, 'node_modules', '@electron', 'asar'));
    } else if (exe === '/bin/bash') {
      assert.equal(args[0], join(work.path, 'installer', basename(installer)));
      const live = join(work.path, 'installation', 'live');
      const previous = `${live}.previous`;
      assert.equal(env.APERANT_INSTALL_DIR, live);
      assert.equal(cwd, join(work.path, 'tool-state', 'cwd'));
      if (args[1] === '--install') {
        assert.equal(args.length, 3);
        events.push(`install:${basename(args[2])}`);
        if (existsSync(live)) renameSync(live, previous);
        file(join(live, 'aperant'), readFileSync(args[2], 'utf8'), 0o700);
      } else {
        assert.deepEqual(args.slice(1), ['--rollback']);
        events.push('rollback');
        renameSync(live, `${live}.swap`);
        renameSync(previous, live);
        renameSync(`${live}.swap`, previous);
      }
    } else {
      assert.fail(`Unexpected command: ${exe} ${args.join(' ')}`);
    }
    return response;
  }

  const loadProbe = async (path) => {
    assert.equal(path, join(work.path, 'probe', 'probe.mjs'));
    return {
      createSmokeFixture({ workRoot, disposableRunner }) {
        assert.equal(workRoot, work.path);
        assert.equal(disposableRunner, true);
        events.push('create-fixture');
        fixture = { path: directory(join(workRoot, 'fixture')), head: COMMIT_A, line: 'committed fixture marker' };
        return fixture;
      },
      async probePackagedRuntime(options) {
        const { expected, fixtureState, userData, artifactRoot, executablePath, mode, baseline } = options;
        launches.push(options);
        events.push(`probe:${expected.version}`);
        assert.equal(fixtureState, fixture);
        assert.equal(artifactRoot, join(work.path, 'installation', 'live'));
        assert.equal(executablePath, join(artifactRoot, 'aperant'));
        assert.equal(basename(userData), 'profile');
        const db = join(userData, 'memory.db');
        if (mode === 'baseline') {
          assert.equal(baseline, undefined);
          assert.equal(existsSync(db), false);
          file(db, 'memory saved by baseline');
        } else {
          assert.equal(readFileSync(db, 'utf8'), 'memory saved by baseline');
        }
        const observed = readFileSync(executablePath, 'utf8');
        const result = {
          platform: 'linux', arch: 'x64', version: observed,
          evidence: { version: observed, userData, project: { id: 'fixture-id', path: fixture.path, settings: { mainBranch: 'smoke-target' } } },
          diagnostics: { startup: 'passed', cleanup: 'closed', checks: {
            'fixture-before': 'passed', 'profile-before': 'passed', 'ipc-version': 'passed', project: 'passed',
            pty: 'passed', libsql: 'passed', 'fixture-after': 'passed',
          } },
        };
        await changeProbe?.(options, result);
        events.push(`closed:${observed}`);
        return result;
      },
    };
  };
  return {
    run: (candidateRef) => rehearseLinux({ work, source, baselineRef: 'baseline', candidateRef, inherited: {
      ...inherited, APERANT_INSTALL_DIR: override,
    }, command, loadProbe, emit: (record) => records.push(record) }).finally(() => {
      work.remove();
      assert.equal(readFileSync(sentinel, 'utf8'), 'synthetic test data');
    }),
    builds, events, launches, records,
  };
}

for (const candidateRef of [undefined, 'candidate']) {
  test(`build and rehearse A → B → A (${candidateRef ? 'two refs' : 'generated version bump'})`, linux, async (t) => {
    const { run, builds, events, launches, records } = rehearsal(t);
    await run(candidateRef);
    assert.deepEqual(events, [
      'ci:source-A', 'build:source-A', 'package:A', 'ci:source-B', 'build:source-B', 'package:B',
      'create-fixture', 'install:A.AppImage', `probe:${A}`, `closed:${A}`,
      'install:B.AppImage', `probe:${B}`, `closed:${B}`, 'rollback', `probe:${A}`, `closed:${A}`,
    ]);
    assert.deepEqual(builds.map((entry) => entry.installedVersion), [A, candidateRef ? B : A]);
    for (const key of ['cwd', 'cache', 'electronCache']) assert.notEqual(builds[0][key], builds[1][key]);
    assert.deepEqual(launches.map(({ mode }) => mode), ['baseline', 'resume', 'resume']);
    assert.deepEqual(launches.map(({ userData }) => userData), Array(3).fill(launches[0].userData));
    assert.equal(launches[1].baseline, launches[2].baseline);
    assert.equal(launches[1].baseline.version, A);
    const artifacts = records.filter(({ stage }) => stage.endsWith(':artifact'));
    assert.deepEqual(artifacts.map(({ commit, version }) => [commit, version]), [[COMMIT_A, A], [candidateRef ? COMMIT_B : COMMIT_A, B]]);
    assert.notEqual(artifacts[0].artifact.sha256, artifacts[1].artifact.sha256);
  });
}

test('rejects a lower candidate version before installing dependencies', linux, async (t) => {
  const { run, events, records } = rehearsal(t, { candidateVersion: '2.8.0-beta.1.zeenha.8' });
  await assert.rejects(run('candidate'), /version must be higher/);
  assert.equal(records.at(-1).stage, 'version-order');
  assert.deepEqual(events, []);
});

test('rejects a build that supplies the wrong package format before invoking the installer', linux, async (t) => {
  const { run, events, records } = rehearsal(t, { wrongArtifact: true });
  await assert.rejects(run(), /exactly one AppImage/);
  assert.equal(records.at(-1).stage, 'B:artifact');
  assert.equal(events.at(-1), 'package:B');
});

for (const [name, changeProbe, message] of [
  ['wrong IPC version', (_, result) => { result.evidence.version = B; }, /IPC version differs/],
  ['wrong architecture', (_, result) => { result.arch = 'arm64'; }, /architecture or IPC version differs/],
  ['changed fixture state', (_, result) => { result.diagnostics.checks['fixture-after'] = 'failed'; }, /proof or clean shutdown is incomplete/],
  ['missing libSQL query proof', (_, result) => { delete result.diagnostics.checks.libsql; }, /proof or clean shutdown is incomplete/],
  ['failed launch', () => { throw new Error('synthetic private launch error'); }, /synthetic private launch error/],
  ['unconfirmed shutdown', (_, result) => { result.diagnostics.cleanup = 'unconfirmed'; }, { cleanupUnconfirmed: true }],
]) {
  test(`stops after baseline runtime failure: ${name}`, linux, async (t) => {
    const { run, events, records, launches } = rehearsal(t, { changeProbe });
    await assert.rejects(run(), message);
    assert.equal(launches.length, 1);
    assert.deepEqual(events.filter((event) => event.startsWith('install:')), ['install:A.AppImage']);
    assert.equal(events.includes('rollback'), false);
    assert.equal(records.at(-1).stage, 'A:runtime');
    assert.equal(records.at(-1).status, 'failed');
    assert.doesNotMatch(JSON.stringify(records), /synthetic private launch error/);
  });
}

test('does not roll back after resume returns different persisted fixture settings', linux, async (t) => {
  const { run, events, records, launches } = rehearsal(t, {
    changeProbe: ({ mode }, result) => {
      if (mode === 'resume') result.evidence.project.settings.mainBranch = 'main';
    },
  });
  await assert.rejects(run(), /Persisted project identity or settings changed/);
  assert.equal(launches.length, 2);
  assert.equal(events.includes('rollback'), false);
  assert.equal(records.at(-1).stage, 'B:runtime');
});

const terminalInput = "printf '\\n'; cat smoke-marker.txt\r";
const markerLine = 'aperant-smoke-test-nonce';
for (const provesOutput of [true, false]) {
  test(`terminal proof ${provesOutput ? 'accepts split ANSI/CRLF output' : 'rejects an echoed command'}`, async (t) => {
    const events = [];
    let output;
    t.mock.method(globalThis, 'setTimeout', (fn) => setImmediate(fn));
    t.mock.method(globalThis, 'clearTimeout', clearImmediate);
    const electronAPI = {
      onTerminalOutput(listener) {
        events.push('subscribe');
        output = listener;
        return () => events.push('unsubscribe');
      },
      async createTerminal({ id, cwd, skipOAuthToken }) {
        events.push('create');
        assert.equal(id, 'fixture-terminal');
        assert.equal(cwd, 'fixture');
        assert.equal(skipOAuthToken, true);
        // The marker emitted before sending the command is not evidence either.
        output(id, `${markerLine}\r\n`);
        return { success: true };
      },
      sendTerminalInput(id, input) {
        events.push('send');
        assert.equal(input, terminalInput);
        output(id, `${input}\n`);
        output('unrelated-terminal', `${markerLine}\r\n`);
        if (provesOutput) {
          output(id, '\x1b[');
          output(id, `32m${markerLine.slice(0, 8)}`);
          output(id, `${markerLine.slice(8)}\x1b[0m\r`);
          output(id, '\n');
        }
      },
      async destroyTerminal(id) {
        events.push('destroy');
        assert.equal(id, 'fixture-terminal');
        return { success: true };
      },
    };
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI } });
    try {
      assert.equal(await exerciseSmokeTerminal({ id: 'fixture-terminal', cwd: 'fixture', input: terminalInput,
        line: markerLine, timeout: 10_000 }), provesOutput ? 'passed' : 'missing-output');
      assert.deepEqual(events, ['subscribe', 'create', 'send', 'unsubscribe', 'destroy']);
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else delete globalThis.window;
    }
  });
}

test('command deadline only signals the owned group, bounds output and reaps it after escalation', linux, async (t) => {
  const pid = 1234; // No real child or signal is used.
  const child = Object.assign(new EventEmitter(), { pid, stdout: new PassThrough(), stderr: new PassThrough() });
  const unref = t.mock.method(Object.assign(child, { unref() { /* replaced by the mock */ } }), 'unref');
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    child.stdout.write(Buffer.alloc(1_000_001));
    child.stderr.write('synthetic');
    return child;
  });
  syncBuiltinESMExports();
  const signals = [];
  let exited = false;
  t.mock.method(process, 'kill', (target, signal) => {
    assert.equal(target, -pid);
    if (signal !== 0) signals.push(signal);
    if (signal === 'SIGKILL') {
      exited = true;
      queueMicrotask(() => child.emit('close', null));
    }
    if (signal === 0 && exited) throw Object.assign(new Error('No such group'), { code: 'ESRCH' });
    // The fake process ignores TERM so the bounded grace period must expire.
  });
  try {
    await assert.rejects(runSmokeCommand('synthetic-command', [], { env: {}, timeout: 10 }), {
      message: 'Command deadline expired', output: { stdout: 1_000_000, stderr: 9 }, cleanupUnconfirmed: false,
    });
    assert.equal(spawn.mock.calls[0].arguments[2].detached, true);
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(unref.mock.callCount(), 1);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
  }
});

// Real probe worker and real Playwright launcher, but an inert /bin/sh "app": Electron never starts.
async function probeDependencies() {
  try {
    const [{ createPackage }] = await Promise.all([import('@electron/asar'), import('playwright')]);
    return createPackage;
  } catch {
    return null;
  }
}

async function fakeArtifact(t, script) {
  const createPackage = await probeDependencies();
  if (!createPackage) {
    t.skip('playwright or @electron/asar cannot be resolved');
    return null;
  }
  const workRoot = temp(t);
  const pidFile = join(workRoot, 'fake.pid');
  const artifactRoot = directory(join(workRoot, 'artifact'));
  const executablePath = file(join(artifactRoot, 'aperant'), `#!/bin/sh\necho $$ > '${pidFile}'\n${script}\n`, 0o700);
  const source = directory(join(workRoot, 'asar-source'));
  file(join(source, 'package.json'), JSON.stringify({ name: 'aperant-smoke-fake', version: '0.0.0-smoke', main: 'main.js' }));
  file(join(source, 'main.js'), '// Never executed: the fake executable does not load it.\n');
  await createPackage(source, join(directory(join(artifactRoot, 'resources')), 'app.asar'));
  const userData = directory(join(workRoot, 'profile'));
  const fixtureState = await createSmokeFixture({ disposableRunner: true, workRoot });
  const previousDisplay = process.env.DISPLAY;
  process.env.DISPLAY = ':aperant-smoke-unused'; // Required by the probe; nothing connects to it.
  t.after(() => {
    if (previousDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = previousDisplay;
  });
  return {
    pidFile,
    options: {
      disposableRunner: true, workRoot, artifactRoot, executablePath, userData, fixtureState, mode: 'baseline',
      expected: { platform: platform(), arch: arch(), version: '0.0.0-smoke' },
    },
  };
}

async function assertFakeGroupGone(pidFile) {
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(Number.isInteger(pid) && pid > 1, 'fake executable recorded its PID');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await delay(50);
  }
  assert.fail('fake executable process group is still running');
}

const SANDBOX_FAILURE = "echo 'FATAL:setuid_sandbox_host.cc The SUID sandbox helper binary was found, but is not configured correctly.' >&2\nexit 1";

test('real probe reports an immediate packaged launch failure as a sanitized launch stage', linux, async (t) => {
  const fake = await fakeArtifact(t, SANDBOX_FAILURE);
  if (!fake) return;
  const error = await probePackagedRuntime(fake.options).then(
    () => assert.fail('a failed launch must never pass'),
    (error) => error,
  );
  assert.equal(error.stage, 'launch');
  assert.equal(error.message, 'launch: Electron could not start with its sandbox enabled');
  // Playwright returned no child handle, so the probe cannot independently confirm
  // tree exit and stays fail-closed; the stage diagnosis is what must survive.
  assert.equal(error.diagnostics?.cleanup, 'unconfirmed');
  assert.equal(error.diagnostics?.startup, 'pending');
  assert.ok(!JSON.stringify(error.diagnostics).includes(fake.options.workRoot), 'diagnostics must not contain paths');
  await assertFakeGroupGone(fake.pidFile);
});

test('real probe never passes when interrupted, before or during launch', linux, async (t) => {
  const fake = await fakeArtifact(t, `sleep 1\n${SANDBOX_FAILURE}`);
  if (!fake) return;
  const before = new AbortController();
  before.abort();
  await assert.rejects(probePackagedRuntime({ ...fake.options, signal: before.signal }), /Interrupted/);
  assert.equal(existsSync(fake.pidFile), false, 'a pre-aborted probe must not launch anything');

  const during = new AbortController();
  const probe = probePackagedRuntime({ ...fake.options, signal: during.signal });
  for (let attempt = 0; attempt < 200 && !existsSync(fake.pidFile); attempt += 1) await delay(25);
  assert.ok(existsSync(fake.pidFile), 'fake executable was launched');
  during.abort();
  const error = await probe.then(() => assert.fail('an interrupted probe must never pass'), (error) => error);
  assert.ok(typeof error.stage === 'string' && error.stage.length > 0);
  assert.notEqual(error.diagnostics?.startup, 'passed');
  await assertFakeGroupGone(fake.pidFile);
});
