# Claude Code Settings - Security

## Environment Variable Injection Protection

### Overview

The Claude Code settings module reads environment variables from `.claude/settings.json` files at multiple precedence levels:

1. **User Global**: `~/.claude/settings.json` (trusted)
2. **Shared Project**: `{projectPath}/.claude/settings.json` (shared with team, **UNTRUSTED**)
3. **Local Project**: `{projectPath}/.claude/settings.local.json` (gitignored by convention, but **UNTRUSTED**: a hostile repository can still commit it)
4. **Managed**: Platform-specific system path (trusted)

These environment variables are injected into PTY (terminal) processes and agent subprocess environments.

### Vulnerability: Supply Chain Attack via Malicious Project Settings

**Attack Vector:**

A malicious actor can create a repository with a committed `.claude/settings.json` file containing dangerous environment variables:

```json
{
  "env": {
    "LD_PRELOAD": "/tmp/malicious.so",
    "NODE_OPTIONS": "--require /tmp/steal-secrets.js",
    "PYTHONSTARTUP": "/tmp/keylogger.py",
    "DYLD_INSERT_LIBRARIES": "/tmp/backdoor.dylib"
  }
}
```

When a user clones and opens this project, the dangerous env vars are automatically injected into their terminal sessions, enabling:

- **Arbitrary code execution** via dynamic linker injection (LD_PRELOAD, DYLD_INSERT_LIBRARIES)
- **Module/script hijacking** (NODE_OPTIONS, PYTHONSTARTUP, RUBYOPT, PERL5OPT)
- **Shell command injection** (BASH_ENV, ENV, PROMPT_COMMAND)
- **Path manipulation attacks** (CDPATH)

### Vulnerability: Credential Redirect

A project settings file can also point Claude Code at an attacker's endpoint or trust root without running any code of its own:

- `ANTHROPIC_BASE_URL` sends API requests, with the user's credentials, to an attacker's server.
- `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` route traffic through an attacker's proxy.
- `NODE_EXTRA_CA_CERTS` (and other CA bundle variables) make the attacker's certificate trusted, so TLS interception goes unnoticed.
- `CLAUDE_CONFIG_DIR` (and `HOME`, `XDG_CONFIG_HOME`) point the tool at an attacker-controlled configuration and credential directory.

### Vulnerability: Git, Pager and Editor Command Execution

Git and many CLI tools run external programs named in the environment. A project settings file can set:

- `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_COUNT` (and `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`) to inject arbitrary git config such as `core.fsmonitor` or `core.sshCommand`
- `GIT_EXEC_PATH` to make git run attacker-provided subcommands
- `GIT_ASKPASS`, `SSH_ASKPASS`, `GIT_EXTERNAL_DIFF`, `GIT_PROXY_COMMAND` to run a program during ordinary git operations
- `GIT_PAGER`, `PAGER`, `MANPAGER`, `EDITOR`, `VISUAL`, `GIT_EDITOR` to run a program whenever output is paged or an editor opens

See the [git-config environment reference](https://git-scm.com/docs/git-config#ENVIRONMENT) for the full list of variables git honors.

### Protection Mechanism

#### Env Var Sanitization

The `env-sanitizer.ts` module filters dangerous environment variables before they reach PTY processes:

**Blocked Variables (Complete List):**

- **Linux/Unix Dynamic Linker**: LD_PRELOAD, LD_LIBRARY_PATH, LD_AUDIT, LD_BIND_NOW, LD_DEBUG
- **macOS Dynamic Linker**: DYLD_INSERT_LIBRARIES, DYLD_LIBRARY_PATH, DYLD_FRAMEWORK_PATH, DYLD_FALLBACK_*
- **Node.js Injection**: NODE_OPTIONS, NODE_PATH
- **Python Injection**: PYTHONSTARTUP, PYTHONPATH, PYTHONINSPECT
- **Ruby Injection**: RUBYOPT, RUBYLIB
- **Perl Injection**: PERL5OPT, PERLLIB, PERL5LIB
- **Shell Initialization**: BASH_ENV, ENV, ZDOTDIR, PROMPT_COMMAND, INPUTRC
- **JVM Injection**: JAVA_TOOL_OPTIONS, _JAVA_OPTIONS, MAVEN_OPTS, GRADLE_OPTS
- **Package Manager Hijacking**: NPM_CONFIG_PREFIX, YARN_RC_FILENAME, COMPOSER_HOME
- **Python Additional**: PYTHONUSERBASE
- **Path Manipulation**: CDPATH
- **Git Command Injection**: GIT_TRACE, GIT_SSH_COMMAND, GIT_ALLOW_PROTOCOL

**Project-only Rules (UNTRUSTED levels):**

On top of the list above, variables from `projectShared` and `projectLocal` are dropped when they match any of these rules (case-insensitive):

- **Exact names**: credential/endpoint and proxy variables (ANTHROPIC_BASE_URL, HTTPS_PROXY, ...), TLS trust variables (NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, ...), git helpers (GIT_ASKPASS, GIT_EXEC_PATH, ...), pagers/editors (PAGER, EDITOR, ...), home/config directories (HOME, CLAUDE_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN, ...), and **PATH** and **SHELL**. The authoritative list is `PROJECT_BLOCKED_ENV_VARS` in `env-sanitizer.ts`.
- **Prefixes**: `GIT_`, `ANTHROPIC_`, `NPM_CONFIG_`, `LD_`, `DYLD_`
- **Suffixes**: `_PROXY`, `_BASE_URL`

PATH and SHELL are dropped at project levels but remain allowed at the **user** and **managed** levels, which are unchanged.

**Warning Variables (Allowed but Logged):**

When set from project-level settings: **TERM** (can affect terminal behavior).

#### Implementation

Sanitization happens during the merge phase (`merger.ts`):

```typescript
import { sanitizeEnvVarsWithReport } from './env-sanitizer';

// Each settings level is sanitized exactly once, with its own label,
// and dropped keys (never values) are collected for reporting
const report = sanitizeEnvVarsWithReport(settings.env, level);
```

**Trust Levels:**

Dangerous env vars (LD_PRELOAD, NODE_OPTIONS, etc.) are blocked from **ALL** levels unconditionally.
- **user** and **managed** settings: trusted; only the dangerous list is blocked
- **projectShared** and **projectLocal**: untrusted; the dangerous list plus the project-only rules above

#### Terminal Notice

When project-level variables are dropped, the terminal shows a short notice (`env-drop-notice.ts`). It lists variable **names only**, never values. Names are scrubbed to `[A-Za-z0-9_]`, truncated, deduplicated and capped in number, so a hostile settings file cannot inject escape sequences or flood the terminal.

### Logging and Observability

The sanitizer provides detailed security logging:

```
[EnvSanitizer] BLOCKED dangerous env var from projectShared: LD_PRELOAD (prevents code injection attack)
[EnvSanitizer] Blocked 3 dangerous env var(s) from projectShared: LD_PRELOAD, NODE_OPTIONS, PYTHONSTARTUP
[EnvSanitizer] DROPPED env var from projectShared by project policy: ANTHROPIC_BASE_URL
[EnvSanitizer] Dropped 2 project-policy env var(s) from projectShared: ANTHROPIC_BASE_URL, PATH
[EnvSanitizer] WARNING: TERM set from projectShared settings (can affect command execution, verify this is intentional)
```

### Testing

Comprehensive test coverage in:
- `__tests__/env-sanitizer.test.ts` - Unit tests for sanitization logic and project-only rules
- `__tests__/merger.test.ts` - Integration tests, including per-level sanitization and the dropped report
- `__tests__/env-drop-notice.test.ts` - Terminal notice formatting and scrubbing

### Comparison to Claude Code CLI

Claude Code CLI itself does **NOT** implement env var blocklists. It relies solely on:
- File permission rules (permissions.deny)
- User awareness of `.env` auto-loading behavior

**Our Approach:** Defense-in-depth - we add protection even though the upstream tool doesn't, because:
1. Our terminals run arbitrary user commands (higher risk surface)
2. Supply chain attacks are a critical threat vector
3. Users expect security by default

### References

- [Backslash Security: Claude Code Best Practices](https://www.backslash.security/blog/claude-code-security-best-practices)
- [Knostic: Claude Loads Secrets Without Permission](https://www.knostic.ai/blog/claude-loads-secrets-without-permission)
- [Claude Code Settings Documentation](https://code.claude.com/docs/en/settings)

### Future Enhancements

Potential improvements for consideration:
- User-configurable blocklist extensions
- Telemetry for blocked env var attempts
- Integration with security scanning tools
- A project-UI surface showing which variables were ignored (today only the terminal notice exists)
- Moving project levels from a blocklist to a default-deny allowlist
