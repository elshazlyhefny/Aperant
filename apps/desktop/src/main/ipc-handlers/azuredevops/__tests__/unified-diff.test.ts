import { describe, it, expect } from 'vitest';
import { buildFilePatch } from '../unified-diff';

describe('buildFilePatch', () => {
  it('builds an add patch', () => {
    const r = buildFilePatch('a.ts', 'a.ts', null, 'x\ny\n', 'add');
    expect(r.additions).toBe(2);
    expect(r.deletions).toBe(0);
    expect(r.patch).toContain('diff --git a/a.ts b/a.ts');
    expect(r.patch).toContain('new file mode 100644');
    expect(r.patch).toContain('--- /dev/null');
    expect(r.patch).toContain('@@ -0,0 +1,2 @@\n+x\n+y\n');
  });

  it('builds an edit patch with context', () => {
    const r = buildFilePatch('a.ts', 'a.ts', 'a\nb\nc\n', 'a\nB\nc\n', 'edit');
    expect(r.additions).toBe(1);
    expect(r.deletions).toBe(1);
    expect(r.patch).toContain('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n');
  });

  it('builds a delete patch', () => {
    const r = buildFilePatch('a.ts', 'a.ts', 'x\n', null, 'delete');
    expect(r.deletions).toBe(1);
    expect(r.patch).toContain('deleted file mode 100644');
    expect(r.patch).toContain('+++ /dev/null');
    expect(r.patch).toContain('@@ -1,1 +0,0 @@\n-x\n');
  });

  it('builds a rename patch', () => {
    const r = buildFilePatch('old.ts', 'new.ts', 'a\n', 'a\nb\n', 'rename');
    expect(r.patch).toContain('diff --git a/old.ts b/new.ts');
    expect(r.patch).toContain('rename from old.ts\nrename to new.ts');
    expect(r.patch).toContain('--- a/old.ts\n+++ b/new.ts');
    expect(r.additions).toBe(1);
  });

  it('pure rename has no hunks', () => {
    const r = buildFilePatch('old.ts', 'new.ts', 'a\n', 'a\n', 'rename');
    expect(r.patch).not.toContain('@@');
  });

  it('splits distant changes into multiple hunks', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i}`);
    const next = [...lines];
    next[2] = 'X';
    next[25] = 'Y';
    const r = buildFilePatch('f', 'f', `${lines.join('\n')}\n`, `${next.join('\n')}\n`, 'edit');
    expect(r.patch.match(/^@@ /gm)).toHaveLength(2);
    expect(r.additions).toBe(2);
    expect(r.deletions).toBe(2);
  });

  it('marks missing trailing newline', () => {
    const r = buildFilePatch('f', 'f', 'a\nb', 'a\nb\n', 'edit');
    expect(r.patch).toContain('-b\n\\ No newline at end of file\n+b\n');
  });

  it('returns header-only patch for binary content', () => {
    const r = buildFilePatch('f.bin', 'f.bin', 'a\0b', 'a\0c', 'edit');
    expect(r.patch).not.toContain('@@');
    expect(r.additions).toBe(0);
    expect(r.deletions).toBe(0);
    expect(r.patch.startsWith('diff --git a/f.bin b/f.bin')).toBe(true);
  });

  it('returns header-only patch for oversized content', () => {
    const big = 'x\n'.repeat(25000);
    const r = buildFilePatch('f', 'f', null, big, 'add');
    expect(r.patch).not.toContain('@@');
    expect(r.additions).toBe(0);
  });
});
