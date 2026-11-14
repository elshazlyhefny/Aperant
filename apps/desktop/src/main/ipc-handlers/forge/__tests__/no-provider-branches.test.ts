/**
 * zeenha fork: the shared PR feedback and writeback code must not name providers;
 * they go through the forge registry.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const FILES = ['../../task/pr-feedback-source.ts', '../../issue-writeback/issue-writeback.ts'];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe.each(FILES)('%s', (rel) => {
  const code = stripComments(fs.readFileSync(path.join(__dirname, rel), 'utf8'));

  it('has no quoted provider names', () => {
    expect(code).not.toMatch(/['"`](github|gitlab|linear)['"`]/i);
  });

  it('has no legacy per-provider codes', () => {
    expect(code).not.toMatch(/no_github_config|no_gitlab_config/);
  });

  it('imports nothing from provider modules', () => {
    const imports = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of imports) {
      expect(spec).not.toMatch(/\/github\/|\/gitlab\/|linear-client/);
    }
  });
});
