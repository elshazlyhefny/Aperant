/**
 * zeenha fork: Exercise the Windows release signing gate without credentials or publishing.
 * Run with: node --test scripts/release-signing-gate.test.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  REQUIRED_SIGNING_SETTINGS,
  checkSigningConfig,
  verifyWindowsAttestation,
} from './release-signing-gate.mjs';

const settings = [
  'AZURE_CLIENT_ID',
  'AZURE_TENANT_ID',
  'AZURE_SUBSCRIPTION_ID',
  'AZURE_SIGNING_ACCOUNT',
  'AZURE_CERTIFICATE_PROFILE',
  'WINDOWS_SIGNING_PUBLISHER',
];
const configuredEnv = Object.fromEntries(settings.map((name, i) => [name, `fixture-setting-${i}`]));
const script = fileURLToPath(new URL('./release-signing-gate.mjs', import.meta.url));

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'release-signing-gate-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });
}

// Preflight

test('official preflight lists every missing setting when all are empty', () => {
  assert.deepEqual(REQUIRED_SIGNING_SETTINGS, settings);
  const env = Object.fromEntries(settings.map((name) => [name, '']));
  const result = checkSigningConfig(env, { official: true });
  assert.equal(result.ok, false);
  assert.equal(result.configured, false);
  assert.deepEqual(result.missing, settings);
  for (const name of settings) assert.ok(result.messages.join('\n').includes(name));
});

test('official preflight names only the missing setting and never logs values', () => {
  const env = { ...configuredEnv };
  delete env.AZURE_CERTIFICATE_PROFILE;
  const result = checkSigningConfig(env, { official: true });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['AZURE_CERTIFICATE_PROFILE']);
  const message = result.messages.join('\n');
  assert.match(message, /AZURE_CERTIFICATE_PROFILE/);
  for (const [name, value] of Object.entries(env)) {
    assert.ok(!message.includes(name));
    assert.ok(!message.includes(value));
  }
});

test('whitespace-only values count as missing', () => {
  const env = { ...configuredEnv, AZURE_CLIENT_ID: ' \t\n ' };
  const result = checkSigningConfig(env, { official: true });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['AZURE_CLIENT_ID']);
});

test('configured official preflight passes', () => {
  assert.deepEqual(checkSigningConfig(configuredEnv, { official: true }), {
    ok: true, configured: true, missing: [], messages: [],
  });
});

test('unconfigured build-only preflight passes with an unsigned warning', () => {
  const result = checkSigningConfig({}, { official: false });
  assert.equal(result.ok, true);
  assert.equal(result.configured, false);
  assert.deepEqual(result.missing, settings);
  assert.match(result.messages.join('\n'), /unsigned and cannot be published/);
});

// Attestation

function windowsFixture(t) {
  const dir = tempDir(t);
  const assetsDir = join(dir, 'assets');
  const attestationPath = join(dir, 'windows-signature-attestation.json');
  const expectedPublisher = 'Example Publisher';
  const name = 'installer-x64.exe';
  const contents = 'x64 installer bytes';
  const attestation = { schemaVersion: 1, signed: true, expectedPublisher, files: [] };
  mkdirSync(assetsDir);

  const addInstaller = (name, bytes) => {
    writeFileSync(join(assetsDir, name), bytes);
    attestation.files.push({
      name,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      status: 'Valid',
      timestamped: true,
    });
  };
  const save = () => writeFileSync(attestationPath, JSON.stringify(attestation));
  addInstaller(name, contents);
  save();

  return {
    dir, assetsDir, attestationPath, expectedPublisher, name, attestation, addInstaller, save,
    verify: (options = {}) => verifyWindowsAttestation({
      assetsDir, attestationPath, expectedPublisher, requireSigned: true, ...options,
    }),
  };
}

function assertRejected(result, message) {
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), message);
}

test('valid signed attestation matches every top-level installer', async (t) => {
  const fixture = windowsFixture(t);
  fixture.addInstaller('installer-arm64.EXE', 'arm64 installer bytes');
  writeFileSync(join(fixture.assetsDir, 'latest.yml'), 'path: installer-x64.exe');
  mkdirSync(join(fixture.assetsDir, 'nested'));
  writeFileSync(join(fixture.assetsDir, 'nested', 'unpacked.exe'), 'not a release asset');
  fixture.save();

  const result = await fixture.verify();
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.match(result.summary, /Matched 2 Windows installer/);
});

test('an installer not listed in the attestation fails the gate', async (t) => {
  const fixture = windowsFixture(t);
  writeFileSync(join(fixture.assetsDir, 'unlisted.exe'), 'extra installer');
  assertRejected(await fixture.verify(), /"unlisted\.exe" is not listed/);
});

test('changing one byte in an attested installer fails even for build-only artifacts', async (t) => {
  const fixture = windowsFixture(t);
  const installer = join(fixture.assetsDir, fixture.name);
  const bytes = readFileSync(installer);
  bytes[0] ^= 1;
  writeFileSync(installer, bytes);
  for (const requireSigned of [true, false]) {
    assertRejected(await fixture.verify({ requireSigned }), /SHA-256 mismatch/);
  }
});

test('unsigned attestations pass only when signing is not required', async (t) => {
  const fixture = windowsFixture(t);
  fixture.attestation.signed = false;
  delete fixture.attestation.expectedPublisher;
  delete fixture.attestation.files[0].status;
  delete fixture.attestation.files[0].timestamped;
  fixture.save();

  assertRejected(await fixture.verify(), /does not attest to signed installers/);
  const result = await fixture.verify({ requireSigned: false, expectedPublisher: '' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.match(result.summary, /UNSIGNED build-only artifact, not publishable/);
});

test('signed releases require a configured publisher matching the attestation', async (t) => {
  const fixture = windowsFixture(t);
  assertRejected(await fixture.verify({ expectedPublisher: ' \t' }), /WINDOWS_SIGNING_PUBLISHER is required/);
  assertRejected(await fixture.verify({ expectedPublisher: 'Other Publisher' }), /publisher does not match/);
});

for (const status of ['HashMismatch', 'UnknownError']) {
  test(`signed releases reject Authenticode status ${status}`, async (t) => {
    const fixture = windowsFixture(t);
    fixture.addInstaller('second.exe', 'installer bytes');
    fixture.attestation.files[1].status = status;
    fixture.save();
    assertRejected(await fixture.verify(), /"second\.exe" does not have a Valid Authenticode signature/);
  });
}

test('signed releases reject a missing signature timestamp', async (t) => {
  const fixture = windowsFixture(t);
  fixture.attestation.files[0].timestamped = false;
  fixture.save();
  assertRejected(await fixture.verify(), /missing a signature timestamp/);
});

test('an empty installer set fails even if the attestation also lists no installers', async (t) => {
  const fixture = windowsFixture(t);
  rmSync(join(fixture.assetsDir, fixture.name));
  fixture.attestation.files = [];
  fixture.save();
  assertRejected(await fixture.verify(), /No Windows installers/);
});

test('a missing attestation fails', async (t) => {
  const fixture = windowsFixture(t);
  rmSync(fixture.attestationPath);
  assertRejected(await fixture.verify(), /attestation file is missing/);
});

test('invalid JSON or a malformed attestation fails even when signing is optional', async (t) => {
  const fixture = windowsFixture(t);
  const cases = [
    ['{', /not valid JSON/],
    [JSON.stringify({ ...fixture.attestation, schemaVersion: 2 }), /schemaVersion 1/],
    [JSON.stringify({ ...fixture.attestation, files: null }), /Malformed Windows signature attestation/],
  ];
  for (const [data, error] of cases) {
    writeFileSync(fixture.attestationPath, data);
    assertRejected(await fixture.verify({ requireSigned: false }), error);
  }
});

test('an attested installer missing from the assets fails even when another installer exists', async (t) => {
  const fixture = windowsFixture(t);
  fixture.addInstaller('missing.exe', 'installer bytes');
  fixture.save();
  rmSync(join(fixture.assetsDir, 'missing.exe'));
  assertRejected(await fixture.verify(), /"missing\.exe" is missing from the release assets/);
});

// CLI and GitHub Actions outputs

test('official preflight CLI with an empty environment exits 1 and annotates the error', () => {
  const result = runCli(['preflight', '--official', 'true']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /^::error::Missing Windows signing settings:/);
});

test('build-only preflight appends the signing_configured output', (t) => {
  const output = join(tempDir(t), 'outputs');
  writeFileSync(output, 'existing=value\n');
  const result = runCli(['preflight', '--official', 'false'], { GITHUB_OUTPUT: output });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^::warning::.*unsigned and cannot be published/);
  assert.equal(readFileSync(output, 'utf8'), 'existing=value\nsigning_configured=false\n');
});

test('attestation CLI reports unsigned builds but blocks them when signing is required', (t) => {
  const fixture = windowsFixture(t);
  fixture.attestation.signed = false;
  fixture.save();
  const args = ['verify-attestation', '--assets', fixture.assetsDir, '--attestation', fixture.attestationPath];
  const summary = join(fixture.dir, 'summary.md');
  const env = { WINDOWS_SIGNING_PUBLISHER: fixture.expectedPublisher, GITHUB_STEP_SUMMARY: summary };

  const buildOnly = runCli(args, env);
  assert.equal(buildOnly.status, 0, buildOnly.stdout + buildOnly.stderr);
  assert.match(readFileSync(summary, 'utf8'), /### Windows signing gate[\s\S]*UNSIGNED build-only artifact/);

  const official = runCli([...args, '--require-signed'], env);
  assert.equal(official.status, 1, official.stderr);
  assert.match(official.stdout, /^::error::.*does not attest to signed installers/);
  assert.match(readFileSync(summary, 'utf8'), /Windows installer attestation check failed/);
});

// Workflow structure: lint.yml runs without installing a YAML library.

function readWorkflow(name) {
  const text = readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n');
  const [, ...sections] = text.split(/^  ([a-z0-9-]+):$/m);
  const jobs = new Map();
  for (let i = 0; i < sections.length; i += 2) jobs.set(sections[i], sections[i + 1]);
  return { text, jobs };
}

for (const [workflow, publishStep] of [['release', 'Create Release'], ['beta-release', 'Create Beta Release']]) {
  test(`${workflow} checks the Windows signing attestation before publishing`, () => {
    const { text, jobs } = readWorkflow(workflow);
    assert.ok(jobs.has('signing-preflight'), 'missing signing-preflight job');
    assert.doesNotMatch(text, /^\s*- name: Skip signing notice\s*$/m);
    assert.doesNotMatch(text, /^[ \t]+if:[^\n]*\benv\.AZURE_CLIENT_ID\b/m);

    const build = jobs.get('build-windows');
    assert.ok(build, 'missing build-windows job');
    assert.match(build, /^        run: [^\n]*verify-windows-signatures\.ps1\b/m);
    const upload = build.split(/^      - /m).find((step) =>
      /^        uses: actions\/upload-artifact@/m.test(step) && /^          name: windows-builds$/m.test(step));
    assert.ok(upload, 'missing windows-builds upload');
    assert.match(upload, /^          path: \|\n(?: {12}[^\n]*\n)* {12}apps\/desktop\/dist\/windows-signature-attestation\.json$/m);

    const release = jobs.get('create-release');
    assert.ok(release, 'missing create-release job');
    const steps = release.split(/^      - /m);
    const verifyIndex = steps.findIndex((step) => step.startsWith('name: Verify Windows installers are signed\n'));
    const publishIndex = steps.findIndex((step) => step.startsWith(`name: ${publishStep}\n`));
    assert.ok(verifyIndex >= 0 && publishIndex > verifyIndex, 'verification must precede publishing');
    const verify = steps[verifyIndex];
    assert.match(verify, /release-signing-gate\.mjs verify-attestation\b/);
    assert.doesNotMatch(verify, /^        if:/m, 'verification must not be skipped');
    if (workflow === 'beta-release') {
      assert.match(verify, /^          --attestation [^\n]+\.json --require-signed$/m);
      assert.doesNotMatch(verify, /^        continue-on-error:/m);
    } else {
      assert.match(verify, /\$\{\{ github\.event_name == 'push' && '--require-signed' \|\| '' \}\}/);
      const continueOnError = verify.match(/^        continue-on-error: (.*)$/m);
      if (continueOnError) assert.equal(continueOnError[1], "${{ github.event_name == 'workflow_dispatch' }}");
    }
  });
}

test('beta tag creation depends on signing preflight', () => {
  const { jobs } = readWorkflow('beta-release');
  const tag = jobs.get('create-tag');
  assert.ok(tag, 'missing create-tag job');
  assert.match(tag, /^    needs: \[(?:[a-z0-9-]+, *)*signing-preflight(?:, *[a-z0-9-]+)*\]$/m);
});
