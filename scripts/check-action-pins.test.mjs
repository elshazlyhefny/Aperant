/**
 * Tests for check-action-pins.mjs
 * Run with: node --test scripts/check-action-pins.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_FILES, checkFiles, findUnpinnedUses } from './check-action-pins.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const sha = '0123456789abcdef'.repeat(2) + '01234567';
const pinnedRef = `actions/checkout@${sha}`;

test('accepts full commit SHAs with version comments, including action subpaths', () => {
  assert.deepEqual(findUnpinnedUses(`    uses: ${pinnedRef} # v4.4.0`), []);
  assert.deepEqual(findUnpinnedUses(`    uses: actions/example/sub/action@${sha} # 4.4.0`), []);
});

for (const [label, revision] of [
  ['a version tag', 'v4'],
  ['a branch', 'main'],
  ['a short SHA', sha.slice(0, 7)],
  ['an uppercase SHA', sha.toUpperCase()],
  ['a 39-character SHA', sha.slice(1)],
  ['an expression', '${{ inputs.action_ref }}'],
]) {
  test(`rejects ${label}`, () => {
    const ref = `actions/checkout@${revision}`;
    assert.deepEqual(findUnpinnedUses(`  uses: ${ref} # v4.4.0`), [
      { line: 1, ref, reason: 'not pinned to a full 40-character commit SHA' },
    ]);
  });
}

test('requires a version comment even when the commit is pinned', () => {
  for (const suffix of ['', ' # reviewed']) {
    assert.deepEqual(findUnpinnedUses(`uses: ${pinnedRef}${suffix}`), [
      { line: 1, ref: pinnedRef, reason: 'missing version comment' },
    ]);
  }
});

test('allows local actions without pins or comments', () => {
  assert.deepEqual(findUnpinnedUses('    - uses: ./.github/actions/x'), []);
});

test('parses quoted refs and list items, with comments outside the quotes', () => {
  assert.deepEqual(findUnpinnedUses(`  - uses: "${pinnedRef}" # v4.4.0`), []);
  assert.deepEqual(findUnpinnedUses(`  - uses: 'actions/checkout@v4' # v4.4.0`), [
    { line: 1, ref: 'actions/checkout@v4', reason: 'not pinned to a full 40-character commit SHA' },
  ]);
  assert.equal(findUnpinnedUses(`  - uses: "${pinnedRef} # v4.4.0"`).length, 1);
});

test('requires Docker images to have full SHA-256 digests instead of tags', () => {
  const digest = 'a'.repeat(64);
  assert.deepEqual(findUnpinnedUses(`  - uses: docker://img@sha256:${digest}`), []);
  for (const ref of ['docker://img:latest', `docker://img@sha256:${digest.slice(1)}`]) {
    assert.deepEqual(findUnpinnedUses(`  - uses: ${ref}`), [
      { line: 1, ref, reason: 'not pinned to a full SHA-256 image digest' },
    ]);
  }
});

test('reports 1-based line numbers and ignores commented-out entries', () => {
  const text = [
    '# uses: actions/checkout@v4',
    '',
    '    - uses: actions/checkout@v4',
    `    - uses: ${pinnedRef} # v4.4.0`,
    `    - uses: ${pinnedRef}`,
  ].join('\r\n');
  assert.deepEqual(findUnpinnedUses(text).map((finding) => finding.line), [3, 5]);
});

test('reports missing files instead of skipping them', () => {
  const file = 'scripts/nonexistent-check-action-pins-workflow.yml';
  assert.deepEqual(checkFiles([file], repoRoot), [
    { file, line: 1, ref: '(file)', reason: 'file not found' },
  ]);
});

test('all default release-path files pass the check', () => {
  assert.deepEqual(checkFiles(DEFAULT_FILES, repoRoot), []);
});
