/**
 * SMTC 桥接脚本（SPEC-music-page）。
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
 * 协议（每行一条 JSON，UTF-8 无 BOM 输出）：
 *   stdin  ← "poll" / "toggle" / "next" / "prev"
 *   stdout → {"type":"state",...} 状态快照；{"type":"ack","cmd":...,"ok":bool} 命令回执
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

$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
Emit @{ type = "ready" }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq "") { continue }

  if ($line -eq "resync") {
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

  if ($line -eq "poll") {
    if ($idx -lt 0) {
      Emit @{ type = "state"; active = $false; title = ""; artist = ""; album = ""; position = 0; duration = 0; playing = $false; app = "" }
      continue
    }
    # 快照必须在这个作用域里直接取，且必须先 @() 再索引，原因见 PickIndex 上方的注释
    try {
      $s = @($sessions)[$idx]
      $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $tl = $s.GetTimelineProperties()
      $info = $s.GetPlaybackInfo()
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
      })
    } catch {
      # 把异常文本吐出去，别再静默发空态——静默会让人误以为「本机没有播放器」
      Emit @{ type = "error"; msg = ([string]$_.Exception.Message) }
    }
    continue
  }

  if ($idx -lt 0) { Emit @{ type = "ack"; cmd = $line; ok = $false }; continue }

  # 未知命令先挡掉，否则 switch 的 default 里 continue 之后还会落到下面那条 Emit，吐两条 ack
  if ($line -ne "toggle" -and $line -ne "next" -and $line -ne "prev") {
    Emit @{ type = "ack"; cmd = $line; ok = $false }
    continue
  }

  $s = @($sessions)[$idx]
  $ok = $false
  try {
    switch ($line) {
      "toggle" { $ok = Await ($s.TryTogglePlayPauseAsync()) ([bool]) }
      "next"   { $ok = Await ($s.TrySkipNextAsync()) ([bool]) }
      "prev"   { $ok = Await ($s.TrySkipPreviousAsync()) ([bool]) }
    }
  } catch {
    Emit @{ type = "ack"; cmd = $line; ok = $false }
    continue
  }
  Emit @{ type = "ack"; cmd = $line; ok = [bool]$ok }
}
`
