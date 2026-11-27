#!/usr/bin/env node
// zeenha fork: release-path actions must be immutable (spec 178 / OWASP A08).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { argv, stdout } = process;

// Release workflows and the local composite actions they call.
export const DEFAULT_FILES = [
  '.github/workflows/release.yml',
  '.github/workflows/beta-release.yml',
  '.github/actions/setup-node-frontend/action.yml',
  '.github/actions/submit-macos-notarization/action.yml',
  '.github/actions/finalize-macos-notarization/action.yml',
  '.github/actions/merge-macos-manifests/action.yml',
];

const USES_LINE = /^\s*(?:-\s+)?uses:\s*(.*)$/;
const COMMIT_PIN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?@[0-9a-f]{40}$/;
const DOCKER_PIN = /^docker:\/\/[^@\s]+@sha256:[0-9a-fA-F]{64}$/;
const VERSION_COMMENT = /#\s*v?\d/;

function parseUsesValue(value) {
  const quoted = /^(['"])(.*?)\1(?:\s+(#.*))?$/.exec(value);
  if (quoted) {
    return { ref: quoted[2], comment: quoted[3] ?? '' };
  }

  const commentStart = value.search(/(?:^|\s)#/);
  if (commentStart === -1) {
    return { ref: value, comment: '' };
  }
  return { ref: value.slice(0, commentStart).trimEnd(), comment: value.slice(commentStart) };
}

function pinIssue(ref, comment) {
  if (ref.startsWith('./')) {
    return null;
  }
  if (ref.startsWith('docker://')) {
    return DOCKER_PIN.test(ref) ? null : 'not pinned to a full SHA-256 image digest';
  }
  if (!COMMIT_PIN.test(ref)) {
    return 'not pinned to a full 40-character commit SHA';
  }
  return VERSION_COMMENT.test(comment) ? null : 'missing version comment';
}

/** Check single-line block-style `uses:` entries in a release workflow or action. */
export function findUnpinnedUses(text) {
  const findings = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const match = USES_LINE.exec(line);
    if (!match) continue;

    const { ref, comment } = parseUsesValue(match[1].trim());
    const reason = pinIssue(ref, comment);
    if (reason) findings.push({ line: index + 1, ref, reason });
  }
  return findings;
}

/** Check files relative to rootDir (absolute paths are also accepted). */
export function checkFiles(files, rootDir) {
  const findings = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(resolve(rootDir, file), 'utf8');
    } catch (err) {
      const reason = err.code === 'ENOENT' ? 'file not found' : `could not read file (${err.code})`;
      findings.push({ file, line: 1, ref: '(file)', reason });
      continue;
    }
    findings.push(...findUnpinnedUses(text).map((finding) => ({ file, ...finding })));
  }
  return findings;
}

function main() {
  const files = argv.length > 2 ? argv.slice(2) : DEFAULT_FILES;
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const findings = checkFiles(files, repoRoot);

  if (findings.length === 0) {
    stdout.write(`OK: release action pins checked in ${files.length} file(s)\n`);
    return 0;
  }

  for (const { file, line, ref, reason } of findings) {
    stdout.write(`${file}:${line}: ${ref} - ${reason}\n`);
    const annotationFile = file
      .replaceAll('%', '%25')
      .replaceAll('\r', '%0D')
      .replaceAll('\n', '%0A')
      .replaceAll(':', '%3A')
      .replaceAll(',', '%2C');
    stdout.write(`::error file=${annotationFile},line=${line}::${reason}\n`);
  }
  return 1;
}

// Only run the CLI when invoked directly, not when imported by tests.
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  process.exitCode = main();
}
