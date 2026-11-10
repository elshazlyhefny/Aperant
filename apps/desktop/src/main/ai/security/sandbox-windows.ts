/**
 * Windows "restricted rights" mode for the Bash tool: a restricted token plus a Job object.
 *
 * zeenha fork: a PowerShell launcher (P/Invoke through Add-Type) starts the
 * shell with a restricted copy of the caller's own token and puts it in a Job
 * object.
 *
 * What it does:
 * - Every group except the generic ones (Everyone, Users, Authenticated Users,
 *   Interactive/Service/Batch, Local, Console Logon, This Organization, the
 *   logon SID) becomes deny-only, so Administrators and similar groups can no
 *   longer grant access (they still match deny entries).
 * - All privileges except SeChangeNotifyPrivilege are removed.
 * - Job object: kill-on-job-close (the launcher holds the only handle, so when
 *   it exits or is killed every descendant dies), no breakaway, die on
 *   unhandled exception, and UI restrictions (no clipboard, desktop, global
 *   atoms, system settings, exit-windows or foreign USER handles).
 *
 * What it does NOT do: hide the home directory or block the network. Commands
 * still run as the user and can read and write whatever the user can (outside
 * what Administrators alone could grant). No restricting SIDs are used: CI
 * showed that Git Bash (MSYS2) protects its own IPC objects with the same ACL
 * as the user profile (user, Administrators, SYSTEM), so any restricting list
 * that lets bash start also lets it read the profile. Without restricting SIDs
 * there is nothing extra to grant on the project. AppContainer is not used
 * either: MSYS2 programs die at startup inside one. Low integrity is off: it
 * would also block writes to the project. The home-hidden modes are therefore
 * refused on Windows.
 *
 * All user-controlled values travel in a base64 JSON payload and are never
 * interpolated into script text (see ensureLauncherFile for how it runs).
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findExecutable } from '../../platform/index';
import type { SandboxOptions, SandboxResult } from './sandbox';

export const WINDOWS_HOME_HIDDEN_REFUSAL =
  'The "home hidden" Bash sandbox modes are not supported on Windows: Git Bash cannot run in a sandbox that hides your user profile. Choose "restricted rights" (Windows only; it does not hide your home directory or block the network) or turn the sandbox off.';

export interface WindowsLauncherPayload {
  shell: string;
  args: string[];
  cwd: string;
}

/**
 * zeenha fork: findExecutable() joins each name onto PATH directories and always
 * appends an extension on Windows, so it can resolve neither an absolute path
 * nor "powershell.exe" (it looks for "powershell.exe.exe").
 */
export function findWindowsTool(name: string): string | null {
  if (path.win32.isAbsolute(name)) return existsSync(name) ? name : null;
  return findExecutable(name.replace(/\.exe$/i, ''));
}

/** zeenha fork: resolve powershell.exe from System32, else look it up on PATH. */
export function resolvePowerShell(
  find: (name: string) => string | null = findWindowsTool,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir;
  if (root) {
    const candidate = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (find(candidate)) return candidate;
  }
  return find('powershell.exe');
}

function isSafeAbsolute(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control chars is the point
  if (/[\u0000-\u001f\u007f]/.test(p)) return false;
  return path.win32.isAbsolute(p) && !p.startsWith('\\\\');
}

const LAUNCHER_SCRIPT = String.raw`
param([string]$PayloadB64)
$ErrorActionPreference = 'Stop'
function Fail([string]$m) { [Console]::Error.WriteLine("Aperant Windows sandbox: $m"); exit 125 }
try {
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadB64)) | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class AperantSandbox {
  [StructLayout(LayoutKind.Sequential)] public struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinWs, MaxWs; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct EXT_LIMIT { public BASIC_LIMIT Basic; public IO_COUNTERS Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)] struct UI_LIMIT { public uint UIRestrictionsClass; }

  const uint MAXIMUM_ALLOWED = 0x02000000;
  const uint DISABLE_MAX_PRIVILEGE = 0x1;
  const uint SE_GROUP_INTEGRITY_ANY = 0x60;
  const uint SE_GROUP_LOGON_ID = 0xC0000000;
  // KILL_ON_JOB_CLOSE | DIE_ON_UNHANDLED_EXCEPTION. No BREAKAWAY_OK / SILENT_BREAKAWAY_OK.
  const uint JOB_LIMIT_FLAGS = 0x2000 | 0x400;
  // HANDLES | READCLIPBOARD | WRITECLIPBOARD | SYSTEMPARAMETERS | DISPLAYSETTINGS | GLOBALATOMS | DESKTOP | EXITWINDOWS
  const uint JOB_UI_LIMITS = 0xFF;
  static readonly string[] KEEP = { "S-1-1-0", "S-1-5-32-545", "S-1-5-11", "S-1-5-4", "S-1-5-6", "S-1-5-3", "S-1-2-0", "S-1-2-1", "S-1-5-15" };

  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr proc, uint access, out IntPtr tok);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr tok, int cls, IntPtr buf, int len, out int ret);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetTokenInformation(IntPtr tok, int cls, IntPtr buf, int len);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr tok, uint flags, uint denyCount, SID_AND_ATTRIBUTES[] deny, uint privCount, IntPtr privs, uint restrictCount, SID_AND_ATTRIBUTES[] restrict, out IntPtr newTok);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr str);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint rev, out IntPtr sd, IntPtr size);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetSecurityDescriptorDacl(IntPtr sd, out int present, out IntPtr dacl, out int defaulted);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessAsUserW(IntPtr tok, string app, StringBuilder cmd, ref SECURITY_ATTRIBUTES pa, ref SECURITY_ATTRIBUTES ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr a, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXT_LIMIT info, int len);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref UI_LIMIT info, int len);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);

  static Exception Win32(string what) { return new Exception(what + " failed: " + Marshal.GetLastWin32Error()); }
  static string SidString(IntPtr sid) {
    IntPtr s; if (!ConvertSidToStringSidW(sid, out s)) throw Win32("ConvertSidToStringSid");
    string r = Marshal.PtrToStringUni(s); LocalFree(s); return r;
  }
  static IntPtr TokenInfo(IntPtr tok, int cls) {
    int len; GetTokenInformation(tok, cls, IntPtr.Zero, 0, out len);
    IntPtr buf = Marshal.AllocHGlobal(len);
    if (!GetTokenInformation(tok, cls, buf, len, out len)) throw Win32("GetTokenInformation");
    return buf;
  }
  static SID_AND_ATTRIBUTES Entry(IntPtr sid) { SID_AND_ATTRIBUTES e = new SID_AND_ATTRIBUTES(); e.Sid = sid; e.Attributes = 0; return e; }

  public static int Run(string exe, string cmdline, string cwd) {
    IntPtr tok;
    if (!OpenProcessToken(GetCurrentProcess(), MAXIMUM_ALLOWED, out tok)) throw Win32("OpenProcessToken");
    string userSid = SidString(Marshal.ReadIntPtr(TokenInfo(tok, 1)));
    IntPtr groups = TokenInfo(tok, 2);
    int count = Marshal.ReadInt32(groups);
    int sz = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
    List<SID_AND_ATTRIBUTES> deny = new List<SID_AND_ATTRIBUTES>();
    for (int i = 0; i < count; i++) {
      SID_AND_ATTRIBUTES g = (SID_AND_ATTRIBUTES)Marshal.PtrToStructure(IntPtr.Add(groups, IntPtr.Size + i * sz), typeof(SID_AND_ATTRIBUTES));
      if ((g.Attributes & SE_GROUP_INTEGRITY_ANY) != 0) continue;
      bool logon = (g.Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID;
      if (!logon && Array.IndexOf(KEEP, SidString(g.Sid)) < 0) deny.Add(Entry(g.Sid));
    }
    // No restricting SIDs: Git Bash cannot start with any list that would hide the profile.
    IntPtr rtok;
    if (!CreateRestrictedToken(tok, DISABLE_MAX_PRIVILEGE, (uint)deny.Count, deny.ToArray(), 0, IntPtr.Zero, 0, null, out rtok)) throw Win32("CreateRestrictedToken");

    // An elevated caller's default DACL grants only Administrators and SYSTEM;
    // Administrators is deny-only now, so grant the user SID on new objects and
    // processes, or the shell could not open its own child processes.
    IntPtr sd;
    string sddl = "D:(A;;GA;;;SY)(A;;GA;;;" + userSid + ")";
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, IntPtr.Zero)) throw Win32("ConvertStringSecurityDescriptor");
    int present, defaulted; IntPtr dacl;
    if (!GetSecurityDescriptorDacl(sd, out present, out dacl, out defaulted)) throw Win32("GetSecurityDescriptorDacl");
    IntPtr defaultDacl = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(defaultDacl, dacl);
    if (!SetTokenInformation(rtok, 6, defaultDacl, IntPtr.Size)) throw Win32("SetTokenInformation(TokenDefaultDacl)");

    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw Win32("CreateJobObject");
    EXT_LIMIT lim = new EXT_LIMIT(); lim.Basic.LimitFlags = JOB_LIMIT_FLAGS;
    if (!SetInformationJobObject(job, 9, ref lim, Marshal.SizeOf(typeof(EXT_LIMIT)))) throw Win32("SetInformationJobObject(limits)");
    UI_LIMIT ui = new UI_LIMIT(); ui.UIRestrictionsClass = JOB_UI_LIMITS;
    if (!SetInformationJobObject(job, 4, ref ui, Marshal.SizeOf(typeof(UI_LIMIT)))) throw Win32("SetInformationJobObject(UI)");

    SECURITY_ATTRIBUTES pa = new SECURITY_ATTRIBUTES(); pa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)); pa.lpSecurityDescriptor = sd;
    SECURITY_ATTRIBUTES ta = pa;
    STARTUPINFO si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO)); si.dwFlags = 0x100;
    si.hStdInput = GetStdHandle(-10); si.hStdOutput = GetStdHandle(-11); si.hStdError = GetStdHandle(-12);
    foreach (IntPtr h in new IntPtr[] { si.hStdInput, si.hStdOutput, si.hStdError }) { SetHandleInformation(h, 1, 1); }
    PROCESS_INFORMATION pi;
    if (!CreateProcessAsUserW(rtok, exe, new StringBuilder(cmdline), ref pa, ref ta, true, 0x4u, IntPtr.Zero, cwd, ref si, out pi)) throw Win32("CreateProcessAsUser");
    if (!AssignProcessToJobObject(job, pi.hProcess)) { TerminateProcess(pi.hProcess, 1); throw Win32("AssignProcessToJobObject"); }
    ResumeThread(pi.hThread);
    WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
    uint code; GetExitCodeProcess(pi.hProcess, out code);
    // The job handle closes when this launcher exits, killing any leftover descendants.
    return unchecked((int)code);
  }
}
'@
function Quote([string]$a) {
  if ($a.Length -gt 0 -and $a -notmatch '[\s"]') { return $a }
  $s = [regex]::Replace($a, '(\\*)"', { param($m) ($m.Groups[1].Value * 2) + '\"' })
  $s = [regex]::Replace($s, '(\\+)$', { param($m) $m.Groups[1].Value * 2 })
  return '"' + $s + '"'
}
$cmd = (@($p.shell) + @($p.args) | ForEach-Object { Quote ([string]$_) }) -join ' '
$code = [AperantSandbox]::Run($p.shell, $cmd, $p.cwd)
exit $code
} catch { Fail $_.Exception.Message }
`;

export const LAUNCHER_SHA256 = createHash('sha256').update(LAUNCHER_SCRIPT, 'utf8').digest('hex');

/**
 * zeenha fork: private per-user directory for the launcher script, outside the
 * shared temp directory: %LOCALAPPDATA%\Aperant\bash-sandbox (owner-only mode
 * where the OS honours it).
 */
export function defaultLauncherDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'Aperant', 'bash-sandbox');
}

/**
 * zeenha fork: the launcher script is static, so it is written once to a file
 * named after its hash and rewritten if its content differs. It is written to
 * an unpredictable name with an exclusive create, then renamed into place.
 * The file is not trusted when it runs: the bootstrap reads it once, checks its
 * SHA-256 against LAUNCHER_SHA256 and runs exactly the text it checked, so a
 * replaced file is refused instead of executed (the restricted-rights mode does
 * not stop a sandboxed command from writing in the user's profile).
 * A short -Command bootstrap keeps long commands well under the
 * 32767-character command-line limit, which an -EncodedCommand carrying the
 * whole script would exceed, and a script block is not subject to the
 * execution policy.
 */
export function ensureLauncherFile(dir: string = defaultLauncherDir()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `launcher-${LAUNCHER_SHA256.slice(0, 16)}.ps1`);
  let current: string | null = null;
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    current = null;
  }
  if (current !== LAUNCHER_SCRIPT) {
    const tmp = path.join(dir, `.launcher-${randomBytes(12).toString('hex')}.tmp`);
    writeFileSync(tmp, LAUNCHER_SCRIPT, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(tmp, file);
  }
  return file;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** zeenha fork: the -Command text that verifies and runs the launcher file with the payload. */
export function renderBootstrap(launcherFile: string, payload: WindowsLauncherPayload): string {
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return [
    `$t = [IO.File]::ReadAllText(${psQuote(launcherFile)})`,
    `$h = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($t)))) -replace '-', ''`,
    `if ($h -ne '${LAUNCHER_SHA256}') { [Console]::Error.WriteLine('Aperant Windows sandbox: launcher script was modified; refusing to run'); exit 125 }`,
    `& ([scriptblock]::Create($t)) '${b64}'`,
  ].join('; ');
}

export function buildWindows(
  shell: string,
  shellArgs: string[],
  opts: SandboxOptions,
  powershell: string
): SandboxResult {
  if (opts.mode !== 'restricted-rights') {
    return { ok: false, reason: WINDOWS_HOME_HIDDEN_REFUSAL };
  }
  for (const p of [shell, opts.cwd]) {
    if (!isSafeAbsolute(p)) {
      return { ok: false, reason: `Windows sandbox refused: path is not absolute or contains unsafe characters: ${JSON.stringify(p)}` };
    }
  }
  for (const a of shellArgs) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL check
    if (typeof a !== 'string' || /\u0000/.test(a)) {
      return { ok: false, reason: 'Windows sandbox refused: argument contains a NUL character.' };
    }
  }

  let launcherFile: string;
  try {
    launcherFile = ensureLauncherFile(opts.launcherDir);
  } catch (err) {
    return { ok: false, reason: `Windows sandbox refused: could not write the launcher script: ${(err as Error).message}` };
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control chars is the point
  if (/["\u0000-\u001f]/.test(launcherFile)) {
    return { ok: false, reason: 'Windows sandbox refused: the launcher directory path contains unsafe characters.' };
  }
  const bootstrap = renderBootstrap(launcherFile, { shell, args: shellArgs, cwd: opts.cwd });
  return {
    ok: true,
    file: powershell,
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', bootstrap],
  };
}
