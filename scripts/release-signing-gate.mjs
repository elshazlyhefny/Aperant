#!/usr/bin/env node
/**
 * zeenha fork: Fail closed rather than publish an unsigned Windows installer
 * as an official release (CWE-345).
 *
 * Usage:
 *   node scripts/release-signing-gate.mjs preflight --official <true|false>
 *   node scripts/release-signing-gate.mjs verify-attestation --assets <dir> --attestation <file> [--require-signed]
 */

import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const REQUIRED_SIGNING_SETTINGS = Object.freeze([
  'AZURE_CLIENT_ID',
  'AZURE_TENANT_ID',
  'AZURE_SUBSCRIPTION_ID',
  'AZURE_SIGNING_ACCOUNT',
  'AZURE_CERTIFICATE_PROFILE',
  'WINDOWS_SIGNING_PUBLISHER',
]);

function isNonBlank(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function checkSigningConfig(env, { official }) {
  const missing = REQUIRED_SIGNING_SETTINGS.filter((name) => !isNonBlank(env[name]));
  const configured = missing.length === 0;
  const ok = configured || !official;
  const messages = [];
  if (!configured) {
    const details = `Missing Windows signing settings: ${missing.join(', ')}.`;
    messages.push(official
      ? details
      : `${details} The Windows build will be unsigned and cannot be published.`);
  }
  return { ok, configured, missing, messages };
}

const EXE_EXTENSION = /\.exe$/i;
const SHA256_HEX = /^[a-f0-9]{64}$/;

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/**
 * Match the final release bytes to the Windows runner's attestation.
 * Authenticode verification itself must happen on the Windows runner.
 */
export async function verifyWindowsAttestation({ assetsDir, attestationPath, expectedPublisher, requireSigned }) {
  const errors = [];
  const fail = () => ({ ok: false, errors, summary: 'Windows installer attestation check failed.' });

  let attestation;
  try {
    attestation = JSON.parse(await readFile(attestationPath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      errors.push('Windows signature attestation is not valid JSON.');
    } else if (error.code === 'ENOENT') {
      errors.push('Windows signature attestation file is missing.');
    } else {
      errors.push('Could not read the Windows signature attestation file.');
    }
    return fail();
  }

  if (attestation?.schemaVersion !== 1) {
    errors.push('Windows signature attestation must have schemaVersion 1.');
    return fail();
  }
  if (typeof attestation.signed !== 'boolean' || !Array.isArray(attestation.files)) {
    errors.push('Malformed Windows signature attestation: expected a signed boolean and a files array.');
    return fail();
  }

  if (requireSigned) {
    if (attestation.signed !== true) {
      errors.push('Windows signature attestation does not attest to signed installers.');
    }
    if (!isNonBlank(expectedPublisher)) {
      errors.push('WINDOWS_SIGNING_PUBLISHER is required to verify signed installers.');
    } else if (attestation.expectedPublisher !== expectedPublisher) {
      errors.push('Windows signature attestation publisher does not match WINDOWS_SIGNING_PUBLISHER.');
    }
  }

  const attestedFiles = new Map();
  for (const entry of attestation.files) {
    const name = entry?.name;
    if (typeof name !== 'string' || /[/\\\0]/.test(name) || !EXE_EXTENSION.test(name)) {
      errors.push('Malformed Windows signature attestation: each file entry must name a top-level .exe.');
      continue;
    }
    if (attestedFiles.has(name)) {
      errors.push(`Duplicate attestation entry for ${JSON.stringify(name)}.`);
      continue;
    }
    attestedFiles.set(name, entry);
    if (typeof entry.sha256 !== 'string' || !SHA256_HEX.test(entry.sha256)) {
      errors.push(`Invalid SHA-256 in attestation for ${JSON.stringify(name)}.`);
    }
    if (requireSigned && entry.status !== 'Valid') {
      errors.push(`${JSON.stringify(name)} does not have a Valid Authenticode signature.`);
    }
    if (requireSigned && entry.timestamped !== true) {
      errors.push(`${JSON.stringify(name)} is missing a signature timestamp.`);
    }
  }

  let assets;
  try {
    assets = await readdir(assetsDir, { withFileTypes: true });
  } catch {
    errors.push('Could not read the release assets directory.');
    return fail();
  }

  const installers = new Set();
  for (const asset of assets) {
    if (!EXE_EXTENSION.test(asset.name)) continue;
    const label = JSON.stringify(asset.name);
    if (!asset.isFile()) {
      errors.push(`Windows installer ${label} is not a regular file.`);
      continue;
    }
    installers.add(asset.name);
    const entry = attestedFiles.get(asset.name);
    if (!entry) {
      errors.push(`Windows installer ${label} is not listed in the attestation.`);
      continue;
    }
    try {
      if (await sha256(join(assetsDir, asset.name)) !== entry.sha256) {
        errors.push(`SHA-256 mismatch for Windows installer ${label}.`);
      }
    } catch {
      errors.push(`Could not hash Windows installer ${label}.`);
    }
  }
  if (installers.size === 0) {
    errors.push('No Windows installers (.exe) found in the release assets directory.');
  }
  for (const name of attestedFiles.keys()) {
    if (!installers.has(name)) {
      errors.push(`Attested Windows installer ${JSON.stringify(name)} is missing from the release assets.`);
    }
  }

  if (errors.length > 0) return fail();

  const matched = `Matched ${installers.size} Windows installer hash(es) to the attestation.`;
  const signing = requireSigned
    ? 'Required signature, publisher, and timestamp checks passed.'
    : attestation.signed
      ? 'Reported signed by the Windows build; signing was not required for this check.'
      : 'UNSIGNED build-only artifact, not publishable.';
  return { ok: true, errors, summary: `${matched} ${signing}` };
}

function annotate(level, message) {
  // Escape workflow-command data so a filename cannot add a second annotation.
  const escaped = message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  process.stdout.write(`::${level}::${escaped}\n`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'preflight') {
    const { values } = parseArgs({ args, options: { official: { type: 'string' } } });
    if (values.official !== 'true' && values.official !== 'false') {
      throw new Error('Usage: preflight --official <true|false>');
    }
    const { ok, configured, messages } = checkSigningConfig(process.env, {
      official: values.official === 'true',
    });
    for (const message of messages) annotate(ok ? 'warning' : 'error', message);
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `signing_configured=${configured}\n`);
    }
    return ok ? 0 : 1;
  }

  if (command === 'verify-attestation') {
    const { values } = parseArgs({ args, options: {
      assets: { type: 'string' },
      attestation: { type: 'string' },
      'require-signed': { type: 'boolean', default: false },
    } });
    if (!isNonBlank(values.assets) || !isNonBlank(values.attestation)) {
      throw new Error('Usage: verify-attestation --assets <dir> --attestation <file> [--require-signed]');
    }
    const { ok, errors, summary } = await verifyWindowsAttestation({
      assetsDir: values.assets,
      attestationPath: values.attestation,
      expectedPublisher: process.env.WINDOWS_SIGNING_PUBLISHER,
      requireSigned: values['require-signed'],
    });
    for (const error of errors) annotate('error', error);
    process.stdout.write(`${summary}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Windows signing gate\n\n${summary}\n`);
    }
    return ok ? 0 : 1;
  }

  throw new Error('Expected subcommand: preflight or verify-attestation.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    annotate('error', error.message);
    process.exitCode = 1;
  }
}
