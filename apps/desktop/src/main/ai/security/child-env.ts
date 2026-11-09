/**
 * Child Environment Scrubber
 * ==========================
 *
 * Builds an environment for child processes (Bash tool, Claude CLI, MCP
 * servers) with developer credentials removed. Pure module: no electron
 * imports, because it runs inside worker threads.
 */

/** Name patterns (matched case-insensitively) identifying credential variables. */
export const CREDENTIAL_ENV_PATTERNS: readonly RegExp[] = [
  // Generic suffixes
  /_TOKEN$/i,
  /_API_KEY$/i,
  /_SECRET$/i,
  /_PASSWORD$/i,
  /_PASSWD$/i,
  /_CREDENTIALS$/i,
  /_ACCESS_KEY$/i,
  /_PRIVATE_KEY$/i,
  // Known credential families
  /^AWS_/i,
  /^AZURE_/i,
  /^OPENAI_/i,
  /^GOOGLE_APPLICATION_CREDENTIALS$/i,
  /^GCP_/i,
  /^GCLOUD_/i,
  /^CLOUDSDK_AUTH/i,
  /^GITHUB_TOKEN$/i,
  /^GH_TOKEN$/i,
  /^GH_ENTERPRISE_TOKEN$/i,
  /^GITLAB_TOKEN$/i,
  /^NPM_TOKEN$/i,
  /^SSH_AUTH_SOCK$/i,
  /^ANTHROPIC_API_KEY$/i,
  /^ANTHROPIC_AUTH_TOKEN$/i,
  /^CLAUDE_CODE_OAUTH_TOKEN$/i,
  /^(API_KEY|SECRET_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD)$/i,
];

/** Basic runtime variables that are never removed (case-insensitive). */
export const SAFE_ENV_NAMES: ReadonlySet<string> = new Set(
  [
    'PATH',
    'HOME',
    'USER',
    'USERNAME',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LANGUAGE',
    'TERM',
    'TMPDIR',
    'TEMP',
    'TMP',
    'PWD',
    'OLDPWD',
    'SYSTEMROOT',
    'COMSPEC',
    'PATHEXT',
    'WINDIR',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'HOMEDRIVE',
    'HOMEPATH',
    'COMPUTERNAME',
    'TZ',
    'DISPLAY',
    'COLORTERM',
    'EDITOR',
    'NODE_ENV',
    'XDG_RUNTIME_DIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
  ].map((n) => n.toUpperCase()),
);

const SAFE_ENV_PREFIXES: readonly string[] = ['LC_'];

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface BuildChildEnvOptions {
  /** Per-project names that are always kept. */
  passthrough?: readonly string[];
  /** Additional names that are always kept. */
  keep?: readonly string[];
}

function isSafeName(upper: string): boolean {
  return SAFE_ENV_NAMES.has(upper) || SAFE_ENV_PREFIXES.some((p) => upper.startsWith(p));
}

/**
 * Return a copy of `base` with credential variables removed.
 * The input object is never mutated.
 */
export function buildChildEnv(
  base: NodeJS.ProcessEnv = process.env,
  options?: BuildChildEnvOptions,
): NodeJS.ProcessEnv {
  const kept = new Set<string>();
  for (const name of options?.passthrough ?? []) kept.add(name.toUpperCase());
  for (const name of options?.keep ?? []) kept.add(name.toUpperCase());

  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    const upper = name.toUpperCase();
    if (
      kept.has(upper) ||
      isSafeName(upper) ||
      !CREDENTIAL_ENV_PATTERNS.some((re) => re.test(name))
    ) {
      result[name] = value;
    }
  }
  return result;
}

/**
 * Sanitise a project-settings value into a list of valid env var names:
 * trimmed, de-duplicated, non-strings and invalid names dropped.
 */
export function parseEnvPassthrough(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (!ENV_NAME_RE.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
