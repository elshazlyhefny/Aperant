/**
 * zeenha fork: Exercise the documentation publisher without touching published files.
 * Run with: node --test scripts/update-integration-capabilities.test.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const sourcePath = 'guides/integration-capabilities.json';
const targets = ['README.md', 'guides/README.md'];
const start = '<!-- INTEGRATION_CAPABILITIES_START -->';
const end = '<!-- INTEGRATION_CAPABILITIES_END -->';
const rootPrefix = '# Project\n\n<!-- TOP_VERSION_BADGE -->\n[version-2.7.0-blue](https://example.com/tag/v2.7.0)\n<!-- TOP_VERSION_BADGE_END -->\n\n';
const rootSuffix = '\n\n<!-- STABLE_DOWNLOADS -->\nhttps://example.com/download/v2.7.0/Auto-Claude-2.7.0-win\n<!-- STABLE_DOWNLOADS_END -->';
const guidePrefix = '# Guides\n\n';
const guideSuffix = '\n\n## Other guides\n';
const rows = [
  {
    id: 'example-cloud', name: 'Example Cloud', editionSupported: true,
    prProviderId: 'example', sourceType: 'example_issues',
    aiReview: 'desktop', issueImport: 'desktop',
    outcomeComments: { desktop: 'comment', headless: 'note' },
    transition: { type: 'state', event: 'review_ready', surfaces: ['desktop'] },
    setupLinks: [{ label: 'Project setup', href: 'project-configuration.md#example' }],
  },
  {
    id: 'example-server', name: 'Example Server', editionSupported: false,
    aiReview: 'unsupported', issueImport: 'unsupported',
    outcomeComments: { desktop: 'unsupported', headless: 'unsupported' },
    setupLinks: [{ label: 'Edition limits', href: 'project-configuration.md#example' }],
  },
];

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'integration-capabilities-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'guides'));
  const script = join(root, 'scripts/update-integration-capabilities.mjs');
  copyFileSync(new URL('./update-integration-capabilities.mjs', import.meta.url), script);

  const write = (file, text) => writeFileSync(join(root, file), text, 'utf8');
  const read = (file) => readFileSync(join(root, file), 'utf8');
  write(sourcePath, JSON.stringify(rows));
  write(targets[0], `${rootPrefix}${start}\nplaceholder\n${end}${rootSuffix}`);
  write(targets[1], `${guidePrefix}${start}\r\nplaceholder\r\n${end}${guideSuffix}`.replace(/(?<!\r)\n/g, '\r\n'));

  return {
    read,
    write,
    snapshot: () => [sourcePath, ...targets].map(read),
    run(...args) {
      // The script must use its own location even when invoked from elsewhere.
      const result = spawnSync(process.execPath, [script, ...args], { cwd: join(root, 'guides'), encoding: 'utf8' });
      assert.ifError(result.error);
      return result;
    },
  };
}

function assertFailure(f, mode, diagnostic) {
  const before = f.snapshot();
  const result = f.run(mode);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, diagnostic);
  assert.match(result.stderr, /node scripts\/update-integration-capabilities\.mjs --write/);
  assert.deepEqual(f.snapshot(), before);
  return result.stderr;
}

function assertSuccess(f, mode) {
  const result = f.run(mode);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function splitBlock(text) {
  const bodyStart = text.indexOf(start) + start.length;
  const bodyEnd = text.indexOf(end);
  return [text.slice(0, bodyStart), text.slice(bodyStart, bodyEnd), text.slice(bodyEnd)];
}

test('refreshes both blocks with relative links and preserves their surroundings and line endings', (t) => {
  const f = fixture(t);
  const originals = targets.map(f.read).map(splitBlock);
  assertSuccess(f, '--write');
  const generated = targets.map(f.read).map(splitBlock);
  for (const [i, [prefix, body, suffix]] of generated.entries()) {
    assert.equal(prefix, originals[i][0]);
    assert.equal(suffix, originals[i][2]);
    assert.match(body, /\| Example Cloud \| Desktop \| Desktop \| Comment \| Note \| State — Desktop \|/);
    assert.match(body, /\| Example Server \| Unsupported \| Unsupported \| Unsupported \| Unsupported \| None \|/);
    assert.ok(body.indexOf('Example Cloud') < body.indexOf('Example Server'));
    assert.match(body, /\*\*Legend:\*\*/);
  }
  const rootBlock = generated[0][1];
  const guideBlock = generated[1][1];
  assert.match(rootBlock, /\[Project setup\]\(guides\/project-configuration\.md#example\)/);
  assert.match(guideBlock, /\[Project setup\]\(project-configuration\.md#example\)/);
  assert.doesNotMatch(guideBlock.replaceAll('\r\n', ''), /\n/);
  assert.equal(guideBlock.replaceAll('\r\n', '\n'), rootBlock.replaceAll('(guides/', '('));
  const after = f.snapshot();
  assertSuccess(f, '--check');
  assert.equal(assertSuccess(f, '--write'), '');
  assert.deepEqual(f.snapshot(), after);
});

for (const [index, target] of targets.entries()) {
  test(`check fails without writing on ${target}-only drift`, (t) => {
    const f = fixture(t);
    assertSuccess(f, '--write');
    f.write(target, f.read(target).replace('Example Cloud', 'Hand-edited Cloud'));
    const stderr = assertFailure(f, '--check', /generated capability block is out of date/);
    assert.ok(stderr.startsWith(`${target}:`));
    assert.ok(!stderr.split('\n').some((line) => line.startsWith(`${targets[1 - index]}:`)));
  });
}

test('check identifies both targets when only the source changes', (t) => {
  const f = fixture(t);
  assertSuccess(f, '--write');
  f.write(sourcePath, JSON.stringify([{ ...rows[0], name: 'Renamed Cloud' }, rows[1]]));
  const stderr = assertFailure(f, '--check', /^README\.md: generated capability block is out of date/m);
  assert.match(stderr, /^guides\/README\.md: generated capability block is out of date/m);
  assertSuccess(f, '--write');
  assertSuccess(f, '--check');
});

for (const [name, block] of [
  ['missing', start],
  ['duplicate start', `${start}\n${start}\n${end}`],
  ['duplicate end', `${start}\n${end}\n${end}`],
  ['reversed', `${end}\n${start}`],
]) {
  test(`rejects ${name} markers before updating either target`, (t) => {
    const f = fixture(t);
    f.write(targets[1], block);
    const stderr = assertFailure(f, '--check', /^guides\/README\.md: expected exactly one ordered pair/m);
    assert.match(stderr, /^README\.md: generated capability block is out of date/m);
    assertFailure(f, '--write', /^guides\/README\.md: expected exactly one ordered pair/m);
  });
}

for (const [name, mutate, reason] of [
  ['invalid JSON', () => '{', /JSON|property name/],
  ['missing name', ([row]) => { delete row.name; }, /name must be nonempty/],
  ['duplicate row ID', (data) => { data[1].id = data[0].id; }, /duplicate row id/],
  ['duplicate writer source type', (data) => { data.push({ ...data[0], id: 'another-cloud' }); }, /duplicate writer sourceType/],
  ['missing writer source type', ([row]) => { delete row.sourceType; }, /requires a valid sourceType/],
  ['invalid import scope', ([row]) => { row.issueImport = 'headless'; }, /issueImport must be desktop or unsupported/],
  ['invalid write-back scope', ([row]) => { row.outcomeComments.headless = 'desktop'; }, /outcomeComments\.headless/],
  ['positive capability on unsupported edition', ([row]) => { row.editionSupported = false; }, /unsupported editions/],
  ['transition without write-back on same surface', ([row]) => { row.outcomeComments.desktop = 'unsupported'; }, /transition requires write-back on desktop/],
  ['invalid transition surface', ([row]) => { row.transition.surfaces = ['web']; }, /transition\.surfaces/],
  ['external setup link', ([row]) => { row.setupLinks[0].href = 'https://example.com/setup.md'; }, /guide-relative Markdown href/],
]) {
  test(`rejects ${name} before rendering`, (t) => {
    const f = fixture(t);
    const data = structuredClone(rows);
    f.write(sourcePath, mutate(data) ?? JSON.stringify(data));
    for (const mode of ['--check', '--write']) {
      const stderr = assertFailure(f, mode, /^guides\/integration-capabilities\.json:/m);
      assert.match(stderr, reason);
    }
  });
}

test('requires an explicit mode and never writes on invalid invocation', (t) => {
  const f = fixture(t);
  const before = f.snapshot();
  for (const args of [[], ['--write', '--check']]) {
    const result = f.run(...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
    assert.deepEqual(f.snapshot(), before);
  }
});
