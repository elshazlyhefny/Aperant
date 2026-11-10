# Windows Development Guide

This guide covers Windows-specific considerations when developing Auto Claude.

## Setup

Auto Claude downloads prebuilt native binaries for `node-pty` on Windows automatically. If prebuilts are not available for your Electron version, you will need Visual Studio Build Tools:

1. Download [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
2. Select the "Desktop development with C++" workload
3. In "Individual Components", add "MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs"
4. Restart your terminal and run `npm install` again inside `apps/desktop/`

## Line Endings

Windows uses CRLF (`\r\n`) line endings while macOS/Linux use LF (`\n`). This can cause git diffs to show every line changed.

Configure git to handle line endings:

```bash
git config --global core.autocrlf true
```

The project's `.gitattributes` handles this automatically for tracked files.

## Path Separators

TypeScript code should use `path.join()` or `path.posix.join()` rather than hardcoded forward or back slashes. The platform abstraction layer in `apps/desktop/src/main/platform/` provides cross-platform helpers — always use those instead of `process.platform` directly.

## Shell Commands

The Bash tool in the AI agent layer validates commands against the denylist and per-command validators defined in `apps/desktop/src/main/ai/security/`. On Windows, `.cmd` and `.bat` files require `shell: true` — the platform module's `requiresShell()` helper handles this automatically.

## Testing Windows Compatibility

CI runs all three platforms (Ubuntu, Windows, macOS) on every PR. To test locally on Windows:

```bash
cd apps/desktop

# Run unit tests
npm test

# Run type checking
npm run typecheck

# Run linter
npm run lint
```

## Common Issues

### Permission errors when deleting files

Windows file locking is stricter than Unix. Ensure streams and file handles are properly closed before attempting to delete or overwrite files.

### Long path names

Windows has a 260-character path limit by default. Enable long paths:

1. Open Group Policy Editor (`gpedit.msc`)
2. Navigate to: Local Computer Policy > Computer Configuration > Administrative Templates > System > Filesystem
3. Enable "Enable Win32 long paths"

Or use WSL2 to avoid the issue entirely.

### Case-insensitive filesystem

Windows filesystems are case-insensitive. Be consistent with casing in import paths — a mismatch that works on Windows will fail on Linux CI.

## Testing the Bash sandbox

On Windows the Bash sandbox starts Git Bash with a restricted copy of your own token and puts it in a Job object (see `apps/desktop/src/main/ai/security/sandbox-windows.ts`).

**What it guarantees in `home-hidden` mode**

- Files that only your account can open, which is your whole user profile (SSH keys, tokens, other projects), cannot be read or written. The token's restricting SIDs do not include your user SID, so a second access check fails for them. The project paths are opened up by granting a fixed sandbox SID on them, and `~/.gitconfig` and `~/.config/git` are granted read so git keeps your identity.
- Administrators and every other non-generic group are deny-only, and every privilege except `SeChangeNotifyPrivilege` is removed.
- The Job object kills every remaining process when the command ends or is killed, does not allow breakaway, and blocks clipboard, desktop and other UI access.
- `TEMP` and `TMP` point to `%TEMP%\aperant-bash-sandbox`, the only temp folder the sandbox can write.

**What it does not do**

- `home-hidden-no-network` is refused: neither a restricted token nor a Job object can block network access, so every agent shell command fails closed in that mode. Choose `home-hidden` instead.
- Low integrity is not used. It would block only writes, not reads, and the worktree would have to be relabelled. As a result, folders that every user may write to (for example `C:\ProgramData` or `C:\Users\Public`) stay writable, and files that grant `Users` or `Everyone` read stay readable.
- The access grants are written into the ACLs of the project folders and the git config files and stay there. They only apply to processes started by the sandbox.

**Prerequisites:** Windows 10/11, Git for Windows (Git Bash), PowerShell 5.1 or newer, and Node.js installed system-wide (for example under `C:\Program Files`).

**Enable it:** open the project settings and set `bashSandbox` to `home-hidden`. Then ask an agent to run the commands below, or run the automated test: `cd apps/desktop && npx vitest run src/main/ai/security/__tests__/sandbox-windows.integration.test.ts`.

| Command (in the sandboxed shell) | Expected output |
|---|---|
| `cat ~/canary.txt` (create the file first) | `Permission denied`; the file contents are not printed |
| `echo x > ~/probe.txt` | `Permission denied` |
| `npm test` in the worktree | Runs and passes; the worktree is readable and writable |
| `whoami.exe /groups` | `BUILTIN\Administrators` shows `Group used for deny only` |

**Known limits**

- Tools installed under the user profile (nvm, per-user Node, per-user Git) are not readable. Install them system-wide, or add the install directory as a writable path.
- Links from the worktree to folders inside your profile (for example a linked `node_modules`) are not readable unless the target is added as a writable path.
- The sandbox limits file access. It is not a defence against a kernel exploit.

## Resources

- [Node.js on Windows](https://nodejs.org/en/download/)
- [Git for Windows](https://gitforwindows.org/)
- [WSL2 Documentation](https://docs.microsoft.com/en-us/windows/wsl/)

## Related

- [CONTRIBUTING.md](../CONTRIBUTING.md) - General contribution guidelines
