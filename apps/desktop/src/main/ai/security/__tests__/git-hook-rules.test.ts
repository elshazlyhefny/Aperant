import { describe, expect, it } from 'vitest';
import { bashSecurityHook } from '../bash-validator';
import { validateGitInternalsWrite } from '../validators/git-validators';

function decision(command: string): string | undefined {
  const result = bashSecurityHook({ toolName: 'Bash', toolInput: { command } });
  return 'hookSpecificOutput' in result ? result.hookSpecificOutput.permissionDecision : undefined;
}

describe('git hook rules (zeenha fork)', () => {
  const blocked = [
    'git config core.hooksPath /tmp/h',
    'git config --global core.fsmonitor ./x',
    'git -c core.fsmonitor=x status',
    'git -ccore.hooksPath=x commit',
    'echo x > .git/hooks/pre-commit',
    'cat evil >> .git/config',
    'echo x | tee .git/hooks/post-merge',
    'tee .git/hooks/post-merge',
    'cp x .git/hooks/pre-commit',
  ];
  const allowed = [
    'git config --get core.hooksPath',
    'git config --list',
    'git config core.autocrlf true',
    'git status',
    'ls .git/hooks',
    'cat .git/config',
    'git log --oneline -20',
    'echo hi > notes.txt',
    'cp .git/hooks/pre-commit /tmp/backup',
  ];

  it.each(blocked)('blocks %s', (command) => {
    expect(decision(command)).toBe('deny');
  });

  it.each(allowed)('allows %s', (command) => {
    expect(decision(command)).toBeUndefined();
  });

  it('mentions the sandbox in the deny message', () => {
    const [ok, reason] = validateGitInternalsWrite('echo x > .git/hooks/pre-commit');
    expect(ok).toBe(false);
    expect(reason).toContain('speed bump');
    expect(reason).toContain('sandbox');
  });
});
