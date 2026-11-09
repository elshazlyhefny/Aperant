/**
 * Windows AppContainer sandbox for the Bash tool.
 *
 * zeenha fork: the shell is started inside an AppContainer by a PowerShell
 * launcher. The container SID is granted access only to the allowed paths, so
 * the user profile (credentials) is unreadable. The home directory is never
 * granted. All user-controlled values travel in a base64 JSON payload and are
 * never interpolated into script text.
 */

import * as path from 'node:path';
import type { SandboxOptions, SandboxResult } from './sandbox';

export const APPCONTAINER_NAME = 'aperant.bash-sandbox';
const CAP_INTERNET_CLIENT = 'S-1-15-3-1';
const CAP_PRIVATE_NETWORK = 'S-1-15-3-3';

export interface WindowsLauncherPayload {
  name: string;
  shell: string;
  args: string[];
  cwd: string;
  rwPaths: string[];
  shellDir: string;
  capabilities: string[];
}

/** zeenha fork: resolve powershell.exe from System32, else look it up on PATH. */
export function resolvePowerShell(
  find: (name: string) => string | null,
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
$ErrorActionPreference = 'Stop'
function Fail([string]$m) { [Console]::Error.WriteLine("Aperant Windows sandbox: $m"); exit 125 }
try {
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__')) | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class AperantSandbox {
  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinWs, MaxWs; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct EXT_LIMIT { public BASIC_LIMIT Basic; public IO_COUNTERS Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string display, string desc, IntPtr caps, uint capCount, out IntPtr sid);
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSidToSid(string s, out IntPtr sid);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr str);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr l, int n, int f, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr l, uint f, IntPtr a, IntPtr v, IntPtr sz, IntPtr pv, IntPtr pr);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr a, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXT_LIMIT info, int len);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);

  public static string ContainerSid(string name) {
    IntPtr sid;
    int hr = CreateAppContainerProfile(name, name, name, IntPtr.Zero, 0, out sid);
    if (hr == unchecked((int)0x800700B7)) { hr = DeriveAppContainerSidFromAppContainerName(name, out sid); }
    if (hr != 0) throw new Exception("AppContainer profile failed: 0x" + hr.ToString("X8"));
    IntPtr s; if (!ConvertSidToStringSid(sid, out s)) throw new Exception("SID conversion failed");
    string r = Marshal.PtrToStringUni(s); LocalFree(s); return r;
  }
  static IntPtr Sid(string s) { IntPtr sid; if (!ConvertStringSidToSid(s, out sid)) throw new Exception("Bad SID " + s); return sid; }

  public static int Run(string appSid, string[] capSids, string exe, string cmdline, string cwd) {
    IntPtr container = Sid(appSid);
    int n = capSids.Length;
    int sz = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
    IntPtr capArr = n > 0 ? Marshal.AllocHGlobal(sz * n) : IntPtr.Zero;
    for (int i = 0; i < n; i++) { SID_AND_ATTRIBUTES sa = new SID_AND_ATTRIBUTES(); sa.Sid = Sid(capSids[i]); sa.Attributes = 4; Marshal.StructureToPtr(sa, IntPtr.Add(capArr, i * sz), false); }
    SECURITY_CAPABILITIES sc = new SECURITY_CAPABILITIES(); sc.AppContainerSid = container; sc.Capabilities = capArr; sc.CapabilityCount = (uint)n;
    IntPtr scPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES))); Marshal.StructureToPtr(sc, scPtr, false);
    IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
    IntPtr list = Marshal.AllocHGlobal(size);
    if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) throw new Exception("InitializeProcThreadAttributeList failed");
    if (!UpdateProcThreadAttribute(list, 0, (IntPtr)0x20009, scPtr, (IntPtr)Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)), IntPtr.Zero, IntPtr.Zero)) throw new Exception("UpdateProcThreadAttribute failed: " + Marshal.GetLastWin32Error());
    STARTUPINFOEX si = new STARTUPINFOEX(); si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX)); si.lpAttributeList = list;
    si.StartupInfo.dwFlags = 0x100;
    si.StartupInfo.hStdInput = GetStdHandle(-10); si.StartupInfo.hStdOutput = GetStdHandle(-11); si.StartupInfo.hStdError = GetStdHandle(-12);
    foreach (IntPtr h in new IntPtr[] { si.StartupInfo.hStdInput, si.StartupInfo.hStdOutput, si.StartupInfo.hStdError }) { SetHandleInformation(h, 1, 1); }
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Exception("CreateJobObject failed");
    EXT_LIMIT lim = new EXT_LIMIT(); lim.Basic.LimitFlags = 0x2000;
    if (!SetInformationJobObject(job, 9, ref lim, Marshal.SizeOf(typeof(EXT_LIMIT)))) throw new Exception("SetInformationJobObject failed");
    PROCESS_INFORMATION pi;
    if (!CreateProcessW(exe, new StringBuilder(cmdline), IntPtr.Zero, IntPtr.Zero, true, 0x80004u, IntPtr.Zero, cwd, ref si, out pi)) throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error());
    if (!AssignProcessToJobObject(job, pi.hProcess)) { TerminateProcess(pi.hProcess, 1); throw new Exception("AssignProcessToJobObject failed"); }
    ResumeThread(pi.hThread);
    WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
    uint code; GetExitCodeProcess(pi.hProcess, out code);
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
$sid = [AperantSandbox]::ContainerSid($p.name)
foreach ($d in @($p.rwPaths)) {
  & icacls.exe $d /grant ('*' + $sid + ':(OI)(CI)F') /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "could not grant access to $d" }
}
$acl = (& icacls.exe $p.shellDir 2>&1 | Out-String)
if ($acl -notmatch 'ALL APPLICATION PACKAGES' -and $acl -notmatch 'S-1-15-2-1\b') {
  & icacls.exe $p.shellDir /grant ('*' + $sid + ':(OI)(CI)RX') /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "could not grant read access to $($p.shellDir)" }
}
$cmd = (@($p.shell) + @($p.args) | ForEach-Object { Quote ([string]$_) }) -join ' '
$code = [AperantSandbox]::Run($sid, [string[]]@($p.capabilities), $p.shell, $cmd, $p.cwd)
exit $code
} catch { Fail $_.Exception.Message }
`;

/** zeenha fork: render the launcher script with the payload embedded as base64. */
export function renderLauncherScript(payload: WindowsLauncherPayload): string {
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return LAUNCHER_SCRIPT.replace('__PAYLOAD__', b64);
}

export function buildWindows(
  shell: string,
  shellArgs: string[],
  opts: SandboxOptions,
  home: string,
  powershell: string
): SandboxResult {
  const rwPaths = [...new Set([opts.cwd, opts.projectDir, ...opts.writablePaths].filter((p) => p && p.length > 0))];
  for (const p of [shell, home, ...rwPaths]) {
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
  const normHome = path.win32.resolve(home).toLowerCase().replace(/[\\/]+$/, '');
  for (const p of rwPaths) {
    if (path.win32.resolve(p).toLowerCase().replace(/[\\/]+$/, '') === normHome) {
      return { ok: false, reason: 'Windows sandbox refused: the home directory itself cannot be made writable.' };
    }
  }

  const capabilities = opts.mode === 'home-hidden-no-network' ? [] : [CAP_INTERNET_CLIENT, CAP_PRIVATE_NETWORK];
  const script = renderLauncherScript({
    name: APPCONTAINER_NAME,
    shell,
    args: shellArgs,
    cwd: opts.cwd,
    rwPaths,
    shellDir: path.win32.dirname(shell),
    capabilities,
  });
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return {
    ok: true,
    file: powershell,
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
  };
}
