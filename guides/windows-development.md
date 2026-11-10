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

On Windows the Bash sandbox offers one mode, `restricted-rights` ("Restricted rights"). It starts Git Bash with a restricted copy of your own token and puts it in a Job object (see `apps/desktop/src/main/ai/security/sandbox-windows.ts`).

| Mode | Windows behaviour |
|---|---|
| `off` | Commands run with your full rights. |
| `restricted-rights` | Administrators and every other non-generic group become deny-only. Every privilege except `SeChangeNotifyPrivilege` is removed. The Job object stops every process the command started when the command ends or is killed, does not allow breakaway, and blocks clipboard, desktop and other UI access. **It does not hide your home directory and does not block the network.** Commands still run as you and can read and write everything your account can. |
| `home-hidden`, `home-hidden-no-network` | Refused. Every agent shell command fails while one of these is selected, and the settings page shows "Mode not supported here". |

**Why the home-hidden modes are refused.** Git Bash (MSYS2) protects its own pipes and shared memory with an access list for your user, Administrators and SYSTEM. Your profile folder has the same access list. A restricted token that lets Git Bash open its own objects can therefore also read your profile. An AppContainer is no better, because MSYS2 programs die at startup inside one. Low integrity is not used either, because it would also block writes to the project.

**How the launcher runs.** The launcher script is written to `%LOCALAPPDATA%\Aperant\bash-sandbox`. Before running it, the PowerShell bootstrap checks the script's SHA-256, so a script changed by a sandboxed command is refused instead of run.

**Prerequisites:** Windows 10/11, Git for Windows (Git Bash) and PowerShell 5.1 or newer.

**Enable it:** open the project settings and choose "Restricted rights (Windows only)". Then ask an agent to run the commands below, or run the automated test: `cd apps/desktop && npx vitest run src/main/ai/security/__tests__/sandbox-windows.integration.test.ts`.

| Command (in the sandboxed shell) | Expected output |
|---|---|
| `npm test` in the worktree | Runs and passes |
| `whoami.exe /groups` | `BUILTIN\Administrators` shows `Group used for deny only` (when your account is an administrator) |
| `whoami.exe /priv` | Only `SeChangeNotifyPrivilege` |
| `(sleep 5; touch late.txt) &` | `late.txt` never appears: the background process is stopped when the command ends |

**Known limits**

- This mode is not a security boundary between the agent and your files or your other processes. It drops administrator rights and cleans up processes, nothing more.
- It is not a defence against a kernel exploit.

## Resources

- [Node.js on Windows](https://nodejs.org/en/download/)
- [Git for Windows](https://gitforwindows.org/)
- [WSL2 Documentation](https://docs.microsoft.com/en-us/windows/wsl/)

## Related

- [CONTRIBUTING.md](../CONTRIBUTING.md) - General contribution guidelines
