/**
 * URL policy for WebFetch.
 *
 * Rejects URLs that could reach internal network targets (SSRF) or that carry
 * what looks like a credential (exfiltration through the URL itself).
 * Rejection reasons name the rule and never echo the matched secret value.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  DATABASE_PATTERNS,
  PRIVATE_KEY_PATTERNS,
  SERVICE_PATTERNS,
} from './secret-scanner';

export const MAX_URL_LENGTH = 2048;

export type UrlPolicyResult = { ok: true; url: URL } | { ok: false; reason: string };

export interface ResolvedAddress {
  address: string;
  family?: number;
}

export interface UrlPolicyOptions {
  /** Injectable resolver (tests). Defaults to dns.lookup with all addresses. */
  resolve?: (host: string) => Promise<ResolvedAddress[]>;
}

// These match ordinary URLs (UUID paths, long ids), so they are skipped.
const SKIPPED_PATTERN_LABELS = new Set(['Heroku API Key / UUID', 'Potential Vercel Token']);

const SENSITIVE_PARAM_NAME = /token|secret|passw(or)?d|api[_-]?key|auth|signature|credential|session/i;
const MIN_SENSITIVE_VALUE_LENGTH = 16;
const PRESIGNED_MARKERS = /x-amz-signature|x-goog-signature|x-amz-credential/i;

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function parseIPv6(ip: string): number[] | null {
  let addr = ip;
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);
  // Embedded IPv4 tail
  const lastColon = addr.lastIndexOf(':');
  if (addr.includes('.')) {
    const v4 = parseIPv4(addr.slice(lastColon + 1));
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const n = Number.parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  return bytes;
}

function isBlockedIPv4(b: number[]): boolean {
  const [a, c] = b;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 100 && c >= 64 && c <= 127) return true; // CGNAT
  if (a === 169 && c === 254) return true;
  if (a === 172 && c >= 16 && c <= 31) return true;
  if (a === 192 && c === 168) return true;
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** True when the IP literal is loopback/private/link-local/etc. Unparseable input is blocked. */
export function isBlockedIp(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, '');
  const family = isIP(clean.split('%')[0]);
  if (family === 4) {
    const b = parseIPv4(clean);
    return !b || isBlockedIPv4(b);
  }
  if (family === 6) {
    const b = parseIPv6(clean);
    if (!b) return true;
    const allZeroPrefix = (n: number) => b.slice(0, n).every((x) => x === 0);
    if (allZeroPrefix(15) && (b[15] === 0 || b[15] === 1)) return true; // :: and ::1
    // IPv4-mapped ::ffff:a.b.c.d
    if (allZeroPrefix(10) && b[10] === 0xff && b[11] === 0xff) {
      return isBlockedIPv4(b.slice(12));
    }
    // IPv4-compatible ::a.b.c.d (deprecated)
    if (allZeroPrefix(12)) return isBlockedIPv4(b.slice(12));
    if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10
    if (b[0] === 0xff) return true; // multicast
    return false;
  }
  return true;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Returns a description of the first secret-like thing found, or null. Never includes the value. */
export function scanUrlForSecrets(url: URL): string | null {
  const texts = new Set<string>();
  for (const part of [url.hostname, url.pathname, url.search, url.hash, url.href]) {
    texts.add(part);
    texts.add(safeDecode(part));
    texts.add(safeDecode(safeDecode(part)));
  }
  const patterns = [...SERVICE_PATTERNS, ...PRIVATE_KEY_PATTERNS, ...DATABASE_PATTERNS].filter(
    ([, label]) => !SKIPPED_PATTERN_LABELS.has(label),
  );
  for (const text of texts) {
    for (const [re, label] of patterns) {
      if (re.test(text)) return `URL contains what looks like a ${label}`;
    }
  }
  for (const [name, value] of url.searchParams) {
    if (SENSITIVE_PARAM_NAME.test(name) && value.length >= MIN_SENSITIVE_VALUE_LENGTH) {
      return 'URL contains a query parameter that looks like a credential (token/secret/key/signature)';
    }
  }
  const decodedSearch = safeDecode(url.search);
  if (PRESIGNED_MARKERS.test(decodedSearch)) {
    return 'URL looks like a presigned URL (contains a signature or credential parameter)';
  }
  return null;
}

async function defaultResolve(host: string): Promise<ResolvedAddress[]> {
  return lookup(host, { all: true });
}

/** Validates a URL before WebFetch requests it. */
export async function validateFetchUrl(
  rawUrl: string,
  options: UrlPolicyOptions = {},
): Promise<UrlPolicyResult> {
  if (typeof rawUrl !== 'string' || rawUrl.length > MAX_URL_LENGTH) {
    return { ok: false, reason: `URL is longer than ${MAX_URL_LENGTH} characters` };
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'URL is not valid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Only http and https URLs are allowed' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'URLs with embedded credentials are not allowed' };
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) return { ok: false, reason: 'URL has no host' };

  if (isIP(host)) {
    if (isBlockedIp(host)) {
      return { ok: false, reason: 'URL points to a private, loopback, link-local or reserved IP address' };
    }
  } else {
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      !host.includes('.')
    ) {
      return { ok: false, reason: 'URL points to a local or internal host name' };
    }
  }

  const secret = scanUrlForSecrets(url);
  if (secret) return { ok: false, reason: secret };

  if (!isIP(host)) {
    let addrs: ResolvedAddress[];
    try {
      addrs = await (options.resolve ?? defaultResolve)(host);
    } catch {
      return { ok: false, reason: 'Could not resolve the host name' };
    }
    if (!addrs || addrs.length === 0) {
      return { ok: false, reason: 'Could not resolve the host name' };
    }
    if (addrs.some((a) => isBlockedIp(a.address))) {
      return { ok: false, reason: 'Host name resolves to a private, loopback, link-local or reserved IP address' };
    }
  }

  return { ok: true, url };
}
