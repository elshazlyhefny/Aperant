import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { evaluateAudit } = require(path.resolve(__dirname, '../../scripts/audit-gate.cjs'));

function audit(vulns: Record<string, Array<{ id: string; severity: string; name?: string }>>) {
  const vulnerabilities: Record<string, unknown> = {};
  for (const [name, advs] of Object.entries(vulns)) {
    vulnerabilities[name] = {
      name,
      severity: 'high',
      via: advs.map((a) => ({
        name: a.name ?? name,
        severity: a.severity,
        url: `https://github.com/advisories/${a.id}`,
      })),
    };
  }
  return { auditReportVersion: 2, vulnerabilities };
}

const exc = (id: string, pkg = 'tar') => ({ id, package: pkg, reason: 'build-only' });

describe('audit gate evaluateAudit', () => {
  it('fails on a high advisory that is not excepted', () => {
    const r = evaluateAudit(audit({ tar: [{ id: 'GHSA-aaaa', severity: 'high' }] }), []);
    expect(r.ok).toBe(false);
    expect(r.failures.map((f: { id: string }) => f.id)).toEqual(['GHSA-aaaa']);
  });

  it('passes when the advisory is excepted', () => {
    const r = evaluateAudit(audit({ tar: [{ id: 'GHSA-aaaa', severity: 'critical' }] }), [exc('GHSA-aaaa')]);
    expect(r.ok).toBe(true);
    expect(r.excepted).toHaveLength(1);
  });

  it('ignores moderate advisories', () => {
    const r = evaluateAudit(audit({ tar: [{ id: 'GHSA-aaaa', severity: 'moderate' }] }), []);
    expect(r.ok).toBe(true);
  });

  it('fails on an unlisted electron advisory and flags it separately', () => {
    const r = evaluateAudit(audit({ electron: [{ id: 'GHSA-eeee', severity: 'high' }] }), []);
    expect(r.ok).toBe(false);
    expect(r.electronFailures).toHaveLength(1);
  });

  it('reports stale exceptions without failing', () => {
    const r = evaluateAudit(audit({}), [exc('GHSA-gone')]);
    expect(r.ok).toBe(true);
    expect(r.stale.map((s: { id: string }) => s.id)).toEqual(['GHSA-gone']);
  });

  it('throws on a malformed exception (missing reason)', () => {
    expect(() => evaluateAudit(audit({}), [{ id: 'GHSA-x', package: 'tar' }])).toThrow(/reason/);
  });
});
