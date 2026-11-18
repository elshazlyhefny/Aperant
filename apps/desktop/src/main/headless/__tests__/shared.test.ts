import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HeadlessSetupError, resolveHeadlessProject } from '../shared';

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'headless-shared-')));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveHeadlessProject', () => {
  it('resolves the git root with the headless id format', () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const project = resolveHeadlessProject(dir);
    expect(project.path).toBe(dir);
    expect(project.autoBuildPath).toBe('.auto-claude');
    expect(project.id).toBe(`headless:${dir}`);
  });

  it('throws HeadlessSetupError outside a git repository', () => {
    expect(() => resolveHeadlessProject(dir)).toThrow(HeadlessSetupError);
  });
});
