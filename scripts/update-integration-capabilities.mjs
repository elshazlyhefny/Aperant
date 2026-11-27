#!/usr/bin/env node
/**
 * zeenha fork: Publish both integration capability indexes from one checked source.
 * Usage: node scripts/update-integration-capabilities.mjs --write|--check
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { argv, stderr, stdout } from 'node:process';

const root = new URL('../', import.meta.url);
const sourcePath = 'guides/integration-capabilities.json';
const targets = ['README.md', 'guides/README.md'];
const startMarker = '<!-- INTEGRATION_CAPABILITIES_START -->';
const endMarker = '<!-- INTEGRATION_CAPABILITIES_END -->';
const regenerate = 'node scripts/update-integration-capabilities.mjs --write';

const unsupported = 'unsupported';
const surfaces = ['desktop', 'headless'];
const surfaceLabels = { desktop: 'Desktop', headless: 'Headless run/serve' };
const scopeLabels = { desktop: 'Desktop', unsupported: 'Unsupported' };
const commentLabels = { comment: 'Comment', note: 'Note', unsupported: 'Unsupported' };
const identifier = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const guideHref = /^(?:[\w-]+\/)*[\w-]+\.md(?:#[\w-]+)?$/;

function requireField(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value) {
  return typeof value === 'string' && value.trim().length > 0 && !/[\r\n]/.test(value);
}

function isIdentifier(value) {
  return typeof value === 'string' && identifier.test(value);
}

function validateCapabilities(rows) {
  requireField(Array.isArray(rows) && rows.length > 0, 'expected a nonempty array of capability rows');
  const ids = new Set();
  const sourceTypes = new Set();

  for (const [index, row] of rows.entries()) {
    requireField(isRecord(row) && isIdentifier(row.id), `row ${index + 1}: expected a valid id`);
    const check = (condition, message) => requireField(condition, `${row.id}: ${message}`);
    check(!ids.has(row.id), 'duplicate row id');
    ids.add(row.id);
    check(isText(row.name), 'name must be nonempty single-line text');
    check(typeof row.editionSupported === 'boolean', 'editionSupported must be a boolean');
    for (const field of ['aiReview', 'issueImport']) {
      check(typeof row[field] === 'string' && Object.hasOwn(scopeLabels, row[field]),
        `${field} must be desktop or unsupported`);
    }
    check(isRecord(row.outcomeComments), 'outcomeComments must be an object');
    for (const surface of surfaces) {
      const comment = row.outcomeComments[surface];
      check(typeof comment === 'string' && Object.hasOwn(commentLabels, comment),
        `outcomeComments.${surface} must be comment, note, or unsupported`);
    }

    const writesOutcomes = surfaces.some((surface) => row.outcomeComments[surface] !== unsupported);
    check(row.editionSupported || (row.aiReview === unsupported && row.issueImport === unsupported &&
      !writesOutcomes && row.transition === undefined), 'unsupported editions cannot have supported capabilities');
    if (row.aiReview !== unsupported || row.prProviderId !== undefined) {
      check(isIdentifier(row.prProviderId), 'PR review requires a valid prProviderId');
    }
    if (writesOutcomes) {
      check(isIdentifier(row.sourceType), 'outcome write-back requires a valid sourceType');
      check(!sourceTypes.has(row.sourceType), `duplicate writer sourceType: ${row.sourceType}`);
      sourceTypes.add(row.sourceType);
    } else {
      check(row.sourceType === undefined, 'sourceType requires outcome write-back');
    }

    if (row.transition !== undefined) {
      const move = row.transition;
      check(isRecord(move) && ['status', 'state'].includes(move.type) && move.event === 'review_ready',
        'transition must define a status or state move on review_ready');
      check(Array.isArray(move.surfaces) && move.surfaces.length > 0 &&
        new Set(move.surfaces).size === move.surfaces.length &&
        move.surfaces.every((surface) => surfaces.includes(surface)),
        'transition.surfaces must list unique desktop or headless surfaces');
      for (const surface of move.surfaces) {
        check(row.outcomeComments[surface] !== unsupported, `transition requires write-back on ${surface}`);
      }
    }

    check(Array.isArray(row.setupLinks) && row.setupLinks.length > 0, 'setupLinks must be a nonempty array');
    for (const link of row.setupLinks) {
      check(isRecord(link) && isText(link.label) && typeof link.href === 'string' && guideHref.test(link.href),
        'each setup link needs a label and a guide-relative Markdown href');
    }
  }
}

function markdownText(value) {
  return value.replace(/[\\|\[\]<>*_`~&]/g, '\\$&');
}

function renderTable(rows, target) {
  const guidePrefix = posix.relative(posix.dirname(target), 'guides');
  const lines = [
    '| Provider / edition | AI PR/MR review | Issue / work-item import | Desktop outcome write-back | Headless run/serve outcome write-back | Optional move on `review_ready` | Setup / limits |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    const move = row.transition;
    const transition = move
      ? `${move.type === 'status' ? 'Status' : 'State'} — ${surfaces.filter((surface) =>
        move.surfaces.includes(surface)).map((surface) => surfaceLabels[surface]).join(', ')}`
      : 'None';
    const links = row.setupLinks.map(({ label, href }) =>
      `[${markdownText(label)}](${posix.join(guidePrefix, href)})`).join(' · ');
    lines.push(`| ${[
      markdownText(row.name),
      scopeLabels[row.aiReview],
      scopeLabels[row.issueImport],
      commentLabels[row.outcomeComments.desktop],
      commentLabels[row.outcomeComments.headless],
      transition,
      links,
    ].join(' | ')} |`);
  }
  lines.push('', '**Legend:** Desktop means the desktop app only. Unsupported means the feature is not available on the listed edition or surface.',
    'Outcome write-back is opt-in and targets the imported issue or work item, not the PR/MR. Headless `run`/`serve` uses existing import metadata; it does not import issues.',
    'Status/state moves are optional and only available on the surfaces listed.');
  return lines.join('\n');
}

function prepareTarget(target, rows) {
  const url = new URL(target, root);
  const original = readFileSync(url, 'utf8');
  const start = original.indexOf(startMarker);
  const end = original.indexOf(endMarker);
  requireField(start !== -1 && end !== -1 && start === original.lastIndexOf(startMarker) &&
    end === original.lastIndexOf(endMarker) && start < end,
    `expected exactly one ordered pair of ${startMarker} and ${endMarker}`);

  const bodyStart = start + startMarker.length;
  const body = original.slice(bodyStart, end);
  const expected = `\n\n${renderTable(rows, target)}\n\n`;
  // Ignore checkout newline conversions in check mode; when writing, use the marker line's style.
  const newline = body.startsWith('\r\n') ? '\r\n' : '\n';
  return {
    url,
    stale: body.replaceAll('\r\n', '\n') !== expected,
    updated: original.slice(0, bodyStart) + expected.replaceAll('\n', newline) + original.slice(end),
  };
}

function main(args) {
  const [mode] = args;
  if (args.length !== 1 || !['--write', '--check'].includes(mode)) {
    stderr.write('Usage: node scripts/update-integration-capabilities.mjs --write|--check\n');
    return 1;
  }

  const fail = (errors) => {
    stderr.write(`${errors.join('\n')}\nRegenerate with: ${regenerate}\n`);
    return 1;
  };

  let rows;
  try {
    rows = JSON.parse(readFileSync(new URL(sourcePath, root), 'utf8'));
    validateCapabilities(rows);
  } catch (error) {
    return fail([`${sourcePath}: ${error.message}`]);
  }

  const prepared = new Map();
  const errors = [];
  for (const target of targets) {
    try {
      const result = prepareTarget(target, rows);
      prepared.set(target, result);
      if (mode === '--check' && result.stale) errors.push(`${target}: generated capability block is out of date`);
    } catch (error) {
      errors.push(`${target}: ${error.message}`);
    }
  }
  if (errors.length > 0) return fail(errors);

  if (mode === '--write') {
    for (const [target, { url, stale, updated }] of prepared) {
      if (!stale) continue;
      try {
        writeFileSync(url, updated, 'utf8');
        stdout.write(`Updated ${target}\n`);
      } catch (error) {
        return fail([`${target}: ${error.message}`]);
      }
    }
  }
  return 0;
}

process.exitCode = main(argv.slice(2));
