#!/usr/bin/env node
/**
 * e2e SPEC-music-page 多会话回归：桥接必须能读到「正在播放但不在索引 0」的会话
 *
 * 为什么单独一个脚本：主 e2e（e2e-music.mjs）依赖本机正在用的播放器，跑的时候只有 1 个会话，
 * 索引恒为 0，恰好命中 PowerShell 的一个坑——`$mgr.GetSessions()` 是 System.__ComObject 包装的
 * WinRT IVectorView，裸索引 `$sessions[$i]` 只有 [0] 有效，[1] 及以后一律 $null。旧代码就是
 * 裸索引取会话，单会话时完全看不出来，用户同时开着两个播放器就恒显示「现在没有在放歌」。
 * 这个脚本自己造出 2 个假会话（播放静音 wav），把「正在播放」推到索引 > 0 上。
 *
 * 副作用与保护：
 *   - 会临时暂停本机正在播放的播放器（否则它会是那个 Playing），结束前恢复；
 *   - 只在 .tmp 里生成静音 wav，跑完删除；不改用户任何文件；
 *   - 没有播放器在跑时也照样能跑（那时索引 0 就是静音会话，判别力靠 B3 断言兜底）。
 *
 * 跑前：npm run build（脚本直接跑源码里的脚本内容，不需要构建，但保持和其他 e2e 一致）。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const TMP = join(ROOT, '.tmp')
const PS_BRIDGE = join(TMP, 'e2e-session-bridge.ps1')
const PS_SCENE = join(TMP, 'e2e-session-scene.ps1')
const WAV_A = join(TMP, 'e2e-silence-a.wav')
const WAV_B = join(TMP, 'e2e-silence-b.wav')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BOM = Buffer.from([0xef, 0xbb, 0xbf])

let passed = 0
let failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`) }
}

/** 写 .ps1：必须带 UTF-8 BOM，否则 PS 5.1 按 ANSI 解码会把 WinRT 类型名解坏 */
const writePs1 = (file, text) => writeFileSync(file, Buffer.concat([BOM, Buffer.from(text, 'utf8')]))

function makeSilentWav(file, seconds = 30, rate = 8000) {
  const samples = rate * seconds
  const data = Buffer.alloc(samples * 2) // 16-bit PCM 全 0 = 静音
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(data.length, 40)
  writeFileSync(file, Buffer.concat([h, data]))
}

/** 从 src/main/smtcScript.ts 取出被测的 PowerShell 正文（String.raw 模板，文件以反引号收尾） */
function extractBridgeScript() {
  const src = readFileSync(join(ROOT, 'src/main/smtcScript.ts'), 'utf8')
  const m = /String\.raw`([\s\S]*)`\s*$/.exec(src)
  if (!m) throw new Error('无法从 src/main/smtcScript.ts 取出脚本正文')
  return m[1]
}

const SCENE_PS1 = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
[void][Windows.Media.Playback.MediaPlayer, Windows.Media.Playback, ContentType=WindowsRuntime]
[void][Windows.Media.Core.MediaSource, Windows.Media.Core, ContentType=WindowsRuntime]
[void][Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
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
function GetMgr {
  Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
}

$players = @()
foreach ($n in @('e2e-silence-a.wav', 'e2e-silence-b.wav')) {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Join-Path $env:E2E_TMP $n))) ([Windows.Storage.StorageFile])
  $p = New-Object Windows.Media.Playback.MediaPlayer
  $p.Source = [Windows.Media.Core.MediaSource]::CreateFromStorageFile($file)
  $p.IsLoopingEnabled = $true
  $p.Volume = 0
  $players += $p
  Start-Sleep -Milliseconds 300
}

# 把系统里其它正在播放的会话暂停掉（否则它才是那个 Playing），记下谁被暂停过
$paused = @()
foreach ($s in @((GetMgr).GetSessions())) {
  if ([string]$s.SourceAppUserModelId -like "*powershell*") { continue }
  try {
    if ($s.GetPlaybackInfo().PlaybackStatus.ToString() -eq "Playing") {
      Await ($s.TryPauseAsync()) ([bool]) | Out-Null
      $paused += [string]$s.SourceAppUserModelId
    }
  } catch { }
}
Start-Sleep -Milliseconds 500

# 只让 a 播、b 暂停
$players[1].Pause()
Start-Sleep -Milliseconds 400
$players[0].Play()
Start-Sleep -Seconds 1

$mgr = GetMgr
$sessions = $mgr.GetSessions()
$count = @($sessions).Count
$playingIdx = -1
[Console]::Out.WriteLine("SESSIONS=$count")
for ($i = 0; $i -lt $count; $i++) {
  $bare = $sessions[$i]
  $wrapped = @($sessions)[$i]
  $st = "-"
  if ($null -ne $wrapped) { try { $st = $wrapped.GetPlaybackInfo().PlaybackStatus.ToString() } catch { $st = "err" } }
  if ($st -eq "Playing" -and $playingIdx -lt 0) { $playingIdx = $i }
  [Console]::Out.WriteLine("i=$i bare=$(if ($null -eq $bare) { 'NULL' } else { 'obj' }) wrapped=$(if ($null -eq $wrapped) { 'NULL' } else { 'obj' }) status=$st")
}
[Console]::Out.WriteLine("PLAYING_IDX=$playingIdx")
[Console]::Out.WriteLine("PAUSED_APPS=$($paused -join ',')")
[Console]::Out.Flush()

# 保持场景 40 秒等外部读取
Start-Sleep -Seconds 40

foreach ($p in $players) { try { $p.Pause() } catch { } ; try { $p.Dispose() } catch { } }
# 恢复原来在播的播放器
if ($paused.Count -gt 0) {
  foreach ($s in @((GetMgr).GetSessions())) {
    $app = [string]$s.SourceAppUserModelId
    if ($paused -contains $app) { try { Await ($s.TryPlayAsync()) ([bool]) | Out-Null } catch { } }
  }
  [Console]::Out.WriteLine("RESTORED=$($paused -join ',')")
  [Console]::Out.Flush()
}
`

let sceneProc = null
let bridgeProc = null

try {
  mkdirSync(TMP, { recursive: true })
  makeSilentWav(WAV_A)
  makeSilentWav(WAV_B)
  writePs1(PS_BRIDGE, extractBridgeScript())
  writePs1(PS_SCENE, SCENE_PS1)

  sceneProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS_SCENE], {
    windowsHide: true,
    env: { ...process.env, E2E_TMP: TMP }
  })
  let sceneOut = ''
  sceneProc.stdout.setEncoding('utf8')
  sceneProc.stdout.on('data', (d) => { sceneOut += d })
  sceneProc.stderr.setEncoding('utf8')
  sceneProc.stderr.on('data', (d) => { sceneOut += '[err] ' + d })
  await sleep(7000)

  for (const l of sceneOut.trim().split(/\r?\n/)) console.log('  · ' + l)
  const sessions = Number(/SESSIONS=(\d+)/.exec(sceneOut)?.[1] ?? 0)
  const playingIdx = Number(/PLAYING_IDX=(-?\d+)/.exec(sceneOut)?.[1] ?? -1)
  const bareNullAboveZero = /i=[1-9]\d* bare=NULL/.test(sceneOut)

  ok('S1 造出了 2 个以上 SMTC 会话（否则这个回归没有意义）', sessions >= 2, `实际 ${sessions}`)
  ok('S2 正在播放的会话确实不在索引 0（构造出目标场景）', playingIdx > 0, `PLAYING_IDX=${playingIdx}`)
  // 前置事实：这正是被修的那个坑——裸索引在 >0 上回 $null，@() 包装后正常
  ok('S3 前置事实成立：裸索引在索引 >0 上是 $null，@() 包装后是对象',
    bareNullAboveZero, '如果没有这一行，说明本机 PowerShell 行为与修复时不同，需要重新评估')

  const bridge = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS_BRIDGE], { windowsHide: true })
  bridgeProc = bridge
  let buf = ''
  const lines = []
  bridge.stdout.setEncoding('utf8')
  bridge.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (l) lines.push(l)
    }
  })
  bridge.stderr.setEncoding('utf8')
  bridge.stderr.on('data', (d) => { lines.push('[stderr] ' + d.trim().slice(0, 200)) })
  const send = (cmd) => bridge.stdin.write(cmd + '\n')

  await sleep(2500)
  ok('S4 桥接起来了（收到 ready）', lines.some((l) => l.includes('"ready"')), JSON.stringify(lines.slice(0, 3)))

  // 收 ready 之后清一下，后面只关心 poll 结果
  const states = []
  const errors = []
  for (let k = 0; k < 3; k++) {
    lines.length = 0
    send('poll')
    await sleep(1200)
    for (const l of lines) {
      try {
        const o = JSON.parse(l)
        if (o.type === 'state') states.push(o)
        if (o.type === 'error') errors.push(o.msg)
      } catch { /* 非 JSON 行（含 stderr）忽略 */ }
    }
  }

  ok('S5 三次 poll 都读到活动会话（旧代码在这里恒为空态）',
    states.length >= 3 && states.every((s) => s.active === true),
    `state=${JSON.stringify(states[0] ?? null)} error=${JSON.stringify(errors.slice(0, 2))}`)
  ok('S6 没有 error 帧（异常文本不再被静默吞掉）', errors.length === 0, JSON.stringify(errors.slice(0, 2)))
  ok('S7 挑中的正是「播放中」那一个', states.length > 0 && states.every((s) => s.playing === true),
    `playing=${JSON.stringify(states.map((s) => s.playing))}`)
  ok('S8 读到会话所属应用（对象取到才有 app）',
    states.length > 0 && typeof states[0].app === 'string' && states[0].app.length > 0,
    `app=「${states[0]?.app ?? ''}」`)

  // 命令通道在同一场景下也要能用
  lines.length = 0
  send('toggle')
  await sleep(1500)
  let ack = null
  for (const l of lines) { try { const o = JSON.parse(l); if (o.type === 'ack') ack = o } catch { /* ignore */ } }
  ok('S9 多会话下 toggle 回 ok:true', ack?.ok === true, JSON.stringify(ack))
  // 还原（toggle 改的是那个静音会话，本来就该恢复）
  send('toggle')
  await sleep(1200)

  // 未知命令只该回一条 ack（以前 switch 的 default 里 continue 之后还会落到后面再发一条）
  lines.length = 0
  send('bogus')
  await sleep(1200)
  const acks = lines.filter((l) => l.includes('"ack"') && l.includes('bogus')).length
  ok('S10 未知命令只回一条 ack', acks === 1, `实际 ${acks} 条`)
} catch (e) {
  failed++
  console.log('  ✗ 异常：' + (e?.stack ?? e?.message ?? e))
} finally {
  try { bridgeProc?.stdin?.end() } catch { /* ignore */ }
  try { bridgeProc?.kill() } catch { /* ignore */ }
  try { sceneProc?.kill() } catch { /* ignore */ }
  for (const f of [WAV_A, WAV_B, PS_BRIDGE, PS_SCENE]) {
    try { if (existsSync(f)) rmSync(f) } catch { /* ignore */ }
  }
}

console.log(`\nE2E MUSIC SESSION: ${failed > 0 ? 'FAIL' : 'PASS'}（${passed} 过 / ${failed} 败）`)
process.exit(failed > 0 ? 1 : 0)
