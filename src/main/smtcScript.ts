/**
 * SMTC 桥接脚本（SPEC-music-page / SPEC-music-controls）。
 *
 * 为什么是「一个常驻 PowerShell 子进程 + 行协议」而不是每秒起一个进程：
 * 实测单次 `powershell.exe` 启动约 755ms，每秒起进程会明显卡顿；常驻后单次往返约 19ms。
 *
 * 为什么脚本要落盘成 .ps1 而不是 `-EncodedCommand`：
 * Windows PowerShell 5.1 用 -EncodedCommand 时，脚本里的反引号与 CLIXML 进度流会让
 * `[System.WindowsRuntimeSystemExtensions]` 的反射查找失败（`$ext.GetMethods()` 变 null）。
 *
 * 为什么必须以 UTF-8 **带 BOM** 写文件：
 * 不带 BOM 时 PS 5.1 按系统 ANSI 解码含中文的脚本，类型名会被解坏，
 * 报「找不到类型 [System.Runtime.WindowsRuntimeSystemExtensions]」。BOM 由 `writeBridgeScript` 加。
 *
 * 协议（每行一条，UTF-8 无 BOM 输出）：
 *   stdin  ← 纯文本 "poll" / "toggle" / "next" / "prev" / "resync"
 *            或一行 JSON：{"cmd":"seek","value":秒} / {"cmd":"shuffle","value":bool}
 *                          / {"cmd":"repeat","value":0|1|2} / {"cmd":"volume","value":0..1}
 *   stdout → {"type":"state",...} 状态快照；{"type":"ack","cmd":...,"ok":bool} 命令回执
 *
 * 纯文本命令保留原样，带参数的新命令才用 JSON：两个 e2e 脚本直接发纯文本命令驱动本脚本，
 * 全量改协议会无谓打断它们（见 SPEC-music-controls「混合行协议，最小改动」）。
 *
 * 音量（2026-11-15 用户纠正后重做，同日实测又修正匹配）：只读写「当前播放应用的那条
 * Core Audio 音频会话」，绝不碰系统主音量。SMTC 会话本身没有音量方法，靠
 * SourceAppUserModelId 与音频会话 PID 对号入座。真实播放器的标识未必等于进程名——
 * 实测「汽水音乐」的 SMTC 标识是中文名，音频会话进程却叫 SodaMusic，按名字相等会漏配，
 * 滑块被误置灰。故匹配分三层：exe/AUMID 精确比对 → 按窗口标题/产品名/描述扫进程得到
 * 候选进程名集合再比 ProcessName → 全场仅一条 active 音频会话时直接用它（仍是应用音量）。
 * 仍对不上号 → canVolume=false → 界面置灰滑块，不读写任何音量，绝不回退系统音量。
 */
export const SMTC_SCRIPT = String.raw`$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
# 封面：OpenReadAsync() 的异步结果类型，Await 需要它作为 AsTask 的泛型参数
[void][Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime]

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -like "IAsyncOperation*" -and
  $_.GetGenericArguments().Count -eq 1
})[0]

function Await($op, $t) {
  $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

# 输出必须是 UTF-8 无 BOM，Node 侧按 utf8 解码才能正确读到中文歌名
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

# 只返回索引（普通 int），不要返回会话对象本身。
# 原因（2026-11-11 实测踩坑）：PowerShell 函数把 WinRT 对象当返回值传出去时，
# 调用方拿到的是经过 PowerShell 包装的代理，类型投影丢了，再调 GetPlaybackInfo()
# 会抛 System.ArgumentException: 对象的类型不能为 Windows 运行时类型。
# 这个异常会被 poll 的 try/catch 吞掉，表现成「永远没有会话」——排查了很久。
#
# 注意：调用方取原对象时必须先 @() 再索引，写成 @($sessions)[$i]，不能写 $sessions[$i]。
# 原因（2026-11-11 独立验收实测）：$mgr.GetSessions() 返回的是 System.__ComObject 包装的
# WinRT IVectorView，裸索引只有 [0] 有效，[1] 及以后一律回 $null：
#   i=0  $sessions[0] = obj   callOK   |  @($sessions)[0] = obj  callOK
#   i=1  $sessions[1] = NULL           |  @($sessions)[1] = obj  callOK
# 裸索引拿到 $null 后调 TryGetMediaPropertiesAsync() 会抛「不能对 Null 值表达式调用方法」，
# 界面就恒为空态。单会话时 idx 恒为 0，恰好命中，本地很难发现。
function PickIndex($sessions) {
  $arr = @($sessions)
  if ($arr.Count -eq 0) { return -1 }
  # 优先正在播放的那个：同时开着多个播放器时，用户想看的显然是出声的那个
  for ($i = 0; $i -lt $arr.Count; $i++) {
    try {
      if ($arr[$i].GetPlaybackInfo().PlaybackStatus.ToString() -eq "Playing") { return [int]$i }
    } catch {
      # 单个会话取播放信息失败就跳过它，继续看下一个；不能因为一个坏会话让整体判失败
    }
  }
  return 0
}

# 按应用音量（Core Audio 音频会话 / ISimpleAudioVolume）。
# 与「系统主音量」是两套不同接口：这里枚举默认输出设备上的
# 音频会话，用 IAudioSessionControl2.GetProcessId 拿 PID，再与 SMTC 的
# SourceAppUserModelId 对号入座；显示名不可靠（实测空串或系统资源串），不能用来匹配。
# 源码必须全 ASCII、无中文注释、here-string 结束符在行首；否则 PS 5.1 会把 C# 当 PS 解析。
# Add-Type -TypeDefinition 在本进程（已加载 WinRT 类型）实测编译成功，无需额外辅助进程。
# IID 与方法顺序来自 audiopolicy.h / windows-rs，并经本机探针 .tmp/probe-app-volume.mjs 实测。
$volSrc = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace IslandAppVol {
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IntPtr ppDevices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IMMDevice ppDevice);
    [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr pClient);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr pClient);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    [PreserveSig] int OpenPropertyStore(int stgmAccess, out IntPtr ppProperties);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
    [PreserveSig] int GetState(out int pdwState);
  }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  public class MMDeviceEnumeratorComObject { }

  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionManager2 {
    [PreserveSig] int NotImpl1();
    [PreserveSig] int NotImpl2();
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator SessionEnum);
  }
  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int SessionCount);
    [PreserveSig] int GetSession(int Index, out IAudioSessionControl Session);
  }
  [Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionControl {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid ctx);
    [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid ctx);
    [PreserveSig] int GetGroupingParam(out Guid p);
    [PreserveSig] int SetGroupingParam(ref Guid p, ref Guid ctx);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
  }
  [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid ctx);
    [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid ctx);
    [PreserveSig] int GetGroupingParam(out Guid p);
    [PreserveSig] int SetGroupingParam(ref Guid p, ref Guid ctx);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
    [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetProcessId(out int pid);
    [PreserveSig] int IsSystemSoundsSession();
    [PreserveSig] int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
  }
  [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface ISimpleAudioVolume {
    [PreserveSig] int SetMasterVolume(float fLevel, ref Guid ctx);
    [PreserveSig] int GetMasterVolume(out float pfLevel);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid ctx);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
  }

  public static class AppVol {
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern int GetApplicationUserModelId(IntPtr hProcess, ref uint len, StringBuilder sb);

    static string ProcAumid(int pid) {
      IntPtr h = IntPtr.Zero;
      try {
        h = OpenProcess(0x1000, false, pid);
        if (h == IntPtr.Zero) return "";
        uint len = 1024;
        var sb = new StringBuilder((int)len);
        int r = GetApplicationUserModelId(h, ref len, sb);
        if (r == 0) return sb.ToString() ?? "";
        return "";
      } catch { return ""; }
      finally { if (h != IntPtr.Zero) CloseHandle(h); }
    }

    static string Exe(string smtc) {
      string s = (smtc ?? "").Trim();
      int slash = Math.Max(s.LastIndexOf('\\'), s.LastIndexOf('/'));
      if (slash >= 0) s = s.Substring(slash + 1);
      if (s.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) s = s.Substring(0, s.Length - 4);
      return s;
    }
    static string Pname(int pid) { try { return Process.GetProcessById(pid).ProcessName; } catch { return ""; } }
    static bool Contains(string hay, string needle) {
      if (string.IsNullOrEmpty(hay) || string.IsNullOrEmpty(needle)) return false;
      return hay.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0;
    }

    // Cache candidate ProcessNames per SMTC id: scanning all processes is not free, and poll runs 1/s.
    // Real players often report a localized SMTC id that differs from the exe name (measured:
    // "汽水音乐" vs SodaMusic). We look for processes whose window title / product info contains
    // the SMTC id and collect their ProcessNames. Cached for the bridge lifetime; Find() retries
    // with a refreshed cache when nothing matched.
    static readonly Dictionary<string, HashSet<string>> NameCache = new Dictionary<string, HashSet<string>>();
    static HashSet<string> Candidates(string smtc, bool refresh) {
      if (!refresh && NameCache.ContainsKey(smtc)) return NameCache[smtc];
      var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      string exe = Exe(smtc);
      if (exe.Length > 0) set.Add(exe);
      // 一旦成功对号入座过，就把那个进程名并进候选集（用户 m04736）：
      // 汽水音乐的 SMTC id 是「汽水音乐」、进程名却是 SodaMusic，名字天生对不上；
      // 它又有 5 个进程、音频会话会随子进程换人。记住一次真实进程名之后，
      // 以后即使换了进程（Tier 3 不再唯一）也能靠这个名字直接认回来。
      if (!string.IsNullOrEmpty(LastName)) set.Add(LastName);
      if (!string.IsNullOrEmpty(smtc)) {
        try {
          foreach (var p in Process.GetProcesses()) {
            try {
              bool hit = false;
              try { if (Contains(p.MainWindowTitle, smtc)) hit = true; } catch { }
              try {
                var fv = p.MainModule.FileVersionInfo;
                if (Contains(fv.ProductName, smtc) || Contains(fv.FileDescription, smtc)) hit = true;
              } catch { }
              if (hit && !string.IsNullOrEmpty(p.ProcessName)) set.Add(p.ProcessName);
            } catch { }
          }
        } catch { }
      }
      NameCache[smtc] = set;
      return set;
    }

    // Desktop players: SMTC id vs ProcessName / candidate names. Store apps: compare AUMID / package family name.
    static bool AppMatches(string smtc, int pid, HashSet<string> names) {
      if (pid <= 0 || string.IsNullOrEmpty(smtc)) return false;
      string s = smtc.Trim();
      string pname = Pname(pid);
      if (pname.Length > 0 && names.Contains(pname)) return true;
      string pa = ProcAumid(pid);
      if (pa.Length > 0 && !pa.StartsWith("ERR")) {
        if (string.Equals(pa, s, StringComparison.OrdinalIgnoreCase)) return true;
        int bi = s.IndexOf('!'), pi = pa.IndexOf('!');
        string sf = bi > 0 ? s.Substring(0, bi) : s;
        string pf = pi > 0 ? pa.Substring(0, pi) : pa;
        if (string.Equals(sf, pf, StringComparison.OrdinalIgnoreCase)) return true;
      }
      return false;
    }

    // 记住上一次成功对号入座的音频会话进程（用户 m04736「拖动音量没有变化」）。
    // 原因："汽水音乐" 有 5 个进程、音频会话会随内部子进程反复出现/消失，Tier 3 的
    // 「全场只有一个 active 会话」这条会时真时假 ⇒ canVolume 在 true/false 之间抖，
    // 滑块被禁用、拖了当然没反应。一旦成功匹配过，就把那个 pid / 进程名记下来复用它，
    // 只要该进程还活着、还有会话，就直接返回它，不再每次重新猜。
    static int LastPid = -1;
    static string LastName = "";
    // 缓存跟着 SMTC 应用走：换了播放器（smtc id 变了）就不复用，避免把上一位播放器的
    // 会话当成当前这位（那种情况下滑条会控制错的应用，比抖动更糟）
    static string LastSmtc = "";
    // Tier 0: 上次成功匹配的 pid 还在（缓存优先，解决抖动）。
    // Tier 1: active (state==1) session of a name-matched app. Tier 2: any name-matched session.
    // Tier 3: exactly one active session with a real PID -> that is the only app producing sound,
    // use it. Still an application audio session, never the system master volume. Multiple active
    // sessions with no name match stay unresolved (slider disabled), so we never guess wrong.
    static ISimpleAudioVolume Find(string smtc) {
      try {
        var cached = (LastPid > 0 && string.Equals(LastSmtc, smtc, StringComparison.OrdinalIgnoreCase))
          ? FindByPid(LastPid) : null;
        if (cached != null) return cached;
        var sv = FindOnce(smtc, Candidates(smtc, false)) ?? FindOnce(smtc, Candidates(smtc, true));
        return sv;
      } catch { return null; }
    }
    // 只按 pid 找一个仍在的音频会话（缓存命中路径，不做名字匹配）
    static ISimpleAudioVolume FindByPid(int pid) {
      if (pid <= 0) return null;
      try { Process.GetProcessById(pid); } catch { LastPid = -1; return null; }
      try {
        var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
        IMMDevice device;
        int hr = en.GetDefaultAudioEndpoint(0, 1, out device);
        if (hr != 0 || device == null) return null;
        Guid iid = typeof(IAudioSessionManager2).GUID;
        object o;
        hr = device.Activate(ref iid, 23, IntPtr.Zero, out o);
        if (hr != 0 || o == null) return null;
        var mgr = (IAudioSessionManager2)o;
        IAudioSessionEnumerator e;
        hr = mgr.GetSessionEnumerator(out e);
        if (hr != 0 || e == null) return null;
        int count;
        hr = e.GetCount(out count);
        if (hr != 0) return null;
        for (int i = 0; i < count; i++) {
          IAudioSessionControl ctl;
          hr = e.GetSession(i, out ctl);
          if (hr != 0 || ctl == null) continue;
          int spid = -1;
          try { var c2 = (IAudioSessionControl2)ctl; c2.GetProcessId(out spid); } catch { continue; }
          if (spid == pid) return ctl as ISimpleAudioVolume;
        }
      } catch { }
      return null;
    }
    static ISimpleAudioVolume FindOnce(string smtc, HashSet<string> names) {
      var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
      IMMDevice device;
      int hr = en.GetDefaultAudioEndpoint(0, 1, out device);
      Marshal.ThrowExceptionForHR(hr);
      Guid iid = typeof(IAudioSessionManager2).GUID;
      object o;
      hr = device.Activate(ref iid, 23, IntPtr.Zero, out o);
      Marshal.ThrowExceptionForHR(hr);
      var mgr = (IAudioSessionManager2)o;
      IAudioSessionEnumerator e;
      hr = mgr.GetSessionEnumerator(out e);
      Marshal.ThrowExceptionForHR(hr);
      int count;
      hr = e.GetCount(out count);
      if (hr != 0) return null;
      ISimpleAudioVolume namedActive = null, namedIdle = null;
      int namedActivePid = -1, namedIdlePid = -1;
      var active = new List<ISimpleAudioVolume>();
      var activePids = new List<int>();
      for (int i = 0; i < count; i++) {
        IAudioSessionControl ctl;
        hr = e.GetSession(i, out ctl);
        if (hr != 0 || ctl == null) continue;
        int pid = -1, state = -1;
        try {
          var c2 = (IAudioSessionControl2)ctl;
          c2.GetProcessId(out pid);
          c2.GetState(out state);
        } catch { continue; }
        var sv = ctl as ISimpleAudioVolume;
        if (sv == null) continue;
        if (state == 1 && pid > 0) { active.Add(sv); activePids.Add(pid); }
        if (AppMatches(smtc, pid, names)) {
          if (state == 1) { namedActive = sv; namedActivePid = pid; }
          else if (namedIdle == null) { namedIdle = sv; namedIdlePid = pid; }
        }
      }
      if (namedActive != null) { Remember(namedActivePid, smtc); return namedActive; }
      if (namedIdle != null) { Remember(namedIdlePid, smtc); return namedIdle; }
      // Tier 3 只在真的只有一个 active 会话时可用；记住它，下次优先复用，避免这条时真时假
      if (active.Count == 1) { Remember(activePids[0], smtc); return active[0]; }
      return null;
    }
    // 记下成功对号入座的 pid / 进程名，供下次 Find 先走缓存（用户 m04736）
    static void Remember(int pid, string smtc) {
      if (pid <= 0) return;
      LastPid = pid;
      LastSmtc = smtc ?? "";
      try { LastName = Process.GetProcessById(pid).ProcessName; } catch { LastName = ""; }
    }

    // -1 means no matching audio session: caller must disable the slider and never touch system volume.
    public static float Get(string smtc) {
      try {
        var sv = Find(smtc);
        if (sv == null) return -1f;
        float v;
        int hr = sv.GetMasterVolume(out v);
        if (hr != 0) return -1f;
        return v;
      } catch { return -1f; }
    }

    public static bool Set(string smtc, float f) {
      try {
        var sv = Find(smtc);
        if (sv == null) return false;
        Guid g = Guid.Empty;
        int hr = sv.SetMasterVolume(f, ref g);
        Marshal.ThrowExceptionForHR(hr);
        return true;
      } catch { return false; }
    }
  }
}
'@
Add-Type -TypeDefinition $volSrc

# 真实封面（2026-11-15 第 2 批，SPEC-music-cover）。
# 历史结论「PS 5.1 拿不到封面字节」作废：Thumbnail.OpenReadAsync() 返回 System.__ComObject，
# 直接强转成 IRandomAccessStream 会失败，但把原始 __ComObject 传给「已加载程序集里反射出来的」
# WindowsRuntimeStreamExtensions.AsStreamForRead，CLR 会自己完成 COM 接口协商，就能 CopyTo 成字节。
# 编译期不引用任何 .winmd，绕开历史踩坑里的 CS1701 / CS0012；无需额外辅助进程。
$coverSrc = @'
using System;
using System.IO;
using System.Reflection;
public static class IslandCoverGrab {
  public static string Grab(object st) {
    try {
      Assembly asm = null;
      foreach (Assembly a in AppDomain.CurrentDomain.GetAssemblies()) {
        if (a.GetName().Name == "System.Runtime.WindowsRuntime") { asm = a; break; }
      }
      if (asm == null) return "";
      Type ext = asm.GetType("System.IO.WindowsRuntimeStreamExtensions", false);
      if (ext == null) return "";
      MethodInfo mi = null;
      foreach (MethodInfo m in ext.GetMethods(BindingFlags.Public | BindingFlags.Static)) {
        if (m.Name == "AsStreamForRead" && m.GetParameters().Length == 1) { mi = m; break; }
      }
      if (mi == null) return "";
      object nsObj;
      try { nsObj = mi.Invoke(null, new object[] { st }); }
      catch (TargetInvocationException) { return ""; }
      Stream ns = nsObj as Stream;
      if (ns == null) return "";
      MemoryStream ms = new MemoryStream();
      ns.CopyTo(ms);
      byte[] b = ms.ToArray();
      if (b.Length < 8 || b.Length > 524288) return "";
      string mime;
      if (b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47) mime = "image/png";
      else if (b[0] == 0xFF && b[1] == 0xD8) mime = "image/jpeg";
      else return "";
      return "data:" + mime + ";base64," + Convert.ToBase64String(b);
    } catch { return ""; }
  }
}
'@
Add-Type -TypeDefinition $coverSrc

$repeatEnumT = [Windows.Media.MediaPlaybackAutoRepeatMode, Windows.Media, ContentType=WindowsRuntime]

# 封面缓存：同一首歌只在换歌时重新读一次缩略图，避免每秒 poll 都去拉 WinRT 流。
# key 用 app|title|artist|album（至少含 3 个竖线，永不等于 ""）。
# 关键点：封面 data URL 可能几十 KB；未换歌时返回 $null（JSON 里是 null），主进程沿用
# 上一次的封面，避免每秒往 stdout 写一遍大字符串。换歌才返回完整 data URL（或 "" 表示没有）。
# 任何一步失败都只回空串，绝不让封面问题连累整份状态快照。
# 陷阱（实测踩过）：在 -File 脚本里主脚本体就是 script 作用域，poll 分支里若也用
# $coverKey 这种无前缀变量，会直接覆盖 $script:coverKey，导致首帧就被误判为「未换歌」
# 而恒返回 $null。故缓存键一律用 $script:coverCacheKey，poll 里算键用 $coverId，绝不同名。
$script:coverCacheKey = ""
function GetCover($props, $key) {
  if ($key -eq $script:coverCacheKey) { return $null }
  $data = ""
  try {
    $thumb = $props.Thumbnail
    if ($null -ne $thumb) {
      $stream = Await ($thumb.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
      $data = [IslandCoverGrab]::Grab($stream)
    }
  } catch { $data = "" }
  $script:coverCacheKey = $key
  return $data
}

# 读当前播放应用的音频会话音量：-1 表示对不上号（或读取失败），界面会置灰滑块。
# 绝不读系统主音量，也绝不因为读不到就回退到系统音量。
function GetAppVolume($app) {
  try { return [double][IslandAppVol.AppVol]::Get([string]$app) } catch { return -1 }
}

$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
Emit @{ type = "ready" }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq "") { continue }

  # 带参数的新命令用一行 JSON；其余整行就是一个纯文本命令。
  # 解析失败按未知命令处理，只回一条 ack，不让坏输入把循环带崩。
  $cmd = $line
  $val = $null
  if ($line.StartsWith("{")) {
    try {
      $j = $line | ConvertFrom-Json
      $cmd = [string]$j.cmd
      $val = $j.value
    } catch {
      $cmd = ""
    }
  }

  if ($cmd -eq "resync") {
    # 媒体会话列表变化（播放器刚打开/关闭）时重取管理器句柄
    try {
      $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
      Emit @{ type = "ack"; cmd = "resync"; ok = $true }
    } catch {
      Emit @{ type = "ack"; cmd = "resync"; ok = $false }
    }
    continue
  }

  $sessions = $mgr.GetSessions()
  $idx = PickIndex $sessions

  # 音量依赖当前播放应用：用正在播放（或当前选中）的会话的 SourceAppUserModelId
  # 去找它自己的音频会话。没有会话、或对不上号时只回 ack ok=false，不碰任何音量。
  if ($cmd -eq "volume") {
    if ($idx -lt 0) { Emit @{ type = "ack"; cmd = "volume"; ok = $false }; continue }
    try {
      $s = @($sessions)[$idx]
      $app = [string]$s.SourceAppUserModelId
      $v = [double]$val
      if ($v -lt 0) { $v = 0 }
      if ($v -gt 1) { $v = 1 }
      $ok = [IslandAppVol.AppVol]::Set($app, [float]$v)
      Emit @{ type = "ack"; cmd = "volume"; ok = [bool]$ok }
    } catch {
      Emit @{ type = "ack"; cmd = "volume"; ok = $false }
    }
    continue
  }

  if ($cmd -eq "poll") {
    if ($idx -lt 0) {
      # 空态也要把新字段补齐，渲染层才不会读到 undefined
      Emit @{ type = "state"; active = $false; title = ""; artist = ""; album = ""; position = 0; duration = 0; playing = $false; app = ""; shuffle = $false; repeat = 0; volume = 0; canSeek = $false; canShuffle = $false; canRepeat = $false; canVolume = $false; cover = "" }
      continue
    }
    # 快照必须在这个作用域里直接取，且必须先 @() 再索引，原因见 PickIndex 上方的注释
    try {
      $s = @($sessions)[$idx]
      $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $tl = $s.GetTimelineProperties()
      $info = $s.GetPlaybackInfo()
      $ctrl = $info.Controls
      # PS 5.1 把 Nullable<bool> / Nullable<enum> 自动解包成普通值：直接强转即可，
      # 不要写 .HasValue / .Value（实测为空）。见 .tmp/probe-smtc-controls.mjs。
      $shuffle = [bool]$info.IsShuffleActive
      $repeat = [int]$info.AutoRepeatMode
      $appId = [string]$s.SourceAppUserModelId
      $volRaw = GetAppVolume $appId
      $canVol = $false
      $vol = 0
      if ($volRaw -ge 0) { $canVol = $true; $vol = [math]::Round($volRaw, 3) }
      $titleStr = [string]$props.Title
      $artistStr = [string]$props.Artist
      $albumStr = [string]$props.AlbumTitle
      $coverId = $appId + "|" + $titleStr + "|" + $artistStr + "|" + $albumStr
      $cover = GetCover $props $coverId
      # 用户 m05562「喝唱的对不齐」：TimelineProperties.Position 只是「LastUpdatedTime 那一刻」的位置，
      # 播放器不一定每秒刷新它（实测汽水音乐/假会话都会隔几秒才更新，甚至几十秒）。
      # 直接拿它当当前位置，歌词就会落后真实播放。这里按「播放中 + 距上次更新的真实流逝时间」
      # 补上差值，夹在 0..EndTime 之间；暂停时不动。
      $posSec = $tl.Position.TotalSeconds
      $isPlaying = ($info.PlaybackStatus.ToString() -eq "Playing")
      if ($isPlaying) {
        $ageSec = ([DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalSeconds
        if ($ageSec -gt 0 -and $ageSec -lt 600) { $posSec = $posSec + $ageSec }
      }
      $endSec = $tl.EndTime.TotalSeconds
      if ($endSec -gt 0 -and $posSec -gt $endSec) { $posSec = $endSec }
      if ($posSec -lt 0) { $posSec = 0 }
      Emit ([ordered]@{
        type = "state"
        active = $true
        title = $titleStr
        artist = $artistStr
        album = $albumStr
        position = [math]::Round($posSec, 1)
        duration = [math]::Round($endSec, 1)
        playing = $isPlaying
        app = $appId
        shuffle = $shuffle
        repeat = $repeat
        volume = $vol
        canSeek = [bool]$ctrl.IsPlaybackPositionEnabled
        canShuffle = [bool]$ctrl.IsShuffleEnabled
        canRepeat = [bool]$ctrl.IsRepeatEnabled
        canVolume = $canVol
        cover = $cover
      })
    } catch {
      # 把异常文本吐出去，别再静默发空态——静默会让人误以为「本机没有播放器」
      Emit @{ type = "error"; msg = ([string]$_.Exception.Message) }
    }
    continue
  }

  if ($idx -lt 0) { Emit @{ type = "ack"; cmd = $cmd; ok = $false }; continue }

  # 未知命令先挡掉，否则 switch 的 default 里 continue 之后还会落到下面那条 Emit，吐两条 ack
  if ($cmd -ne "toggle" -and $cmd -ne "next" -and $cmd -ne "prev" -and
      $cmd -ne "seek" -and $cmd -ne "shuffle" -and $cmd -ne "repeat") {
    Emit @{ type = "ack"; cmd = $cmd; ok = $false }
    continue
  }

  $s = @($sessions)[$idx]
  $ok = $false
  try {
    switch ($cmd) {
      "toggle"  { $ok = Await ($s.TryTogglePlayPauseAsync()) ([bool]) }
      "next"    { $ok = Await ($s.TrySkipNextAsync()) ([bool]) }
      "prev"    { $ok = Await ($s.TrySkipPreviousAsync()) ([bool]) }
      "seek"    {
        # TryChangePlaybackPositionAsync 收 100 纳秒 ticks，不是秒
        $ticks = [int64][TimeSpan]::FromSeconds([double]$val).Ticks
        $ok = Await ($s.TryChangePlaybackPositionAsync($ticks)) ([bool])
      }
      "shuffle" { $ok = Await ($s.TryChangeShuffleActiveAsync([bool]$val)) ([bool]) }
      "repeat"  {
        $name = switch ([int]$val) { 0 { "None" } 1 { "Track" } default { "List" } }
        $mode = [Enum]::Parse($repeatEnumT, $name)
        $ok = Await ($s.TryChangeAutoRepeatModeAsync($mode)) ([bool])
      }
    }
  } catch {
    Emit @{ type = "ack"; cmd = $cmd; ok = $false }
    continue
  }
  Emit @{ type = "ack"; cmd = $cmd; ok = [bool]$ok }
}
`
