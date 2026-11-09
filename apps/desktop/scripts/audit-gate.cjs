#!/usr/bin/env node
/**
 * Dependency audit gate.
 *
 * Runs `npm audit --json` from the repo root (deliberately WITHOUT --omit=dev so the
 * devDependency `electron` is covered) and fails on any high/critical advisory that is
 * not listed, per advisory ID, in scripts/audit-exceptions.json.
 *
 * Exception entry: { "id": "GHSA-xxxx", "package": "pkg", "reason": "...",
 *                    "reviewed": "YYYY-MM-DD", "scope": "build-only" }
 *
 * Usage: node scripts/audit-gate.cjs
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BLOCKING_SEVERITIES = new Set(['high', 'critical']);
const EXCEPTIONS_PATH = path.join(__dirname, 'audit-exceptions.json');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

/**
 * Validate the exceptions list. Throws on malformed entries.
 */
function validateExceptions(exceptions) {
  if (!Array.isArray(exceptions)) {
    throw new Error('audit exceptions must be an array');
  }
  const seen = new Set();
  exceptions.forEach((entry, index) => {
    for (const field of ['id', 'package', 'reason']) {
      if (!entry || typeof entry[field] !== 'string' || entry[field].trim() === '') {
        throw new Error(`Invalid audit exception at index ${index}: missing "${field}"`);
      }
    }
    if (seen.has(entry.id)) {
      throw new Error(`Duplicate audit exception for ${entry.id}`);
    }
    seen.add(entry.id);
  });
}

function advisoryId(via) {
  const url = typeof via.url === 'string' ? via.url : '';
  const fromUrl = url.split('/').filter(Boolean).pop();
  return fromUrl || String(via.source || via.title || 'unknown');
}

/**
 * Collect direct (object) advisories of blocking severity from npm v7+ audit JSON.
 * Returns a map id -> { id, package, severity }.
 */
function collectAdvisories(auditJson) {
  const advisories = new Map();
  const vulns = auditJson?.vulnerabilities || {};
  for (const [name, vuln] of Object.entries(vulns)) {
    for (const via of vuln.via || []) {
      if (typeof via !== 'object' || via === null) continue; // string = transitive reference
      if (!BLOCKING_SEVERITIES.has(via.severity)) continue;
      const id = advisoryId(via);
      if (!advisories.has(id)) {
        advisories.set(id, { id, package: via.name || name, severity: via.severity });
      }
    }
  }
  return advisories;
}

/**
 * Pure evaluation. Returns { ok, failures, electronFailures, excepted, stale }.
 * @param {object} auditJson parsed `npm audit --json` output
 * @param {Array} exceptions exception entries
 */
function evaluateAudit(auditJson, exceptions) {
  validateExceptions(exceptions);
  const excepted = new Map(exceptions.map((e) => [e.id, e]));
  const advisories = collectAdvisories(auditJson);

  const failures = [];
  const exceptedFound = [];
  for (const adv of advisories.values()) {
    if (excepted.has(adv.id)) exceptedFound.push(adv);
    else failures.push(adv);
  }
  const stale = exceptions.filter((e) => !advisories.has(e.id));
  const electronFailures = failures.filter((f) => f.package === 'electron');

  return {
    ok: failures.length === 0,
    failures,
    electronFailures,
    excepted: exceptedFound,
    stale,
  };
}

function getElectronVersion() {
  try {
    const pkgPath = require.resolve('electron/package.json', { paths: [REPO_ROOT, __dirname] });
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

function runNpmAudit() {
  const result = spawnSync('npm', ['audit', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Could not parse npm audit output: ${(result.stderr || result.stdout || '').slice(0, 500)}`);
  }
}

function main() {
  const exceptions = JSON.parse(fs.readFileSync(EXCEPTIONS_PATH, 'utf8'));
  const auditJson = runNpmAudit();
  if (auditJson.error) {
    log(`npm audit failed: ${auditJson.error.summary || auditJson.error.code}`, colors.red);
    return 1;
  }

  const result = evaluateAudit(auditJson, exceptions);
  log(`Installed electron version: ${getElectronVersion()}`);

  for (const adv of result.excepted) {
    log(`  excepted: ${adv.id} (${adv.package}, ${adv.severity})`, colors.yellow);
  }
  for (const entry of result.stale) {
    log(`warning: stale exception ${entry.id} (${entry.package}) no longer reported; remove it`, colors.yellow);
  }

  if (result.electronFailures.length > 0) {
    log(
      `✗ electron ${getElectronVersion()} is affected by unlisted high/critical advisories: ` +
        result.electronFailures.map((f) => f.id).join(', '),
      colors.red
    );
  }
  for (const adv of result.failures.filter((f) => f.package !== 'electron')) {
    log(`✗ unlisted ${adv.severity} advisory ${adv.id} in ${adv.package}`, colors.red);
  }

  if (!result.ok) {
    log('Audit gate failed. Fix the dependency or add a reviewed entry to scripts/audit-exceptions.json.', colors.red);
    return 1;
  }
  log('✓ Audit gate passed', colors.green);
  return 0;
}

module.exports = { evaluateAudit, validateExceptions, collectAdvisories };

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    log(`Audit gate error: ${err.message}`, colors.red);
    process.exit(1);
  }
}
