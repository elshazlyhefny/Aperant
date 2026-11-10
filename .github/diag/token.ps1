# Temporary diagnostic (will be reverted)
$ErrorActionPreference = 'Continue'
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
  const uint SE_GROUP_ENABLED = 0x4;
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
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSidToSidW(string s, out IntPtr sid);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr str);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint rev, out IntPtr sd, IntPtr size);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetSecurityDescriptorDacl(IntPtr sd, out int present, out IntPtr dacl, out int defaulted);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessAsUserW(IntPtr tok, string app, StringBuilder cmd, ref SECURITY_ATTRIBUTES pa, ref SECURITY_ATTRIBUTES ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);
  [DllImport("advapi32.dll")] static extern int GetLengthSid(IntPtr sid);
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
  static IntPtr Sid(string s) { IntPtr sid; if (!ConvertStringSidToSidW(s, out sid)) throw Win32("ConvertStringSidToSid " + s); return sid; }
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

  public static int Run(string sandboxSid, string exe, string cmdline, string cwd, int variant) {
    IntPtr tok;
    if (!OpenProcessToken(GetCurrentProcess(), MAXIMUM_ALLOWED, out tok)) throw Win32("OpenProcessToken");
    string userSid = SidString(Marshal.ReadIntPtr(TokenInfo(tok, 1)));
    IntPtr groups = TokenInfo(tok, 2);
    int count = Marshal.ReadInt32(groups);
    int sz = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
    List<SID_AND_ATTRIBUTES> deny = new List<SID_AND_ATTRIBUTES>();
    List<SID_AND_ATTRIBUTES> restrict = new List<SID_AND_ATTRIBUTES>();
    for (int i = 0; i < count; i++) {
      SID_AND_ATTRIBUTES g = (SID_AND_ATTRIBUTES)Marshal.PtrToStructure(IntPtr.Add(groups, IntPtr.Size + i * sz), typeof(SID_AND_ATTRIBUTES));
      if ((g.Attributes & SE_GROUP_INTEGRITY_ANY) != 0) continue;
      bool logon = (g.Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID;
      if (logon || Array.IndexOf(KEEP, SidString(g.Sid)) >= 0) {
        if ((g.Attributes & SE_GROUP_ENABLED) != 0) restrict.Add(Entry(g.Sid));
      } else {
        deny.Add(Entry(g.Sid));
      }
    }
    restrict.Add(Entry(Sid("S-1-5-12")));
    restrict.Add(Entry(Sid(sandboxSid)));
    if (variant == 2 || variant == 6) restrict.Add(Entry(Sid(userSid)));
    if (variant == 5) restrict.Add(Entry(Sid("S-1-5-32-544")));
    IntPtr rtok;
    bool noRestrict = variant == 3 || variant == 4;
    if (!CreateRestrictedToken(tok, DISABLE_MAX_PRIVILEGE, (uint)deny.Count, deny.ToArray(), 0, IntPtr.Zero, noRestrict ? 0u : (uint)restrict.Count, noRestrict ? null : restrict.ToArray(), out rtok)) throw Win32("CreateRestrictedToken");
    if (variant == 4) {
      IntPtr low = Sid("S-1-16-4096");
      int tmlSize = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
      IntPtr tml = Marshal.AllocHGlobal(tmlSize);
      SID_AND_ATTRIBUTES la = new SID_AND_ATTRIBUTES(); la.Sid = low; la.Attributes = 0x20;
      Marshal.StructureToPtr(la, tml, false);
      if (!SetTokenInformation(rtok, 25, tml, tmlSize + GetLengthSid(low))) throw Win32("SetTokenInformation(IntegrityLevel)");
    }

    // Objects the sandboxed processes create (and the processes themselves) must
    // stay openable by them, so the default DACL also grants the sandbox SID.
    IntPtr sd;
    string sddl = "D:(A;;GA;;;SY)(A;;GA;;;" + userSid + ")(A;;GA;;;" + sandboxSid + ")";
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
  return '"' + $s + '"'
}
$sid = 'S-1-5-21-2555033942-4112864343-2356659152-415028145'
$sidObj = New-Object Security.Principal.SecurityIdentifier($sid)
$wt = Join-Path $env:RUNNER_TEMP 'diagwt'
New-Item -ItemType Directory -Force -Path $wt | Out-Null
$canDir = Join-Path $env:USERPROFILE 'diagcanary'
New-Item -ItemType Directory -Force -Path $canDir | Out-Null
Set-Content -Path (Join-Path $canDir 'c.txt') -Value 'SECRET'
foreach ($d in @($wt)) { $i = Get-Item $d; $acl = $i.GetAccessControl('Access'); $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sidObj,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))); $i.SetAccessControl($acl) }
$bash = 'C:\Program Files\Git\bin\bash.exe'
$canPosix = ($canDir -replace '\\','/')
$script = "echo bash-ok; echo pipe | cat; cat '$canPosix/c.txt' && echo CANARY-READ; echo w > '$canPosix/w.txt' && echo HOME-WRITE; echo p > probe.txt && echo WT-WRITE; MSYS2_ARG_CONV_EXCL='*' /c/Windows/System32/whoami.exe /groups /fo csv | grep -i -E 'S-1-5-32-544|Mandatory'"
foreach ($v in 1,2,3,4,5,6) {
  if ($v -eq 6) {
    $i = Get-Item $canDir; $acl = $i.GetAccessControl('Access')
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sidObj,'FullControl','ContainerInherit,ObjectInherit','None','Deny'))); $i.SetAccessControl($acl)
  }
  Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $canDir 'w.txt')
  Write-Output "===== variant $v"
  $cmd = (@($bash, '-c', $script) | ForEach-Object { Quote $_ }) -join ' '
  try { $code = [AperantSandbox]::Run($sid, $bash, $cmd, $wt, $v); Write-Output "exit=$code" } catch { Write-Output "launch error: $($_.Exception.Message)" }
}
