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
 */
export const SMTC_SCRIPT = String.raw`$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]

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

# 系统主音量（Core Audio / IAudioEndpointVolume）。SMTC 会话接口没有音量方法，
# 只能读写 Windows 默认音频输出设备的主音量——会影响所有程序声音，不是单个播放器音量。
# 必须用 C# COM interop：PowerShell 5.1 直接拿不到 IAudioEndpointVolume 的 COM 接口。
# 源码必须全 ASCII、无中文注释、here-string 结束符在行首；否则 PS 5.1 会把 C# 当 PS 解析。
# Add-Type -TypeDefinition 在本进程（已加载 WinRT 类型）实测编译成功，无需额外辅助进程。
$volSrc = @'
using System;
using System.Runtime.InteropServices;

namespace IslandVol {
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

  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioEndpointVolume {
    [PreserveSig] int RegisterControlChangeNotify(IntPtr pNotify);
    [PreserveSig] int UnregisterControlChangeNotify(IntPtr pNotify);
    [PreserveSig] int GetChannelCount(out int pnChannelCount);
    [PreserveSig] int SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);
    [PreserveSig] int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);
    [PreserveSig] int GetMasterVolumeLevel(out float pfLevelDB);
    [PreserveSig] int GetMasterVolumeLevelScalar(out float pfLevel);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid pguidEventContext);
    [PreserveSig] int GetMute(out bool pbMute);
    [PreserveSig] int GetVolumeStepInfo(out int pnStep, out int pnStepCount);
    [PreserveSig] int VolumeStepUp(ref Guid pguidEventContext);
    [PreserveSig] int VolumeStepDown(ref Guid pguidEventContext);
    [PreserveSig] int QueryHardwareSupport(out int pdwHardwareSupportMask);
    [PreserveSig] int GetVolumeRange(out float pflVolumeMindB, out float pflVolumeMaxdB, out float pflVolumeIncrementdB);
  }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  public class MMDeviceEnumeratorComObject { }

  public static class Vol {
    private static IAudioEndpointVolume Endpoint() {
      var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
      IMMDevice device;
      int hr = enumerator.GetDefaultAudioEndpoint(0, 1, out device);
      Marshal.ThrowExceptionForHR(hr);
      Guid iid = typeof(IAudioEndpointVolume).GUID;
      object o;
      hr = device.Activate(ref iid, 23, IntPtr.Zero, out o);
      Marshal.ThrowExceptionForHR(hr);
      return (IAudioEndpointVolume)o;
    }

    public static float Get() {
      float level;
      int hr = Endpoint().GetMasterVolumeLevelScalar(out level);
      Marshal.ThrowExceptionForHR(hr);
      return level;
    }

    public static void Set(float f) {
      Guid g = Guid.Empty;
      int hr = Endpoint().SetMasterVolumeLevelScalar(f, ref g);
      Marshal.ThrowExceptionForHR(hr);
    }
  }
}
'@
Add-Type -TypeDefinition $volSrc

$repeatEnumT = [Windows.Media.MediaPlaybackAutoRepeatMode, Windows.Media, ContentType=WindowsRuntime]

# 读系统主音量：失败时回 0（不让音量读不到连累整份状态快照）
function GetVolume() {
  try { return [math]::Round([double][IslandVol.Vol]::Get(), 3) } catch { return 0 }
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

  # 音量不依赖 SMTC 会话：没有播放器时也要能调（改的是系统主音量）
  if ($cmd -eq "volume") {
    try {
      $v = [double]$val
      if ($v -lt 0) { $v = 0 }
      if ($v -gt 1) { $v = 1 }
      [IslandVol.Vol]::Set([float]$v)
      Emit @{ type = "ack"; cmd = "volume"; ok = $true }
    } catch {
      Emit @{ type = "ack"; cmd = "volume"; ok = $false }
    }
    continue
  }

  $sessions = $mgr.GetSessions()
  $idx = PickIndex $sessions

  if ($cmd -eq "poll") {
    if ($idx -lt 0) {
      # 空态也要把新字段补齐，渲染层才不会读到 undefined
      Emit @{ type = "state"; active = $false; title = ""; artist = ""; album = ""; position = 0; duration = 0; playing = $false; app = ""; shuffle = $false; repeat = 0; volume = (GetVolume); canSeek = $false; canShuffle = $false; canRepeat = $false }
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
      Emit ([ordered]@{
        type = "state"
        active = $true
        title = [string]$props.Title
        artist = [string]$props.Artist
        album = [string]$props.AlbumTitle
        position = [math]::Round($tl.Position.TotalSeconds, 1)
        duration = [math]::Round($tl.EndTime.TotalSeconds, 1)
        playing = ($info.PlaybackStatus.ToString() -eq "Playing")
        app = [string]$s.SourceAppUserModelId
        shuffle = $shuffle
        repeat = $repeat
        volume = (GetVolume)
        canSeek = [bool]$ctrl.IsPlaybackPositionEnabled
        canShuffle = [bool]$ctrl.IsShuffleEnabled
        canRepeat = [bool]$ctrl.IsRepeatEnabled
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
