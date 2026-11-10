/**
 * zeenha fork: attached task images are announced to agents in a REFERENCE IMAGES section.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildReferenceImagesSection, injectContext } from '../prompt-loader';

let dir: string;
let specDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'refimg-'));
  specDir = join(dir, 'spec');
  mkdirSync(join(specDir, 'attachments'), { recursive: true });
  writeFileSync(join(specDir, 'attachments', 'a.png'), 'x');
  writeFileSync(join(dir, 'outside.png'), 'x');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const meta = (paths: string[]) =>
  writeFileSync(join(specDir, 'task_metadata.json'), JSON.stringify({ attachedImages: paths.map((path) => ({ path })) }));

describe('buildReferenceImagesSection', () => {
  it('returns empty without images', () => {
    expect(buildReferenceImagesSection(specDir)).toBe('');
  });

  it('lists existing images from task_metadata.json', () => {
    meta(['attachments/a.png']);
    const out = buildReferenceImagesSection(specDir);
    expect(out).toContain('REFERENCE IMAGES');
    expect(out).toContain('1 reference image.');
    expect(out).toContain(join(specDir, 'attachments', 'a.png'));
  });

  it('drops missing files and traversal entries', () => {
    meta(['attachments/missing.png', '../outside.png']);
    expect(buildReferenceImagesSection(specDir)).toBe('');
  });

  it('falls back to requirements.json attached_images', () => {
    writeFileSync(join(specDir, 'requirements.json'), JSON.stringify({ attached_images: [{ path: 'attachments/a.png' }] }));
    expect(buildReferenceImagesSection(specDir)).toContain('attachments/a.png');
  });

  it('uses paths relative to a base when asked', () => {
    meta(['attachments/a.png']);
    expect(buildReferenceImagesSection(specDir, dir)).toContain('`spec/attachments/a.png`');
  });
});

describe('injectContext', () => {
  it('includes the section when images exist', () => {
    meta(['attachments/a.png']);
    const out = injectContext('BASE', { specDir, projectDir: dir } as never);
    expect(out).toContain('## REFERENCE IMAGES');
    expect(out.endsWith('BASE')).toBe(true);
  });
});
