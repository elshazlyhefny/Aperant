# Temporary diagnostic (will be reverted)
$ErrorActionPreference = 'Continue'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class D {
  [StructLayout(LayoutKind.Sequential)] public struct SA { public IntPtr Sid; public uint Attributes; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr p, uint a, out IntPtr t);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr t, int c, IntPtr b, int l, out int r);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr t, uint f, uint dc, SA[] d, uint pc, IntPtr p, uint rc, SA[] r, out IntPtr n);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSidToSidW(string s, out IntPtr sid);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr str);
  static string S(IntPtr sid) { IntPtr s; ConvertSidToStringSidW(sid, out s); return Marshal.PtrToStringUni(s); }
  static IntPtr Sid(string s) { IntPtr r; ConvertStringSidToSidW(s, out r); return r; }
  public static IntPtr Tok; public static List<SA> Groups = new List<SA>();
  public static void Init() {
    OpenProcessToken(GetCurrentProcess(), 0x02000000, out Tok);
    int len; GetTokenInformation(Tok, 2, IntPtr.Zero, 0, out len);
    IntPtr buf = Marshal.AllocHGlobal(len); GetTokenInformation(Tok, 2, buf, len, out len);
    int n = Marshal.ReadInt32(buf); int sz = Marshal.SizeOf(typeof(SA));
    for (int i = 0; i < n; i++) { SA g = (SA)Marshal.PtrToStructure(IntPtr.Add(buf, IntPtr.Size + i * sz), typeof(SA)); Groups.Add(g); Console.WriteLine("group " + S(g.Sid) + " attr=0x" + g.Attributes.ToString("X8")); }
  }
  public static string Try(string label, uint flags, string[] deny, string[] restrict) {
    List<SA> d = new List<SA>(); foreach (string s in deny) { SA e = new SA(); e.Sid = Sid(s); d.Add(e); }
    List<SA> r = new List<SA>(); foreach (string s in restrict) { SA e = new SA(); e.Sid = Sid(s); r.Add(e); }
    IntPtr nt; bool ok = CreateRestrictedToken(Tok, flags, (uint)d.Count, d.Count > 0 ? d.ToArray() : null, 0, IntPtr.Zero, (uint)r.Count, r.Count > 0 ? r.ToArray() : null, out nt);
    return label + ": " + (ok ? "OK" : ("FAIL " + Marshal.GetLastWin32Error()));
  }
  public static string[] GroupSids(uint mask, uint want) { List<string> l = new List<string>(); foreach (SA g in Groups) if ((g.Attributes & mask) == want) l.Add(S(g.Sid)); return l.ToArray(); }
  public static string[] AllNonIntegrity() { List<string> l = new List<string>(); foreach (SA g in Groups) if ((g.Attributes & 0x60) == 0) l.Add(S(g.Sid)); return l.ToArray(); }
}
'@
[D]::Init()
$custom = 'S-1-15-3-1024-2555033942-4112864343-2356659152-415028145-3406334563-1181000105-3758264521-3584341490'
[D]::Try('none', 1, @(), @())
[D]::Try('deny admin', 1, @('S-1-5-32-544'), @())
[D]::Try('restrict everyone', 1, @(), @('S-1-1-0'))
[D]::Try('restrict RESTRICTED', 1, @(), @('S-1-5-12'))
[D]::Try('restrict custom', 1, @(), @($custom))
[D]::Try('restrict everyone+users+auth', 1, @(), @('S-1-1-0','S-1-5-32-545','S-1-5-11'))
$all = [D]::AllNonIntegrity()
foreach ($s in $all) { [D]::Try("deny $s", 1, @($s), @()); [D]::Try("restrict $s", 1, @(), @($s)) }
[D]::Try('restrict custom 0 flags', 0, @(), @($custom))
whoami /groups /fo csv
whoami /priv /fo csv
