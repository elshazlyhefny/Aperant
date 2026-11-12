/**
 * zeenha fork: end-to-end check that `.auto-claude/.env` (integration tokens)
 * is unreachable by agent tools, the Bash credential validator and the sandbox.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { editTool } from '../../tools/builtin/edit';
import { globTool } from '../../tools/builtin/glob';
import { grepTool } from '../../tools/builtin/grep';
import { readTool } from '../../tools/builtin/read';
import { writeTool } from '../../tools/builtin/write';
import type { ToolContext } from '../../tools/types';
import { wrapForSandbox } from '../sandbox';
import { validateCredentialPaths } from '../validators/credential-validators';

const SECRET = 'GITHUB_TOKEN=ghp_supersecretvalue';

let root: string;
let worktree: string;
let mainEnv: string;
let wtEnv: string;

function ctx(dir: string): ToolContext {
  return { cwd: dir, projectDir: dir, specDir: path.join(dir, 'spec') } as unknown as ToolContext;
}


async function outcome(run: () => unknown): Promise<string> {
  try {
    return String(await run());
  } catch (err) {
    return `ERROR: ${(err as Error).message}`;
  }
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'secret-file-')));
  worktree = path.join(root, '.auto-claude', 'worktrees', 'tasks', '001');
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(path.join(worktree, '.auto-claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'visible.txt'), 'hello');
  mainEnv = path.join(root, '.auto-claude', '.env');
  wtEnv = path.join(worktree, '.auto-claude', '.env');
  fs.writeFileSync(mainEnv, SECRET);
  fs.writeFileSync(wtEnv, SECRET);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('agent file tools with projectDir = project root', () => {
  it('Read refuses the file', async () => {
    const out = await outcome(() =>
      readTool.config.execute({ file_path: mainEnv } as never, ctx(root)),
    );
    expect(out).toContain('ERROR');
    expect(out).not.toContain('ghp_');
  });

  it('Write refuses the file', async () => {
    const out = await outcome(() =>
      writeTool.config.execute({ file_path: mainEnv, content: 'x' } as never, ctx(root)),
    );
    expect(out).toContain('ERROR');
    expect(fs.readFileSync(mainEnv, 'utf8')).toBe(SECRET);
  });

  it('Edit refuses the file', async () => {
    const out = await outcome(() =>
      editTool.config.execute(
        { file_path: mainEnv, old_string: 'ghp_', new_string: 'zzz' } as never,
        ctx(root),
      ),
    );
    expect(out).toContain('ERROR');
    expect(fs.readFileSync(mainEnv, 'utf8')).toBe(SECRET);
  });

  it('Glob does not list the file', async () => {
    const out = await outcome(() =>
      globTool.config.execute(
        { pattern: '**/.env*', path: path.join(root, '.auto-claude') } as never,
        ctx(root),
      ),
    );
    expect(out).not.toContain(`${path.sep}.auto-claude${path.sep}.env`);
  });

  it('Grep does not return its contents', async () => {
    const out = await outcome(() =>
      grepTool.config.execute({ pattern: 'ghp_', path: root } as never, ctx(root)),
    );
    expect(out).not.toContain('ghp_supersecretvalue');
  });
});

describe('Read with projectDir = the task worktree', () => {
  it('cannot reach the main project secret file', async () => {
    const out = await outcome(() =>
      readTool.config.execute({ file_path: mainEnv } as never, ctx(worktree)),
    );
    expect(out).toContain('ERROR');
    expect(out).not.toContain('ghp_');
  });

  it("cannot read the worktree's own .auto-claude/.env", async () => {
    const out = await outcome(() =>
      readTool.config.execute({ file_path: wtEnv } as never, ctx(worktree)),
    );
    expect(out).toContain('ERROR');
    expect(out).not.toContain('ghp_');
  });
});

describe('Bash credential validator', () => {
  it('refuses a relative path climbing to the main .env', () => {
    expect(validateCredentialPaths('cat ../../../.env')[0]).toBe(false);
  });
});

describe('Linux sandbox from the worktree', () => {
  it('masks the main project secret file', () => {
    const r = wrapForSandbox('/bin/bash', ['-c', 'ls'], {
      mode: 'home-hidden',
      cwd: worktree,
      projectDir: worktree,
      writablePaths: [],
      homeDir: '/home/u',
      platformName: 'linux',
      find: (n: string) => `/usr/bin/${n}`,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const idx = r.args.findIndex((a, k) => a === '--ro-bind' && r.args[k + 1] === '/dev/null' && r.args[k + 2] === mainEnv);
    expect(idx).toBeGreaterThan(-1);
  });
});
