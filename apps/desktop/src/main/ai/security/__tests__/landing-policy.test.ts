/**
 * zeenha fork: PR-only landing in the Bash validator.
 *
 * With `prOnlyLanding` on (or unknown), an agent may push only to an explicit
 * `auto-claude/*` destination and may never merge a pull request. With it off,
 * the same commands go through.
 */

import { describe, expect, it } from 'vitest';

import { bashSecurityHook, type SecurityProfile, validateCommand } from '../bash-validator';
import { validateLandingPolicy } from '../validators/landing-validators';

function profile(prOnlyLanding?: boolean): SecurityProfile {
  return {
    baseCommands: new Set(),
    stackCommands: new Set(),
    scriptCommands: new Set(),
    customCommands: new Set(),
    customScripts: { shellScripts: [] },
    getAllAllowedCommands: () => new Set(),
    prOnlyLanding,
  };
}

function hookDenies(command: string, p?: SecurityProfile | null): string | null {
  const result = bashSecurityHook({ toolName: 'Bash', toolInput: { command } }, p);
  return 'hookSpecificOutput' in result ? result.hookSpecificOutput.permissionDecisionReason : null;
}

const ALLOWED = [
  'git push -u origin auto-claude/001-x',
  'git push origin HEAD:auto-claude/001-x',
  'git push --force-with-lease origin auto-claude/001-x',
  'git push origin +HEAD:refs/heads/auto-claude/001-x',
  'git push origin --delete auto-claude/001-x',
  'git push origin :auto-claude/001-x',
  'cd sub && git push -u origin HEAD:auto-claude/001-x 2>&1',
  'git status && git log --oneline -5',
  'git commit -m "push to main later"',
  'gh pr create --base main --head auto-claude/001-x --title t --body b',
  'gh pr view 5 --json mergeable',
  'gh api repos/o/r/pulls/5',
  'gh api repos/o/r/pulls/5/merge',
  'git config --get alias.co',
  'echo "git push origin main"',
];

const REFUSED = [
  'git push origin main',
  'git push origin HEAD:main',
  'git push',
  'git push origin',
  'git push origin HEAD',
  'cd x && git push origin main',
  'git status; git push origin main',
  'git status || git push origin main',
  'git -C . push origin HEAD:refs/heads/main',
  'git --git-dir=.git push origin HEAD:main',
  'git push origin --delete main',
  'git push origin :main',
  'git push --force origin main',
  'git push origin +HEAD:main',
  'git push origin auto-claude/001-x main',
  'git push origin auto-claude/001-x:main',
  'git push origin HEAD:refs/tags/v1',
  'git push origin "refs/heads/*:refs/heads/*"',
  'git push --all origin',
  'git push --mirror origin',
  'git push --tags origin auto-claude/001-x',
  'GIT_TRACE=1 git push origin main',
  'env GIT_TRACE=1 git push origin main',
  'nohup git push origin main > /dev/null 2>&1 &',
  '/usr/bin/git push origin main',
  'bash -c "git push origin main"',
  "sh -lc 'git push origin HEAD:main'",
  'eval "git push origin main"',
  'echo $(git push origin main)',
  'echo "`git push origin main`"',
  'echo main | xargs git push origin',
  'git -c alias.p=push p origin main',
  'git config alias.p push',
  'git send-pack origin main',
  'gh pr merge 5 --squash',
  'gh -R o/r pr merge 5 --auto',
  'gh api -X PUT repos/o/r/pulls/5/merge',
  'gh api --method=PUT /repos/o/r/pulls/5/merge',
  'gh api repos/o/r/merges -f base=main -f head=x',
  'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc',
  "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
  'gh repo sync',
  "gh alias set m 'pr merge'",
];

describe('validateLandingPolicy', () => {
  for (const command of ALLOWED) {
    it(`allows: ${command}`, () => {
      expect(validateLandingPolicy(command)).toEqual([true, '']);
    });
  }
  for (const command of REFUSED) {
    it(`refuses: ${command}`, () => {
      const [allowed, reason] = validateLandingPolicy(command);
      expect(allowed).toBe(false);
      expect(reason).toContain('pull requests only');
    });
  }

  it('says a bare HEAD push names no destination', () => {
    const [allowed, reason] = validateLandingPolicy('git push origin HEAD');
    expect(allowed).toBe(false);
    expect(reason).toContain('does not name the destination branch');
  });

  it('tells the agent what to do instead', () => {
    const [, reason] = validateLandingPolicy('git push origin main');
    expect(reason).toContain('git push -u origin HEAD:auto-claude/');
    expect(reason).toContain('`main`');
  });
});

describe('bashSecurityHook with PR-only landing', () => {
  it('refuses a push to the base branch when the setting is on', () => {
    expect(hookDenies('git push origin HEAD:main', profile(true))).toContain('pull requests only');
  });

  it('fails closed when the setting is unknown (no profile, or not carried)', () => {
    expect(hookDenies('git push origin main', undefined)).toContain('pull requests only');
    expect(hookDenies('git push origin main', null)).toContain('pull requests only');
    expect(hookDenies('git push origin main', profile(undefined))).toContain('pull requests only');
  });

  it('allows the task branch push when the setting is on', () => {
    expect(hookDenies('git push -u origin auto-claude/001-x', profile(true))).toBeNull();
  });

  it('positive control: with the setting OFF every refused command is allowed', () => {
    for (const command of REFUSED) {
      // `git config alias.*` etc. are only refused by the landing policy;
      // nothing else in the validator refuses any of these.
      expect(hookDenies(command, profile(false)), command).toBeNull();
      expect(validateCommand(command, profile(false)), command).toEqual([true, '']);
    }
  });

  it('validateCommand applies the same policy', () => {
    expect(validateCommand('gh pr merge 5 --squash', profile(true))[0]).toBe(false);
    expect(validateCommand('git push origin auto-claude/001-x', profile(true))).toEqual([true, '']);
  });
});
