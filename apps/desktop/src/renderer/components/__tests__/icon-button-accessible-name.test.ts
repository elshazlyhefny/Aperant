/**
 * zeenha fork: icon-only buttons need an accessible name, and controls that are
 * revealed on hover must also be revealed on keyboard focus.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const COMPONENTS = path.resolve(__dirname, '..');

// Decorative hover effects that are not keyboard-operable controls.
const REVEAL_ALLOWLIST = new Set(['WelcomeScreen.tsx']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
}

/** Find `<Button ...>` opening tags; `{}` depth is tracked so `=>` does not end the tag. */
function findButtonTags(src: string): Array<{ index: number; tag: string; rest: string }> {
  const tags: Array<{ index: number; tag: string; rest: string }> = [];
  const re = /<Button(?=[\s>/])/g;
  let m: RegExpExecArray | null = re.exec(src);
  while (m !== null) {
    let depth = 0;
    let i = m.index + 7;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    const tag = src.slice(m.index, i + 1);
    const selfClosing = tag.endsWith('/>');
    let rest = '';
    if (!selfClosing) {
      const close = src.indexOf('</Button>', i);
      rest = close === -1 ? '' : src.slice(i + 1, close);
    }
    tags.push({ index: m.index, tag, rest });
    m = re.exec(src);
  }
  return tags;
}

describe('icon button accessible names', () => {
  const files = walk(COMPONENTS);

  it('every <Button size="icon"> has aria-label, title or an sr-only child', () => {
    const failures: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const { index, tag, rest } of findButtonTags(src)) {
        if (!/size=("icon"|\{['"]icon['"]\})/.test(tag)) continue;
        if (/aria-label=|aria-labelledby=|\btitle=/.test(tag)) continue;
        if (rest.includes('sr-only')) continue;
        // asChild: the named element is the child (e.g. an <a aria-label>)
        if (/\basChild\b/.test(tag) && /aria-label=|\btitle=/.test(rest)) continue;
        failures.push(`${path.relative(COMPONENTS, file)}:${lineOf(src, index)}`);
      }
    }
    expect(failures, `Icon buttons without an accessible name:\n${failures.join('\n')}`).toEqual([]);
  });

  it('hover-revealed controls are also revealed on keyboard focus', () => {
    const failures: string[] = [];
    for (const file of files) {
      if (REVEAL_ALLOWLIST.has(path.basename(file))) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        if (!line.includes('opacity-0') || !line.includes('group-hover:opacity-100')) return;
        if (/focus-visible:opacity-100|focus:opacity-100|group-focus-within:opacity-100/.test(line)) return;
        failures.push(`${path.relative(COMPONENTS, file)}:${idx + 1}`);
      });
    }
    expect(failures, `Hover-only reveals without a focus variant:\n${failures.join('\n')}`).toEqual([]);
  });
});
