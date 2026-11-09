import { BrowserWindow, ipcMain, powerMonitor } from 'electron'

/** Wi-Fi / 网线状态（收起态 US-005）；读不到时 wifi 为 null，UI 不显示 */
export interface WifiSnapshot {
  /** 是否已连上 Wi-Fi（有 WLAN 连接配置即算连上，哪怕暂时上不了网） */
  connected: boolean
  /** 有网（任一 IPv4/IPv6 连接类别为 Internet） */
  online: boolean
  /** 当前 Wi-Fi 网络名（SSID），取不到为 null */
  name: string | null
  /** 连接方式：'wifi' 无线 / 'ethernet' 网线；主进程判定，渲染层只管选图标 */
  kind: 'wifi' | 'ethernet'
}

/** 收起态状态栏的数据快照 */
export interface StatusSnapshot {
  /** 电量百分比 0-100；取不到时为 null */
  battery: number | null
  /** 是否正在充电 */
  charging: boolean
  /** Wi-Fi 状态；读不到时为 null（如命令失败、无 WLAN 接口） */
  wifi: WifiSnapshot | null
}

/** 缓存时长：只在没有事件驱动时才靠它兜底（插拔电源会主动作废缓存） */
const CACHE_MS = 30_000
/** 看门狗周期：只读 powerMonitor，不起子进程，所以可以比取数频繁得多 */
const WATCH_MS = 2_000
/** 事件到达后补读的延迟：经验值 600ms（系统状态机切换通常比事件晚几十到几百毫秒）。
 *  注：这个数字**没有实测依据**（本机电池恒 99% 插电，造不出真插拔的时序来量），
 *  独立验收 C4 已指出上一版注释误称「实测口径见 SPEC 第七节」。取 600ms 是在
 *  「等太久用户觉得慢」和「等太短读到旧值」之间的折中；真要定标需一次真机插拔配合打点。 */
const EVENT_SETTLE_MS = 600

let cache: StatusSnapshot = { battery: null, charging: false, wifi: null }
let cacheAt = 0
/** 上一次通过 powerMonitor 看到的「是否在用电池供电」，看门狗拿它比对 */
let lastOnBattery: boolean | null = null
let watchTimer: ReturnType<typeof setInterval> | null = null
let settleTimer: NodeJS.Timeout | null = null

/**
 * 读系统电量与网络状态（US-005 起在同一次子进程里取回，不新开进程）。
 * Electron 主进程没有现成 API，这里走 PowerShell CIM 查 Win32_Battery +
 * Get-NetConnectionProfile × Get-NetAdapter（按介质类型区分 Wi-Fi / 网线），
 * 10 秒超时，结果缓存 30 秒。
 * 注意：输出编码显式 UTF-8，否则中文 Wi-Fi 名（SSID）会乱码（实测踩坑）。
 */
function readStatus(): StatusSnapshot {
  try {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
    const script = [
      // 电量行（与 US-005 之前格式一致）：电量|是否充电中
      // 判据＝「不是放电状态」（BatteryStatus 不是 1，且 WMI 没报 Discharging）。
      // 用户口径（2026-11-09 17:37 原话「我现在冲着电，他是白的」）：插着电源就该显示充电态。
      // 不能只看 6/7/8/9——电池到 96% 后系统会停止充电但仍在供电，那时 BatteryStatus=2
      // （接交流电）或 3（已充满），只按 6-9 判就会漏掉，界面显示白弧，用户认为错。
      // 也不能用 `-eq 2`：那会连「拔了电但系统还认为在 AC」的情况一起算成充电。
      // 4/5（低电/临界）同样不能排除：插着电且电量低时必须走绿（充电优先），
      // 排除它们会让「15% 插着电」显示成低电红，与用户口径相反。
      // 实测记录见 docs/Spec/SPEC-battery-charging-accuracy.md 第九节。
      '$b=Get-CimInstance -ClassName Win32_Battery; $w=@(Get-CimInstance -Namespace root\\wmi -ClassName BatteryStatus -ErrorAction SilentlyContinue); if($b){"{0}|{1}" -f $b.EstimatedChargeRemaining, (($b.BatteryStatus -notin 1) -and -not [bool]($w|Where-Object {$_.Discharging}))}else{"null|false"}',
      // 网络行：net|IPv4类别|IPv6类别|接口名|介质类型|是否虚拟
      // 按 InterfaceIndex 关联连接配置与网卡：MediaType 802.11=无线 / 802.3=有线，
      // Virtual=True 是 VPN 等虚拟网卡（如 Radmin VPN），不算真网线（实测踩坑）
      '$ps=Get-NetConnectionProfile; $ads=Get-NetAdapter; foreach($p in $ps){ $a=$ads|Where-Object InterfaceIndex -eq $p.InterfaceIndex; "net|{0}|{1}|{2}|{3}|{4}" -f $p.IPv4Connectivity,$p.IPv6Connectivity,$p.Name,$a.MediaType,$a.Virtual }'
    ].join('; ')
    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${script}`],
      { timeout: 10_000, windowsHide: true, encoding: 'utf8' }
    )
    const out = r.stdout?.toString() ?? ''
    let battery: number | null = null
    let charging = false
    let wifi: WifiSnapshot | null = null
    // 逐行找：第一行电量，net| 开头的是网络行。
    // 多接口并存（Wi-Fi+网线同时插）时优先网线（更稳定，通常是有意为之），
    // 虚拟网卡（Virtual=True，如 VPN）跳过不算。
    for (const line of out.split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      if (t.startsWith('net|')) {
        const [, v4, v6, iface, media, virtual] = t.split('|')
        if (v4 === undefined) continue
        const isEthernet = media === '802.3' && virtual !== 'True'
        if (!isEthernet && media !== 'Native 802.11') continue // 蓝牙等其它介质不算
        const cand: WifiSnapshot = {
          connected: true,
          online: v4 === 'Internet' || v6 === 'Internet',
          name: iface?.trim() || null,
          kind: isEthernet ? 'ethernet' : 'wifi'
        }
        if (wifi === null || (wifi.kind === 'wifi' && cand.kind === 'ethernet')) wifi = cand
      } else {
        const [pct, chg] = t.split('|')
        if (pct === 'null' || pct === '' || Number.isNaN(Number(pct))) {
          battery = null
          charging = false
        } else {
          battery = Math.round(Number(pct))
          charging = chg === 'True'
        }
      }
    }
    return { battery, charging, wifi }
  } catch {
    return { battery: null, charging: false, wifi: null }
  }
}

/** 重读状态、更新缓存，并主动推给渲染层（插拔电源时不等轮询） */
function refreshAndBroadcast(): StatusSnapshot {
  cache = readStatus()
  cacheAt = Date.now()
  for (const win of BrowserWindow.getAllWindows()) {
    // 独立验收 C8：getAllWindows 里可能有已销毁的窗口（如全屏感应用的 4px 边缘窗），
    // 向已销毁的 webContents send 会抛异常，必须先判。
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send('island:status-changed', cache)
  }
  return cache
}

/**
 * 事件到达后延迟补读一次：Windows 的电源状态机切换（Win32_Battery 的
 * BatteryStatus / EstimatedChargeRemaining）比 on-ac / on-battery 事件晚几十到几百毫秒，
 * 事件一到立刻读会读到旧值，所以要等一小会儿再读。
 * 用 setTimeout 而不是 sleep，避免阻塞主进程。
 */
function scheduleRefresh(): void {
  if (settleTimer !== null) clearTimeout(settleTimer)
  settleTimer = setTimeout(() => {
    settleTimer = null
    refreshAndBroadcast()
  }, EVENT_SETTLE_MS)
}

/**
 * 看门狗：只调 powerMonitor.isOnBatteryPower()，不 spawn 子进程（实测连续 2 秒一次地起
 * PowerShell 会让 CLR 内存不足，见 SPEC 第七节），发现「在用电池」与上次不同才真正重读。
 * 作用是兜住「系统不发 on-ac / on-battery 事件」的机器（部分扩展坞 / 驱动）。
 */
function startWatch(): void {
  if (watchTimer !== null) return
  lastOnBattery = powerMonitor.isOnBatteryPower()
  watchTimer = setInterval(() => {
    const now = powerMonitor.isOnBatteryPower()
    if (now === lastOnBattery) return
    lastOnBattery = now
    scheduleRefresh()
  }, WATCH_MS)
}

export function setupStatus(): void {
  ipcMain.handle('status:snapshot', (): StatusSnapshot => {
    // 缓存 30 秒兜底；插拔电源、休眠恢复都会主动作废缓存并广播
    if (Date.now() - cacheAt > CACHE_MS) {
      cache = readStatus()
      cacheAt = Date.now()
    }
    return cache
  })

  // 插拔电源：立即作废缓存并广播（延迟 EVENT_SETTLE_MS 补读，见 scheduleRefresh）
  powerMonitor.on('on-ac', scheduleRefresh)
  powerMonitor.on('on-battery', scheduleRefresh)
  // 休眠恢复：合盖期间的电量变化事件可能丢，醒来补读一次
  powerMonitor.on('resume', scheduleRefresh)
  startWatch()
}

/** 退出时清掉定时器（与 notifyStore / scheduleStore 的 stop 同型） */
export function stopStatus(): void {
  if (watchTimer !== null) {
    clearInterval(watchTimer)
    watchTimer = null
  }
  if (settleTimer !== null) {
    clearTimeout(settleTimer)
    settleTimer = null
  }
  lastOnBattery = null
}
