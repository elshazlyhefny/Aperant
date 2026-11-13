import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

const { mockSpawn, mockIsWindows } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockIsWindows: vi.fn(() => false),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: mockSpawn };
});

vi.mock('../../platform', () => ({ isWindows: mockIsWindows }));

import { planClaudeInvocation, spawnClaudeWithPrompt } from '../claude-cli';

const FIXED = ['-p', '--output-format', 'text', '--model', 'haiku'];
const EVIL = '" & echo pwned & " %PATH%';

function makeChild() {
  const child = new EventEmitter() as any;
  child.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe('claude-cli', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockIsWindows.mockReturnValue(false);
    mockSpawn.mockImplementation(() => makeChild());
  });

  it('POSIX: no shell and fixed argv', () => {
    const plan = planClaudeInvocation('/usr/bin/claude');
    expect(plan.file).toBe('/usr/bin/claude');
    expect(plan.args).toEqual(FIXED);
    expect(plan.options.shell).toBe(false);
  });

  it('Windows .cmd: uses cmd.exe with a single fixed command string', () => {
    mockIsWindows.mockReturnValue(true);
    const plan = planClaudeInvocation('C:\\Users\\me\\npm\\claude.cmd');
    expect(plan.file.toLowerCase()).toContain('cmd.exe');
    expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(plan.args).toHaveLength(4);
    expect(plan.args[3]).toBe('""C:\\Users\\me\\npm\\claude.cmd" -p --output-format text --model haiku"');
    expect(plan.options.windowsVerbatimArguments).toBe(true);
    expect(plan.options.shell).toBe(false);
  });

  it('Windows non-.cmd exe is spawned directly', () => {
    mockIsWindows.mockReturnValue(true);
    const plan = planClaudeInvocation('C:\\bin\\claude.exe');
    expect(plan.file).toBe('C:\\bin\\claude.exe');
    expect(plan.args).toEqual(FIXED);
  });

  it('prompt goes only to stdin, byte-for-byte', () => {
    for (const win of [false, true]) {
      mockIsWindows.mockReturnValue(win);
      mockSpawn.mockClear();
      const child = makeChild();
      mockSpawn.mockReturnValue(child);
      spawnClaudeWithPrompt({
        claudePath: win ? 'C:\\npm\\claude.cmd' : '/usr/bin/claude',
        prompt: EVIL,
        cwd: '/tmp',
        env: {},
      });
      const [file, args, options] = mockSpawn.mock.calls[0];
      expect(JSON.stringify([file, args, options])).not.toContain('pwned');
      expect(JSON.stringify([file, args, options])).not.toContain('%PATH%');
      expect(child.stdin.write).toHaveBeenCalledWith(EVIL, 'utf-8');
      expect(child.stdin.end).toHaveBeenCalled();
    }
  });

  it('swallows stdin EPIPE errors', () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    spawnClaudeWithPrompt({ claudePath: '/usr/bin/claude', prompt: 'x' });
    expect(() => child.stdin.emit('error', new Error('EPIPE'))).not.toThrow();
  });

  it('rejects insecure .cmd paths before spawning', () => {
    mockIsWindows.mockReturnValue(true);
    for (const p of ['C:\\a&b\\claude.cmd', 'C:\\%TEMP%\\claude.bat']) {
      expect(() => spawnClaudeWithPrompt({ claudePath: p, prompt: 'x' })).toThrow(/security validation/);
    }
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
