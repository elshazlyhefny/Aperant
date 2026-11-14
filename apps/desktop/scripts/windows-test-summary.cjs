#!/usr/bin/env node
/**
 * Windows unit test summary.
 *
 * Reads a Vitest JSON report, counts tests, lists skipped tests, and statically scans
 * src/**\/*.test.{ts,tsx} for skipOnWindows(...) calls. Every call must carry a
 * non-empty string-literal reason; otherwise the script exits non-zero.
 * The markdown summary is printed and appended to $GITHUB_STEP_SUMMARY when set.
 *
 * A missing report exits 0 so an earlier vitest failure is not masked (the vitest step
 * itself carries the failure).
 *
 * Usage: node scripts/windows-test-summary.cjs [report.json]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const HELPER_TEST = 'src/__tests__/helpers/windows-skip.test.ts';
const DEFAULT_REPORT = path.join('test-results', 'windows-unit.json');

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.test\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Find skipOnWindows( calls and extract the string-literal reason.
 * The reason is the first argument, or the first string literal argument.
 */
function scanSkips(files) {
  const skips = [];
  const problems = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    // The helper's own test calls skipOnWindows with invalid reasons on purpose.
    if (rel === HELPER_TEST) continue;
    const re = /skipOnWindows\s*\(/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      const lineNo = text.slice(0, match.index).split('\n').length;
      const lineStart = text.lastIndexOf('\n', match.index) + 1;
      const before = text.slice(lineStart, match.index);
      // Ignore imports/comments/definitions
      if (/^\s*(\/\/|\*|import\b)/.test(before) || /(function|const|export)\s+$/.test(before)) continue;
      const rest = text.slice(match.index + match[0].length);
      const lit = /^\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\$]|\\.)*)`)/.exec(rest);
      const reason = lit ? (lit[1] ?? lit[2] ?? lit[3] ?? '') : null;
      if (reason === null) {
        problems.push(`${rel}:${lineNo}: skipOnWindows() has no string-literal reason`);
      } else if (reason.trim() === '') {
        problems.push(`${rel}:${lineNo}: skipOnWindows() has an empty reason`);
      } else {
        skips.push({ file: rel, line: lineNo, reason: reason.trim() });
      }
    }
  }
  return { skips, problems };
}

function escapeCell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function readReport(reportPath) {
  if (!fs.existsSync(reportPath)) {
    return { note: `Vitest report not found at ${reportPath}; skipping test counts.` };
  }
  try {
    return { report: JSON.parse(fs.readFileSync(reportPath, 'utf8')) };
  } catch (err) {
    return { note: `Vitest report at ${reportPath} could not be parsed: ${err.message}` };
  }
}

function summarizeReport(report) {
  const counts = { total: 0, passed: 0, failed: 0, skipped: 0 };
  const skippedNames = [];
  for (const suite of report.testResults || []) {
    for (const t of suite.assertionResults || []) {
      counts.total += 1;
      if (t.status === 'passed') counts.passed += 1;
      else if (t.status === 'failed') counts.failed += 1;
      else if (t.status === 'skipped' || t.status === 'pending' || t.status === 'todo') {
        counts.skipped += 1;
        skippedNames.push(t.fullName || t.title || '(unnamed)');
      }
    }
  }
  return { counts, skippedNames };
}

function main() {
  const reportPath = path.resolve(ROOT, process.argv[2] || DEFAULT_REPORT);
  const lines = ['## Windows unit test summary', ''];

  const { report, note } = readReport(reportPath);
  if (note) {
    lines.push(`> ${note}`, '');
  } else {
    const { counts, skippedNames } = summarizeReport(report);
    lines.push(
      '| Total | Passed | Failed | Skipped |',
      '| ---: | ---: | ---: | ---: |',
      `| ${counts.total} | ${counts.passed} | ${counts.failed} | ${counts.skipped} |`,
      ''
    );
    if (skippedNames.length > 0) {
      lines.push('### Skipped tests', '');
      for (const name of skippedNames) lines.push(`- ${escapeCell(name)}`);
      lines.push('');
    }
  }

  const { skips, problems } = scanSkips(walk(SRC_DIR, []));
  lines.push('### Windows-specific skips (`skipOnWindows`)', '');
  if (skips.length === 0) {
    lines.push('None.', '');
  } else {
    lines.push('| File | Reason |', '| --- | --- |');
    for (const s of skips) lines.push(`| ${escapeCell(`${s.file}:${s.line}`)} | ${escapeCell(s.reason)} |`);
    lines.push('');
  }
  if (problems.length > 0) {
    lines.push('### Invalid skipOnWindows calls', '');
    for (const p of problems) lines.push(`- ${escapeCell(p)}`);
    lines.push('');
  }

  const markdown = lines.join('\n');
  console.log(markdown);

  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
    } catch (err) {
      console.error(`Could not write GITHUB_STEP_SUMMARY: ${err.message}`);
    }
  }

  if (problems.length > 0) {
    console.error('\nEvery skipOnWindows() call needs a non-empty string-literal reason:');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
}

main();
