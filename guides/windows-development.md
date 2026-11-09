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

On Windows the Bash sandbox runs commands inside an AppContainer that cannot read the user profile.

**Prerequisites:** Windows 10/11, Git for Windows (Git Bash), PowerShell 5.1 or newer, and Node.js installed system-wide (for example under `C:\Program Files`).

**Enable it:** open the project settings and set `bashSandbox` to `home-hidden` (or `home-hidden-no-network`). Then ask an agent to run the commands below, or run the automated test: `cd apps/desktop && npx vitest run src/main/ai/security/__tests__/sandbox-windows.integration.test.ts`.

| Command (in the sandboxed shell) | Expected output |
|---|---|
| `type %USERPROFILE%\canary.txt` (create the file first) | Access denied; the file contents are not printed |
| `dir %APPDATA%` | Access denied or an empty listing |
| `npm test` in the worktree | Runs and passes; the worktree is readable and writable |
| `curl https://example.com` in `home-hidden-no-network` | Fails to connect (no network capability) |

**Known limits**

- Tools installed under the user profile (nvm, per-user Node, per-user Git) are not readable. Install them system-wide, or add the install directory as a writable/readable path.
- The sandbox limits file and network access. It is not a defence against a kernel exploit.

## Resources

- [Node.js on Windows](https://nodejs.org/en/download/)
- [Git for Windows](https://gitforwindows.org/)
- [WSL2 Documentation](https://docs.microsoft.com/en-us/windows/wsl/)

## Related

- [CONTRIBUTING.md](../CONTRIBUTING.md) - General contribution guidelines
