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
# 该应用此刻是否有「用户能看见的窗口」。
# 用户 m06991 的截图里：网易云在前台播《天使的翅膀》，岛上却显示《Take Me Hand》。
# 原因是 PickIndex 只看「谁在 Playing」，而当时后台的汽水音乐也在放，先被扫到了。
# 两个都在放时，用户想控制的显然是摆在眼前的那个 ⇒ 用「有没有可见顶层窗口」当判据。
# 缓存 3 秒：poll 每秒一次，扫进程不算免费，但也不该把窗口切换拖到几分钟才生效。
$script:visKey = ""
$script:visAt = [DateTime]::MinValue
$script:visSet = @{}
function VisibleApps() {
  $now = [DateTime]::UtcNow
  if (($now - $script:visAt).TotalSeconds -lt 3) { return $script:visSet }
  $set = @{}
  try {
    foreach ($p in [System.Diagnostics.Process]::GetProcesses()) {
      try {
        if ($p.MainWindowHandle -eq 0) { continue }
        $n = $p.ProcessName
        if ($n) { $set[$n] = $true }
      } catch { }
    }
  } catch { }
  $script:visSet = $set
  $script:visAt = $now
  return $set
}

function PickIndex($sessions) {
  $arr = @($sessions)
  if ($arr.Count -eq 0) { return -1 }
  # 优先正在播放的：同时开着多个播放器时，用户想看的显然是出声的那个。
  # 多个同时在放时，再优先「有可见窗口」的那个（就是摆在用户眼前的那个）。
  $playing = @()
  for ($i = 0; $i -lt $arr.Count; $i++) {
    try {
      if ($arr[$i].GetPlaybackInfo().PlaybackStatus.ToString() -eq "Playing") { $playing += [int]$i }
    } catch {
      # 单个会话取播放信息失败就跳过它，继续看下一个；不能因为一个坏会话让整体判失败
    }
  }
  if ($playing.Count -eq 1) { return [int]$playing[0] }
  if ($playing.Count -eq 0) { return 0 }
  $vis = VisibleApps
  foreach ($i in $playing) {
    try {
      $app = [string]$arr[$i].SourceAppUserModelId
      $exe = ($app -replace '^.*[\\/]', '') -replace '\.exe$', ''
      if ($exe -and $vis.ContainsKey($exe)) { return [int]$i }
    } catch { }
  }
  return [int]$playing[0]
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

  [Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioMeterInformation {
    [PreserveSig] int GetPeakValue(out float pfPeak);
    [PreserveSig] int GetMeteringChannelCount(out int pnChannelCount);
    [PreserveSig] int GetChannelsPeakValues(int u32ChannelCount, float[] afPeakValues);
    [PreserveSig] int QueryHardwareSupport(out int pdwHardwareSupportMask);
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
    public static float Get(string smtc) {      try {
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

    // 现在到底哪个进程在出声。SMTC 会话为空（网易云 3.1.41 实测就是不注册）时，
    // 桥接不能因此判定「没有播放器」，得靠音频会话自己看：state==1 且 pid>0 的就在出声。
    // 返回 "exe1,pid1;exe2,pid2"，无则 ""。实测峰值表能分辨出声/静音约 60 倍（0.006 vs 0.375）。
    public static string ActiveList() {
      try {
        var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
        IMMDevice device;
        int hr = en.GetDefaultAudioEndpoint(0, 1, out device);
        if (hr != 0 || device == null) return "";
        Guid iid = typeof(IAudioSessionManager2).GUID;
        object o;
        hr = device.Activate(ref iid, 23, IntPtr.Zero, out o);
        if (hr != 0 || o == null) return "";
        var mgr = (IAudioSessionManager2)o;
        IAudioSessionEnumerator e;
        hr = mgr.GetSessionEnumerator(out e);
        if (hr != 0 || e == null) return "";
        int count;
        hr = e.GetCount(out count);
        if (hr != 0) return "";
        var sb = new StringBuilder();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i < count; i++) {
          IAudioSessionControl ctl;
          hr = e.GetSession(i, out ctl);
          if (hr != 0 || ctl == null) continue;
          int pid = -1, state = -1;
          try { var c2 = (IAudioSessionControl2)ctl; c2.GetProcessId(out pid); c2.GetState(out state); } catch { continue; }
          // state: 0=Inactive 1=Active 2=Expired。Expired 的会话已经没用，其余都保留——
          // 暂停时 state 会掉到 0，但进程和窗口都还在，界面不能因此清空。
          if (state == 2 || pid <= 0) continue;
          string pn = Pname(pid);
          if (pn.Length == 0) continue;
          string key = pn + "|" + pid.ToString();
          if (!seen.Add(key)) continue;
          if (sb.Length > 0) sb.Append(";");
          sb.Append(pn).Append(".exe,").Append(pid.ToString()).Append(",").Append(state.ToString());
        }
        return sb.ToString();
      } catch { return ""; }
    }

    // 该应用当前音频会话的峰值（0..1）。用来判「它是不是真在出声」。
    // 找不到会话返回 -1；找到了但没声音返回 0 附近的极小值。
    public static float Peak(string smtc) {
      try {
        var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
        IMMDevice device;
        int hr = en.GetDefaultAudioEndpoint(0, 1, out device);
        if (hr != 0 || device == null) return -1f;
        Guid iid = typeof(IAudioSessionManager2).GUID;
        object o;
        hr = device.Activate(ref iid, 23, IntPtr.Zero, out o);
        if (hr != 0 || o == null) return -1f;
        var mgr = (IAudioSessionManager2)o;
        IAudioSessionEnumerator e;
        hr = mgr.GetSessionEnumerator(out e);
        if (hr != 0 || e == null) return -1f;
        int count;
        hr = e.GetCount(out count);
        if (hr != 0) return -1f;
        var names = Candidates(smtc, false);
        float best = -1f;
        for (int i = 0; i < count; i++) {
          IAudioSessionControl ctl;
          hr = e.GetSession(i, out ctl);
          if (hr != 0 || ctl == null) continue;
          int pid = -1;
          try { var c2 = (IAudioSessionControl2)ctl; c2.GetProcessId(out pid); } catch { continue; }
          if (pid <= 0) continue;
          if (!AppMatches(smtc, pid, names)) continue;
          var mi = ctl as IAudioMeterInformation;
          if (mi == null) continue;
          float v;
          if (mi.GetPeakValue(out v) != 0) continue;
          if (v > best) best = v;
        }
        return best;
      } catch { return -1f; }
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

# 点击播放器自己的进度条（2026-11-16 用户 m07228 要求「做不到也要做」后找到的路子）。
# 背景：网易云（cloudmusic）实现了 SMTC 的「歌名/歌手/封面」，但 IsPlaybackPositionEnabled=False、
# Position/EndTime 恒 0、LastUpdatedTime 是 1601-01-01，TryChangePlaybackPositionAsync 会
# 返回 true 却什么都不做（实测 seekers 目标 9999 秒、连采 5 次 pos 仍 0）。所以走 SMTC 永远跳不动。
# 但它的窗口里有一条自己的进度条：已播段是红色、未播段是灰色。点它，网易云会真的跳
# （实测 目标 0.70→实际 0.694、0.20→0.194、0.45→0.444）。
# 三个关键前提，缺一不可：
#   1) 进程必须先 SetProcessDPIAware()。不加时本机 125% 缩放下 GetWindowRect 给的是
#      「虚拟化坐标」（窗口 240,80,1057x752），真实是 300,100,1321x940，按错的坐标点必偏，
#      这就是最初「点不动」的真因。
#   2) 读进度要用 PrintWindow 离屏渲染，不能用 CopyFromScreen——后者要求窗口可见且在前台，
#      实测窗口被别的窗口盖住时读到的是遮挡物。PrintWindow 全程 94ms，且不用抢前台。
#   3) 找窗口按「窗口标题包含当前歌名」而不是进程名：网易云 SMTC 标识是 cloudmusic.exe 还行，
#      但汽水音乐的 SMTC 标识是中文「汽水音乐」、进程却叫 SodaMusic，按名字匹配会漏。
#      标题匹配对任何播放器都成立（网易云主窗标题形如「歌名 - 歌手」）。
# PowerShell 5.1 的 Add-Type 只支持 C# 5：不用 ?.、不用 nameof、不用字符串内插。
$barSrc = @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Globalization;
using System.Text;
public static class IslandBarClick {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, int dx, int dy, uint data, IntPtr extra);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  static bool dpiReady = false;
  public static void InitDpi() {
    if (dpiReady) return;
    try { SetProcessDPIAware(); } catch { }
    dpiReady = true;
  }
  // 取某进程「面积最大的可见顶层窗口」。
  // 为什么要这条而不是直接用 Process.MainWindowHandle：实测网易云被最小化到托盘后，
  // MainWindowHandle 仍指着一个 159x27 的残壳（iconic=True），PrintWindow 抓到的就是
  // 那张空图，Probe 因为 w<200 直接拒收——barPct 恒 -1 的真因就在这里。
  // EnumWindows 能拿到同一 pid 下所有顶层窗口，按面积挑最大的那个才是真主窗。
  public static IntPtr Biggest(uint pid) {
    IntPtr best = IntPtr.Zero;
    long bestArea = 0;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint p;
      GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      if (!IsWindowVisible(h)) return true;
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      long a = (long)(r.R - r.L) * (long)(r.B - r.T);
      if (a > bestArea) { bestArea = a; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
  public static IntPtr FindByTitle(string title) {
    if (title == null || title.Length < 2) return IntPtr.Zero;
    foreach (Process p in Process.GetProcesses()) {
      try {
        string t = p.MainWindowTitle;
        if (t == null || t.Length == 0) continue;
        if (t.IndexOf(title, StringComparison.OrdinalIgnoreCase) < 0) continue;
        IntPtr h = Biggest((uint)p.Id);
        if (h == IntPtr.Zero) h = p.MainWindowHandle;
        if (h != IntPtr.Zero) return h;
      } catch { }
    }
    return IntPtr.Zero;
  }
  // 按进程名找主窗口（传 "cloudmusic.exe" 或 "cloudmusic" 都行）。
  // 为什么要这条兜底：用户切到歌单页/首页时，网易云主窗标题会从「歌名 - 歌手」变成
  // 「网易云音乐」，按标题就再也找不到窗口了（实测 FindByTitle 返回 0、进度条读不到）。
  // 但它的底部控制栏一直在，按进程名能稳定找到。
  public static IntPtr FindByExe(string exeName) {
    if (exeName == null) return IntPtr.Zero;
    string want = exeName.Trim();
    if (want.Length < 3) return IntPtr.Zero;
    if (!want.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) want = want + ".exe";
    foreach (Process p in Process.GetProcesses()) {
      try {
        string pn = p.ProcessName + ".exe";
        if (!string.Equals(pn, want, StringComparison.OrdinalIgnoreCase)) continue;
        IntPtr h = Biggest((uint)p.Id);
        if (h == IntPtr.Zero) h = p.MainWindowHandle;
        if (h != IntPtr.Zero) return h;
      } catch { }
    }
    return IntPtr.Zero;
  }
  // 取该进程主窗口的标题。SMTC 会话为空时（网易云不注册），标题里的「歌名 - 歌手」
  // 是唯一还能拿到的曲目信息——它把歌名放在自己窗口标题上（实测「梦哑 - 任然」）。
  // 不能再用 Process.MainWindowTitle：实测网易云会把 MainWindowHandle 指到一个
  // 109x26 的 Chrome_WidgetWin_0（标题为空），于是标题、进度条一起失效。
  // 改成「面积最大的可见窗口 + GetWindowText」才稳定。
  public static string TitleOf(string exeName) {
    if (exeName == null) return "";
    string want = exeName.Trim();
    if (want.Length < 3) return "";
    if (!want.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) want = want + ".exe";
    string fallback = "";
    foreach (Process p in Process.GetProcesses()) {
      try {
        if (!string.Equals(p.ProcessName + ".exe", want, StringComparison.OrdinalIgnoreCase)) continue;
        // 网易云一次开三个进程，只有其中一个有真窗口。不能遇到第一个同名进程就返回：
        // 先碰到的往往是无窗口的辅助进程，直接返回空串会让标题、进度条一起失效。
        IntPtr h = Biggest((uint)p.Id);
        if (h != IntPtr.Zero) {
          StringBuilder sb = new StringBuilder(1024);
          if (GetWindowText(h, sb, sb.Capacity) > 0) return sb.ToString();
        }
        if (fallback.Length == 0) {
          string t = p.MainWindowTitle;
          if (t != null && t.Length > 0) fallback = t;
        }
      } catch { }
    }
    return fallback;
  }
  // 点进度条之前必须把窗口置前台（实测 2026-11-17）。
  // SetCursorPos + mouse_event 是「真实鼠标」事件，落在屏幕坐标上；窗口被别的窗口盖住时
  // 点到的就是遮挡物，进度条纹丝不动（实测 BEFORE 0.8494 / AFTER 0.8554 = 没跳）。
  // 置前台后同一段代码一次成功（BEFORE 0.9205 / AFTER 0.2619）。
  // 注意：抓图（PrintWindow）不需要前台，只有点击需要，所以只在 ClickPct 里调。
  public static bool Activate(IntPtr h) { return Activate(h, true); }
  // useKey=false 时不发媒体键。降级路径的 toggle/next/prev 要自己发媒体键，
  // 若先调 Activate 再发，前台锁解开时那次「试探性」0xB3 会把播放状态切一下，
  // 紧接着自己发的 0xB3 又切回去——两次抵消，表现就是「播放键按了没反应」。
  public static bool Activate(IntPtr h, bool useKey) {
    if (h == IntPtr.Zero) return false;
    try { ShowWindow(h, 9); } catch { }
    try {
      if (SetForegroundWindow(h)) return true;
    } catch { }
    if (!useKey) return false;
    // SetForegroundWindow 在前台锁定时会失败（返回 false）。媒体键一按，系统会把
    // 目标当「用户刚交互过的进程」放行，这是绕开前台锁最省事的一条路（实测有效）。
    try { MediaKey(0xB3); } catch { }
    try { System.Threading.Thread.Sleep(120); return SetForegroundWindow(h); } catch { return false; }
  }
  // 发一个媒体键（0xB3 = 播放/暂停，0xB0 = 下一首，0xB1 = 上一首）。
  // SMTC 会话不存在时（网易云这版就不注册），媒体键是唯一还能控制它的途径。
  public static void MediaKey(int vk) {
    keybd_event((byte)vk, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(40);
    keybd_event((byte)vk, 0, 2, IntPtr.Zero);
  }
  static bool IsRed(Color c) { return c.R > 150 && (c.R - c.G) > 55 && (c.R - c.B) > 35; }
  static int Df(Color a, Color b) {
    int dr = Math.Abs(a.R - b.R), dg = Math.Abs(a.G - b.G), db = Math.Abs(a.B - b.B);
    int m = dr > dg ? dr : dg;
    return m > db ? m : db;
  }
  // 饱和度（max-min）。深色主题下「未播段」仍是中性浅灰，靠饱和度就能和粉红已播段分开；
  // 不再靠 IsRed（粉红 R-G=123 其实满足旧的 IsRed，真正让旧判据崩的是「单分界」这个假设）。
  static int Sat(Color c) {
    int mx = c.R > c.G ? (c.R > c.B ? c.R : c.B) : (c.G > c.B ? c.G : c.B);
    int mn = c.R < c.G ? (c.R < c.B ? c.R : c.B) : (c.G < c.B ? c.G : c.B);
    return mx - mn;
  }
  // 一行的进度条模型（实测 2026-11-17，网易云 3.1.41 正在播放页）：
  //   已播段 x=0..playedEnd（内部是渐变，右端最亮），未播段 playedEnd+1..w-1（一整段同色）。
  // 判据演进史（别再走回头路）：
  //   ① 最早要求「整行铺满 + 单分界 + 至少一侧红」——只在浅色主题成立，深色主题全灭；
  //   ② 改要求「未播段必须是中性灰」——绿色/暗棕主题未播段饱和度 19~33，又全灭；
  //   ③ 现版：未播段「一整段均匀」（主题无关，实测四主题差 ≤3，而背景是渐变的）；
  //   ④ 已播段「有色相」或「明显更亮」二者取一（点击后窗口进入 hover 会把整条渐变灰化）。
  // 试过但**失败**的两条路，别再试：
  //   · 全宽锚定（barStart 固定 0、pct=playedEnd/w）：已播段左端与背景色差不足时会把
  //     背景渐变带认成进度条，barPct 卡在假值 0.8615 不动；
  //   · 双帧差分（隔 650ms 抓两帧认分界右移）：唱片机唱臂的亮色圆弧也在移动，
  //     被当成进度条，读数乱跳。
  static bool Row(Bitmap b, int y, out int barStart, out int playedEnd, out int barEnd) {
    barStart = -1; playedEnd = -1; barEnd = -1;
    int w = b.Width;
    Color off = b.GetPixel(w - 1, y);
    int x = w - 1;
    while (x >= 0 && Df(b.GetPixel(x, y), off) <= 18) x--;
    int offL = x;                                     // 未播段左端点（其左邻已是另一色）
    if (offL < 0 || (w - 1 - offL) < 4) return false; // 未播段太短，不是进度条（或已播到尽头）
    int offLen = w - 1 - offL;
    for (int k = 1; k <= 3; k++) {
      int sx = offL + 1 + (offLen * k) / 4;
      if (sx > w - 1) sx = w - 1;
      if (Df(b.GetPixel(sx, y), off) > 8) return false;
    }
    playedEnd = offL;
    int p = offL;
    while (p >= 0 && Df(b.GetPixel(p, y), off) > 18) p--;
    barStart = p + 1;
    barEnd = w - 1;
    int playedLen = playedEnd - barStart + 1;
    // ⑤ 滑块确认：绿色/橄榄色主题（如「颜色 / Gareth.T」）里已播段与背景只差
    //    20 级，向左扫同色会把 barStart 落到分界左边几像素（实测 s=763,p=766），
    //    于是 playedLen=4 过不了下面的门槛。但**分界位置本身是准的**（offL=766
    //    → 766/1321=0.58，与真实进度一致），只要确认分界上确实贴着那个白色小滑块
    //    （实测 x=764..766、色 (235,236,232)、亮度比未播段高 180），就说明这是
    //    真进度条，把 barStart 固定为 0（全宽锚定）。
    int thumb = ThumbX(b, y, off);
    if (thumb > 0 && Math.Abs(thumb - offL) <= 14) {
      playedEnd = thumb;
      barStart = 0;
      return true;
    }
    if (playedLen < 6) return false;                  // 已播段为空（刚开播）不认
    // 取样点必须紧贴分界左侧：已播段内部是渐变，从左边取会和背景混在一起
    // （实测绿色主题左端 (41,53,33) 与未播段 (37,49,30) 只差 4）。
    Color on = b.GetPixel(playedEnd - Math.Min(12, Math.Max(1, playedLen / 2)), y);
    if (Df(on, off) < 40) return false;               // 两段色差太小
    if (Sat(on) >= 40) return true;                   // 有色相 ⇒ 真进度条
    // 无饱和度（hover 灰度态）时退化判据：已播段明显亮于未播段
    int lumOn = (on.R * 30 + on.G * 59 + on.B * 11) / 100;
    int lumOff = (off.R * 30 + off.G * 59 + off.B * 11) / 100;
    if (lumOn - lumOff >= 25) return true;
    return ThumbRow(b, y, w, off);
  }
  // 滑块法（第四种定位方式，专治「已播段与背景同色」的主题）：
  // 绿色/橄榄色主题下已播段是 (145,159,48) 而背景 (53,56,22)，只有极小一段，
  // 真正的定位靠贴着分界的**白色小滑块**（实测宽 4px、颜色 (235,236,232)、
  // 亮度比未播段高 180+）。判据：在未播段里找到一段 2~8px 宽、亮度远超未播段的
  // 窄亮块，且它左右两侧都是未播段同色——那就是滑块，滑块中心即当前进度。
  static bool ThumbRow(Bitmap b, int y, int w, Color off) {
    return ThumbX(b, y, off) > 0;
  }
  // 滑块中心 x（读不到返回 -1）。
  // 实测「颜色 / Gareth.T」橄榄绿主题 y=837 的一行：
  //   762=(53,56,23) 763=(204,205,196) 764..766=(235,236,232) 767=(70,73,41) 768=(53,56,22)
  // 滑块本体 3~4px、亮度比未播段高 180+，但它左右各有 1~2px 抗锯齿过渡
  // （763 和 767 都不是纯未播段色），所以左右两侧都要允许跳过 1~3px 再比对，
  // 否则每行都会因为过渡色被判失败（实测就是这样：runLen=4 但右侧 767 差 52 被拒）。
  static int ThumbX(Bitmap b, int y, Color off) {
    int w = b.Width;
    int lumOff = (off.R * 30 + off.G * 59 + off.B * 11) / 100;
    int x = 0, runStart = -1, bestX = -1, bestLen = 0;
    while (x < w) {
      Color c = b.GetPixel(x, y);
      int lum = (c.R * 30 + c.G * 59 + c.B * 11) / 100;
      if ((lum - lumOff) >= 90) {
        if (runStart < 0) runStart = x;
      } else if (runStart >= 0) {
        int runLen = x - runStart;                    // 亮度块 [runStart, x-1]
        if (runLen >= 2 && runLen <= 10 && runStart > 0 && NearOff(b, y, runStart - 1, -1, off)
            && NearOff(b, y, x, 1, off)) {
          if (runLen > bestLen) { bestLen = runLen; bestX = (runStart + x - 1) / 2; }
        }
        runStart = -1;
      }
      x++;
    }
    return bestX;
  }
  // 从 x0 起沿 dir 方向最多看 3px，只要有一格回到未播段色就认为这一侧是「干净边界」。
  // 为的是跨过滑块自己的抗锯齿过渡像素，而不是把它们当成别的图形。
  static bool NearOff(Bitmap b, int y, int x0, int dir, Color off) {
    int w = b.Width;
    for (int k = 0; k < 3; k++) {
      int x = x0 + dir * k;
      if (x < 0 || x >= w) return false;
      if (Df(b.GetPixel(x, y), off) <= 12) return true;
    }
    return false;
  }
  // 给候选行打分。判据必须避开「底部控制条上的图标/文字行」：实测那些行也能通过
  // Row（off=(27,27,27)、offL≈84、playedLen 只有 11~17px），而且因为它们的 barStart
  // 比真进度条的 barStart 更靠左（真条已播段左端与背景同色，实测扫出 x=95），
  // 若按「条带宽度占比」打分反而会让假行胜出（12160 > 11980，抓到 y=903）。
  // 真正的区分点是**已播段长度**：真条 423px≈32% 窗宽，假行只有 1%。
  static int ScoreRow(Bitmap b, int y, int hh, out int s, out int p, out int e) {
    s = -1; p = -1; e = -1;
    if (!Row(b, y, out s, out p, out e)) return -1;
    int w = b.Width;
    // 滑块优先：见到贴着分界的白色小滑块就用它当分界（实测绿色主题已播段与背景
    // 几乎同色，靠颜色扫出来的 playedEnd 只能到 5px，完全反映不了真实进度）。
    Color off = b.GetPixel(w - 1, y);
    int tx = ThumbX(b, y, off);
    if (tx > 0) p = tx;
    double f = (double)(p + 1) / (double)w;           // 全宽锚定：网易云进度条铺满整窗宽
    if (!(f > 0.002 && f < 0.995)) return -1;         // 排除整行同色（Row 已挡大部分）
    // 已播段按「从窗口左缘到分界」算，不按 barStart 算：绿色主题已播段左端与背景
    // 同色，barStart 会落到分界左边几像素处，按它算 playedLen 恒为 4，整条作废。
    int playedLen = p + 1;
    if (playedLen * 50 < w) return -1;                // 已播段不足窗宽 2%：是图标/文字，不是进度条
    Color on = b.GetPixel(Math.Max(1, p - Math.Min(12, Math.Max(1, playedLen / 2))), y);
    bool warm = on.R > 110 && (on.R - on.B) > 20;
    bool bright = (on.R + on.G + on.B) > (off.R + off.G + off.B);
    // 已播段越长越可能是真进度条（占比 0..100 分），其余项只做小幅加权。
    return (int)(playedLen * 100.0 / (double)w) + Sat(on) * 20 + (warm ? 2500 : 0)
      + (bright ? 1200 : 0) + (y > hh * 55 / 100 ? 1500 : 0);
  }
  // "pct|yInWin|winW|winH|barStart|barEnd"，追加两个字段是为了让点击落在条带内而不是整窗宽
  public static string Probe(IntPtr h) {
    InitDpi();
    RECT r;
    if (!GetWindowRect(h, out r)) return "";
    int w = r.R - r.L;
    int hh = r.B - r.T;
    if (w < 200 || hh < 200 || w > 8000 || hh > 5000) return "";
    string res = "";
    Bitmap bmp;
    try { bmp = new Bitmap(w, hh); } catch { return ""; }
    try {
      using (bmp) {
        bool shot = false;
        using (Graphics g = Graphics.FromImage(bmp)) {
          IntPtr hdc = g.GetHdc();
          try { shot = PrintWindow(h, hdc, 2); } finally { g.ReleaseHdc(hdc); }
        }
        if (!shot) return "";
        int best = -1, bs = -1, bp = -1, be = -1, by = -1;
        int ch = 0, cs = -1, ce = -1, cys = -1;
        // 只在窗口下部 1/4 找：进度条贴着底部控制条，往上就是歌词/封面区，
        // 那里有成片的渐变和文字边缘，放进来只会制造假目标。
        int yTop = hh * 3 / 4;
        // 从下往上扫；进度条高度 2~12 行（含抗锯齿），超出的连续段一定是别的东西。
        // 注意：超过 12 行时**不能**把 ch 归零再继续——底部控制条的图标/按钮有几十行
        // 都满足 Row，归零会在这一大段中间重新起一个 2~12 行的假段，于是抓到控制条上的
        // 某个 mid 行（实测回报 y=903、pct=0.0643，而真进度条在 y=836）。改成「毒化」：
        // 一旦超长就置 -1，直到这一大段结束（出现 Row 不通过的行）才允许重新起段。
        for (int y = hh - 1; y >= yTop; y--) {
          int s, p, e;
          int sc = ScoreRow(bmp, y, hh, out s, out p, out e);
          if (sc > 0) {
            if (ch == 0) { cys = y; cs = s; ce = e; ch = 1; }
            else if (ch < 0) { /* 已在超长段内，继续吞掉 */ }
            else if (Math.Abs(e - ce) <= 4 && Math.Abs(s - cs) <= 4) { ch++; }
            else {
              if (ch >= 2 && ch <= 12) {
                int mid = cys - ch / 2; int s2, p2, e2;
                int sc2 = ScoreRow(bmp, mid, hh, out s2, out p2, out e2);
                if (sc2 > best) { best = sc2; bs = s2; bp = p2; be = e2; by = mid; }
              }
              cys = y; cs = s; ce = e; ch = 1;
            }
            if (ch > 12) ch = -1;
          } else {
            if (ch >= 2 && ch <= 12) {
              int mid = cys - ch / 2; int s2, p2, e2;
              int sc2 = ScoreRow(bmp, mid, hh, out s2, out p2, out e2);
              if (sc2 > best) { best = sc2; bs = s2; bp = p2; be = e2; by = mid; }
            }
            ch = 0;
          }
        }
        if (ch >= 2 && ch <= 12) {
          int mid = cys - ch / 2; int s2, p2, e2;
          int sc2 = ScoreRow(bmp, mid, hh, out s2, out p2, out e2);
          if (sc2 > best) { best = sc2; bs = s2; bp = p2; be = e2; by = mid; }
        }
        if (best < 0 || by < 0) return "";
        // 全宽锚定：网易云进度条从窗口最左铺到最右（实测四主题都是），所以比例直接用
        // playedEnd/w，点击也用整窗宽映射。用 (bp-bs+1)/(be-bs+1) 会让 bs 的抖动
        // （已播段左端与背景色差不定，实测扫出过 0/86/122 三种）直接变成几个百分点的偏差。
        double pct = (double)(bp + 1) / (double)w;
        if (pct < 0) pct = 0;
        if (pct > 1) pct = 1;
        res = Math.Round(pct, 4).ToString(CultureInfo.InvariantCulture) + "|" + by + "|" + w + "|" + hh
          + "|" + 0 + "|" + (w - 1);
      }
    } catch { return ""; }
    return res;
  }
  // 点进度条 pct 处，返回 "x,y"；读不到进度条返回空串
  public static string ClickPct(IntPtr h, double pct) {
    // 最小化时 GetWindowRect 只回一个 159x27 的图标位，Probe 必然失败。
    // 点击本来就需要窗口可见（鼠标事件落在屏幕坐标上），所以这里先还原。
    // 只在这一条路径上还原：poll 每秒都调 Probe，若也在那里还原，用户把网易云收起来
    // 听歌时窗口会被每秒弹出来一次，比不显示进度更烦人。
    try { if (IsIconic(h)) { ShowWindow(h, 9); System.Threading.Thread.Sleep(320); } } catch { }
    string info = Probe(h);
    if (info.Length == 0) return "";
    string[] parts = info.Split('|');
    if (parts.Length < 4) return "";
    int y; int w;
    if (!int.TryParse(parts[1], out y)) return "";
    if (!int.TryParse(parts[2], out w)) return "";
    // 条带左右端以 Probe 回报为准（老格式没有这两个字段时退回整窗宽）
    int bs = 0, be = w - 1;
    if (parts.Length >= 6) {
      int.TryParse(parts[4], out bs);
      int.TryParse(parts[5], out be);
    }
    if (be <= bs) { bs = 0; be = w - 1; }
    RECT r;
    if (!GetWindowRect(h, out r)) return "";
    // 必须先置前台：实测窗口不在前台时 SetCursorPos+mouse_event 点不动（点到遮挡物上）。
    Activate(h);
    System.Threading.Thread.Sleep(120);
    if (!GetWindowRect(h, out r)) return "";
    int tx = r.L + bs + (int)Math.Round((be - bs) * pct);
    if (tx < r.L + bs + 4) tx = r.L + bs + 4;
    if (tx > r.L + be - 2) tx = r.L + be - 2;
    int ty = r.T + y;
    SetCursorPos(tx, ty);
    System.Threading.Thread.Sleep(160);
    mouse_event(0x02, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(100);
    mouse_event(0x04, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(480);
    return tx.ToString(CultureInfo.InvariantCulture) + "," + ty.ToString(CultureInfo.InvariantCulture);
  }
}
'@
try {
  Add-Type -AssemblyName System.Drawing
  Add-Type -TypeDefinition $barSrc -ReferencedAssemblies System.Drawing
} catch {
  Emit @{ type = "error"; msg = ("进度条点击能力不可用：" + [string]$_.Exception.Message) }
}

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

# 「窗口进度条」读取缓存。PrintWindow 一次 94ms，poll 是 1 秒一次，
# 每帧都抓会让桥接进程白烧 CPU，所以最多每 2 秒重抓一次，其余帧复用上次结果。
# 只在「播放器根本不报时长」（duration<=0，网易云就是这种）时才去抓——能报时长的
# 播放器（汽水音乐等）走 SMTC 就够准了，没必要多此一举。
$script:barPct = -1.0
$script:barAt = [DateTimeOffset]::MinValue
$script:barTitle = ""
# PrintWindow 不是百分百可靠：窗口被别的窗口盖住、正在重绘的那一瞬都可能抓到空图。
# 抓到空图时如果如实返回 -1，界面上的进度条和「能不能拖」会每秒来回抖一次
# （实测 poll 序列 0.2447 / -1 / 0.2447 / -1 / -1 / 0.2447）。所以记住上一次成功值，
# 失败时在 10 秒内继续沿用它——进度条比例本来就是慢变量，10 秒内沿用不会看错。
$script:barGood = -1.0
$script:barGoodAt = [DateTimeOffset]::MinValue

function GetBarPct($title, $app) {
  if ([string]::IsNullOrEmpty($title) -or $title.Length -lt 2) { return -1.0 }
  $now = [DateTimeOffset]::Now
  $age = ($now - $script:barAt).TotalSeconds
  if ($title -eq $script:barTitle -and $age -ge 0 -and $age -lt 2) { return $script:barPct }
  $pct = -1.0
  try {
    # 先按窗口标题（「歌名 - 歌手」）找，找不到再按进程名兜底——
    # 用户切到歌单页时标题会变成「网易云音乐」，按标题就找不到窗口了。
    $h = [IslandBarClick]::FindByTitle($title)
    if ($h -eq [IntPtr]::Zero -and -not [string]::IsNullOrEmpty($app)) {
      $h = [IslandBarClick]::FindByExe($app)
    }
    if ($h -ne [IntPtr]::Zero) {
      # 抓一次抓不到就再试，最多 3 次。PrintWindow 在窗口正重绘（进度条在走）的那一瞬
      # 会抓到空图，实测单独跑脚本 8 次全成功、但放进每秒一次的 poll 里就一半失败。
      for ($try = 0; $try -lt 3; $try++) {
        $info = [IslandBarClick]::Probe($h)
        if (-not [string]::IsNullOrEmpty($info)) {
          $pct = [double]($info.Split('|')[0])
          if ($pct -lt 0) { $pct = 0 }
          if ($pct -gt 1) { $pct = 1 }
          break
        }
        Start-Sleep -Milliseconds 60
      }
    }
  } catch { $pct = -1.0 }
  if ($pct -ge 0) {
    $script:barGood = $pct
    $script:barGoodAt = $now
  } elseif (($now - $script:barGoodAt).TotalSeconds -lt 10) {
    # 这一帧没抓到，但 10 秒内有过成功值：沿用它，别让界面抖
    $pct = $script:barGood
  }
  # 只缓存成功值。失败若也写进缓存，2 秒内每一帧都会直接命中那条 -1，
  # 一次抓空就会污染后面两帧（实测 poll 序列 -1 / -1 / 0.2447 就是这么来的）。
  if ($pct -ge 0) {
    $script:barPct = $pct
    $script:barAt = $now
    $script:barTitle = $title
  }
  return $pct
}

# 读当前播放应用的音频会话音量：-1 表示对不上号（或读取失败），界面会置灰滑块。
# 绝不读系统主音量，也绝不因为读不到就回退到系统音量。
function GetAppVolume($app) {
  try { return [double][IslandAppVol.AppVol]::Get([string]$app) } catch { return -1 }
}

# ── SMTC 会话为空时的降级状态 ───────────────────────────────────────────
# 网易云 3.1.41.205564 实测根本不向 SMTC 注册：连采 8 次 COUNT=0，而同时音频会话
# state=1、峰值在波动、窗口标题在换歌——它就是没上这条船。桥接若只在有会话时工作，
# 这颗岛对它就是个摆设。降级路径用四样东西拼出等价状态：
#   ActiveList() → 谁在出声（进程名,pid,state）
#   TitleOf(exe) → 歌名（它把「歌名 - 歌手」直接写在窗口标题上）
#   Peak(exe)    → 是否真在出声（暂停时实测归零，出声时 0.002~0.009）
#   GetBarPct()  → 进度（PrintWindow 抓它自己的进度条）
# 时长拿不到（播放器不报 EndTime），交给渲染层用歌词库时长补，这里只回 0。
$script:fbExe = ""
$script:fbPct = -1.0
$script:fbPlaying = $false
# 把上次认到的播放器记到脚本旁边的小文件里。
# 为什么要落盘：程序冷启动时若网易云正好处于暂停态（音频会话已被它自己撤掉），
# 第一帧 ActiveList 就是空的，$fbExe 也是空的，界面会闪一下「现在没有在放歌」。
# 记住上次的进程名就能让冷启动第一帧直接认出它（实测重启后首帧 active=false 即此因）。
$script:fbStateFile = [System.IO.Path]::Combine($PSScriptRoot, "last-player.txt")
try {
  if ([System.IO.File]::Exists($script:fbStateFile)) {
    $saved = ([System.IO.File]::ReadAllText($script:fbStateFile)).Trim()
    if (-not [string]::IsNullOrEmpty($saved)) { $script:fbExe = $saved }
  }
} catch { }

function SaveFbExe($exe) {
  try {
    if ([string]::IsNullOrEmpty($exe)) { return }
    if ($exe -eq $script:fbSavedExe) { return }
    [System.IO.File]::WriteAllText($script:fbStateFile, $exe)
    $script:fbSavedExe = $exe
  } catch { }
}
$script:fbSavedExe = $script:fbExe

function GetFallback() {
  try { $list = [IslandAppVol.AppVol]::ActiveList() } catch { $list = "" }
  $best = $null
  $bestScore = -1
  if (-not [string]::IsNullOrEmpty($list)) {
    foreach ($item in $list.Split(';')) {
      $f = $item.Split(',')
      if ($f.Length -lt 3) { continue }
      $exe = [string]$f[0]
      # 注意：变量名不能叫 $pid —— 那是 PowerShell 的只读自动变量（当前进程 ID）。
      $procId = 0
      [void][int]::TryParse([string]$f[1], [ref]$procId)
      $st = 0
      [void][int]::TryParse([string]$f[2], [ref]$st)
      $t = ""
      try { $t = [IslandBarClick]::TitleOf($exe) } catch { $t = "" }
      # 没有主窗口的会话（系统音效、后台更新进程）不能用：抓进度条和点击都靠窗口
      if ([string]::IsNullOrEmpty($t)) { continue }
      # 打分：正在出声 > 标题带「 - 」（说明在放歌）> 上次认过的那个
      $score = 0
      if ($st -eq 1) { $score += 100 }
      if ($t.Contains(" - ")) { $score += 50 }
      if ($exe -eq $script:fbExe) { $score += 30 }
      if ($score -gt $bestScore) {
        $bestScore = $score
        $best = @{ exe = $exe; procId = $procId; state = $st; title = $t; live = $true }
      }
    }
  }
  # 网易云一暂停就把音频会话整条撤掉（实测：暂停后 persess 里 cloudmusic 直接消失），
  # 只靠 ActiveList 会让界面在「按暂停」的瞬间变成空态——用户看到的是「按钮没反应」。
  # 所以会话消失后仍认上次那个播放器，只要它的窗口还在（标题还能读到）。
  if ($null -eq $best -and $script:fbExe -ne "") {
    $t2 = ""
    try { $t2 = [IslandBarClick]::TitleOf($script:fbExe) } catch { $t2 = "" }
    if (-not [string]::IsNullOrEmpty($t2)) {
      $best = @{ exe = $script:fbExe; procId = 0; state = 0; title = $t2; live = $false }
    }
  }
  if ($null -eq $best) { return $null }
  $exe = [string]$best.exe
  $title = [string]$best.title
  # 「歌名 - 歌手」拆开：只在第一个 " - " 处断，歌名里带横线也不会拆坏
  $song = $title
  $artist = ""
  $sep = $title.IndexOf(" - ")
  if ($sep -gt 0) {
    $song = $title.Substring(0, $sep).Trim()
    $artist = $title.Substring($sep + 3).Trim()
  }
  $pct = GetBarPct $title $exe
  $peak = -1.0
  try { $peak = [double][IslandAppVol.AppVol]::Peak($exe) } catch { $peak = -1.0 }
  # 判「在播/暂停」：以**音频峰值**为准（实测这台机器上它极其干净：在播 0.002~0.005，
  # 暂停恒为 0.00000，相差三个数量级）。
  # 不能再用「进度在前进」当在播证据：网易云暂停时不会立刻把音频会话撤掉（state 仍为 1），
  # 而进度条的读数在两帧之间可能刚好前进了 0.005（暂停发生在两次采样之间），
  # 那样会把「已经暂停」误判成「在播」，界面按钮就一直显示暂停图标。
  # 峰值取不到（<0，说明没匹配到会话）时才退回进度判据。
  $playing = $script:fbPlaying
  if (-not [bool]$best.live) {
    # 会话都不在了 = 播放器自己撤了音频流 = 暂停。这时不能沿用上一帧的 true，
    # 否则歌词会一直滚（实测过：暂停后歌词还在走，比不放歌更迷惑）。
    $playing = $false
  } elseif ($peak -gt 0.0008) {
    $playing = $true
  } elseif ($peak -ge 0 -and $peak -le 0.0002) {
    $playing = $false
  } elseif ($pct -ge 0 -and $script:fbPct -ge 0 -and ($pct - $script:fbPct) -gt 0.0008) {
    $playing = $true
  }
  $script:fbExe = $exe
  $script:fbPct = $pct
  $script:fbPlaying = $playing
  SaveFbExe $exe
  return @{ exe = $exe; title = $song; artist = $artist; playing = $playing; pct = $pct }
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
    if ($idx -lt 0) {
      # 无 SMTC 会话时音量仍然可调：降级路径认得那个进程，直接按进程名找它的音频会话。
      $fb = GetFallback
      if ($null -eq $fb) { Emit @{ type = "ack"; cmd = "volume"; ok = $false }; continue }
      try {
        $v = [double]$val
        if ($v -lt 0) { $v = 0 }
        if ($v -gt 1) { $v = 1 }
        $ok = [IslandAppVol.AppVol]::Set([string]$fb.exe, [float]$v)
        Emit @{ type = "ack"; cmd = "volume"; ok = [bool]$ok }
      } catch {
        Emit @{ type = "ack"; cmd = "volume"; ok = $false }
      }
      continue
    }
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

  # 点播放器自己的进度条（用户 m07228 要求「做不到也要做」）。
  # 只在播放器不实现 SMTC 定位时才该走到这里；能走 SMTC 的一律用 seek，别去点人家窗口。
  # 找窗口靠「窗口标题包含当前歌名」，因为汽水音乐这类 SMTC 标识和进程名根本对不上。
  if ($cmd -eq "barseek") {
    $want = [double]$val
    if ($want -lt 0) { $want = 0 }
    if ($want -gt 1) { $want = 1 }
    if ($idx -lt 0) {
      # 没有 SMTC 会话时也允许点进度条：网易云这版只能靠窗口坐标操作。
      # 歌名从窗口标题取（降级路径拿不到就用 FindByExe 兜底）。
      try {
        $fb = GetFallback
        $tk = ""
        $ak = ""
        if ($null -ne $fb) { $tk = [string]$fb.title; $ak = [string]$fb.exe }
        $h = [IntPtr]::Zero
        if (-not [string]::IsNullOrEmpty($tk)) { $h = [IslandBarClick]::FindByTitle($tk) }
        if ($h -eq [IntPtr]::Zero -and -not [string]::IsNullOrEmpty($ak)) { $h = [IslandBarClick]::FindByExe($ak) }
        if ($h -ne [IntPtr]::Zero) {
          $hit = [IslandBarClick]::ClickPct($h, $want)
          if ([string]::IsNullOrEmpty($hit)) {
            Emit @{ type = "ack"; cmd = "barseek"; ok = $false }
          } else {
            Emit @{ type = "ack"; cmd = "barseek"; ok = $true }
          }
        } else {
          Emit @{ type = "ack"; cmd = "barseek"; ok = $false }
        }
      } catch {
        Emit @{ type = "ack"; cmd = "barseek"; ok = $false }
      }
      continue
    }
    try {
      $s = @($sessions)[$idx]
      $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $hit = ""
      # 标题可能带后缀（网易云主窗标题形如「歌名 - 歌手」），先整串找，找不到再只取歌名找
      $t = [string]$props.Title
      if (-not [string]::IsNullOrEmpty($t)) {
        $h = [IslandBarClick]::FindByTitle($t)
        if ($h -ne [IntPtr]::Zero) { $hit = [IslandBarClick]::ClickPct($h, $want) }
      }
      if ([string]::IsNullOrEmpty($hit)) {
        Emit @{ type = "ack"; cmd = "barseek"; ok = $false }
      } else {
        Emit @{ type = "ack"; cmd = "barseek"; ok = $true }
      }
    } catch {
      Emit @{ type = "ack"; cmd = "barseek"; ok = $false }
    }
    continue
  }

  if ($cmd -eq "poll") {
    if ($idx -lt 0) {
      # SMTC 会话为空 ≠ 没有播放器。网易云这版就是不注册 SMTC，先试试降级路径；
      # 降级也拿不到（真的没在放歌）才发空态。空态也要把新字段补齐，渲染层才不会读到 undefined。
      $fb = GetFallback
      if ($null -ne $fb) {
        $fbVolRaw = GetAppVolume $fb.exe
        $fbCanVol = $false
        $fbVol = 0
        if ($fbVolRaw -ge 0) { $fbCanVol = $true; $fbVol = [math]::Round($fbVolRaw, 3) }
        $fbLive = $fb.playing
        # 暂停时进度条不动，位置就是 barPct；在播时渲染层用自算钟往前推（见 _fb 标记）
        Emit ([ordered]@{
          type = "state"
          active = $true
          title = $fb.title
          artist = $fb.artist
          album = ""
          position = 0
          duration = 0
          playing = [bool]$fbLive
          app = $fb.exe
          shuffle = $false
          repeat = 0
          volume = $fbVol
          canSeek = $false
          canShuffle = $false
          canRepeat = $false
          canVolume = $fbCanVol
          cover = ""
          barPct = [math]::Round([double]$fb.pct, 4)
          barOk = [bool]([double]$fb.pct -ge 0)
          fallback = $true
        })
        continue
      }
      Emit @{ type = "state"; active = $false; title = ""; artist = ""; album = ""; position = 0; duration = 0; playing = $false; app = ""; shuffle = $false; repeat = 0; volume = 0; canSeek = $false; canShuffle = $false; canRepeat = $false; canVolume = $false; cover = ""; barPct = -1; barOk = $false; fallback = $false }
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
      # 播放器自己报不出时长（网易云：EndTime 恒 0）时，去它的窗口里找那条进度条。
      # barOk=true 表示「能读到它的真实进度、也能点它跳」，界面才允许拖；
      # barPct 是 0..1 的已播比例，乘以歌词库时长就是比自算墙钟更准的位置。
      $barPct = -1.0
      if ($endSec -le 0) { $barPct = GetBarPct $titleStr $appId }
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
        barPct = [math]::Round($barPct, 4)
        barOk = [bool]($barPct -ge 0)
      })
    } catch {
      # 把异常文本吐出去，别再静默发空态——静默会让人误以为「本机没有播放器」
      Emit @{ type = "error"; msg = ([string]$_.Exception.Message) }
    }
    continue
  }

  if ($idx -lt 0) {
    # 无 SMTC 会话时的按键兜底：toggle/next/prev 用媒体键直接敲播放器。
    # 媒体键是全局的，只有「降级路径认得出正在放歌的那个应用」时才按——否则会去操纵
    # 用户根本没在用的播放器，比按钮失灵更糟。
    if ($cmd -eq "toggle" -or $cmd -eq "next" -or $cmd -eq "prev") {
      $fb = GetFallback
      if ($null -ne $fb) {
        $vk = 0xB3
        if ($cmd -eq "next") { $vk = 0xB0 }
        if ($cmd -eq "prev") { $vk = 0xB1 }
        $ok = $false
        try {
          $h = [IslandBarClick]::FindByExe($fb.exe)
          if ($h -ne [IntPtr]::Zero) {
            # 先置前台：媒体键本身不需要，但如果该进程有前台锁，keybd_event 也会被吞。
            # useKey=false：这里马上要自己发一次媒体键，Activate 不能再发。
            [void][IslandBarClick]::Activate($h, $false)
          }
          [IslandBarClick]::MediaKey($vk)
          $ok = $true
        } catch { $ok = $false }
        Emit @{ type = "ack"; cmd = $cmd; ok = $ok }
        continue
      }
    }
    Emit @{ type = "ack"; cmd = $cmd; ok = $false }
    continue
  }

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
