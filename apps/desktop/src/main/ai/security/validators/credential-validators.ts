/**
 * Credential Path Validator
 * =========================
 *
 * zeenha fork: refuse Bash commands that name the developer's credential
 * files or directories (`~/.ssh`, `~/.aws`, `~/.claude/.credentials.json`,
 * `~/.config/gh`, and closely related ones such as `~/.gnupg`, `~/.netrc`,
 * `~/.docker/config.json`, `~/.kube/config`, `~/.config/gcloud`,
 * `~/.git-credentials`, `~/.npmrc`). A task never needs them: the tools the
 * agent already has (git through the app's credential helper, gh, the file
 * tools) are the supported way to reach remotes.
 *
 * The whole command string is scanned with quotes and backslashes removed, so
 * `cat "~/.ssh/id_rsa"`, `sh -c 'cat ~/.ssh/id_rsa'` and `$(cat ~/.ssh/x)` are
 * all seen. `~`, `$HOME`, `${HOME}` and the real home directory are matched as
 * prefixes.
 *
 * THIS IS A SPEED BUMP, NOT A SECURITY BOUNDARY. Shell indirection evades it:
 * variable assembly (`d=.ssh; cat ~/$d/id_rsa`), `cd ~ && cat .ssh/id_rsa`,
 * base64 or printf-built paths, globbing (`~/.s*h/*`), interpreter one-liners
 * (`python -c`), and script files the agent writes and then runs. It stops the
 * accidental and the lazy case. Real isolation is the opt-in sandbox.
 */

import { homedir } from 'node:os';

import type { ValidationResult } from '../denylist';

interface CredentialClass {
  /** Path relative to the home directory, no leading slash. */
  path: string;
  label: string;
}

const CREDENTIAL_CLASSES: CredentialClass[] = [
  { path: '.ssh', label: 'SSH keys (~/.ssh)' },
  { path: '.aws', label: 'AWS credentials (~/.aws)' },
  { path: '.claude/.credentials.json', label: 'Claude credentials (.credentials.json)' },
  { path: '.config/gh', label: 'GitHub CLI credentials (~/.config/gh)' },
  { path: '.gnupg', label: 'GPG keys (~/.gnupg)' },
  { path: '.netrc', label: 'network credentials (~/.netrc)' },
  { path: '.docker/config.json', label: 'Docker credentials (~/.docker/config.json)' },
  { path: '.kube/config', label: 'Kubernetes credentials (~/.kube/config)' },
  { path: '.config/gcloud', label: 'Google Cloud credentials (~/.config/gcloud)' },
  { path: '.git-credentials', label: 'git credentials (~/.git-credentials)' },
  { path: '.npmrc', label: 'npm credentials (~/.npmrc)' },
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Not followed by more name characters (`.sshfoo`), but `/`, space, end are fine. */
const PATH_END = '(?![\\w.-])';

function buildMatchers(): Array<{ label: string; re: RegExp }> {
  const home = homedir().replace(/\/+$/, '');
  const matchers: Array<{ label: string; re: RegExp }> = [];
  for (const { path, label } of CREDENTIAL_CLASSES) {
    const rel = escapeRegExp(path);
    // ~, $HOME, ${HOME}: must not continue a longer word or path (`./x~/.ssh`).
    matchers.push({
      label,
      re: new RegExp(`(?<![\\w./-])(?:~|\\$HOME|\\$\\{HOME\\})/${rel}${PATH_END}`),
    });
    if (home && home !== '/') {
      matchers.push({
        label,
        re: new RegExp(`(?<![\\w.-])${escapeRegExp(home)}/${rel}${PATH_END}`),
      });
    }
  }
  // CLAUDE_CONFIG_DIR-style: `.credentials.json` under any directory.
  matchers.push({
    label: CREDENTIAL_CLASSES[2].label,
    re: /(?<![\w.-])\.credentials\.json(?![\w-])/,
  });
  return matchers;
}

function refuse(label: string): ValidationResult {
  return [
    false,
    `BLOCKED: This command references ${label}, which holds the developer's credentials.\n\n` +
      `WHAT TO DO: The file is not needed for the task. Use the tools already provided ` +
      `(git and gh are already authenticated, and the Read/Write/Edit tools cover files in ` +
      `the project) instead of reading or copying credentials.`,
  ];
}

/**
 * Refuse a command string that references a credential file or directory.
 * Always on; independent of the landing policy. See the file header: a speed
 * bump that shell indirection can evade.
 */
export function validateCredentialPaths(commandString: string): ValidationResult {
  const stripped = commandString.replace(/['"\\]/g, '');
  for (const { label, re } of buildMatchers()) {
    if (re.test(stripped)) return refuse(label);
  }
  return [true, ''];
}
