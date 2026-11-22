import { BrowserWindow, ipcMain, powerMonitor } from 'electron'
import { connect as netConnect } from 'node:net'
import { runPowerShellRaw } from './runPs'

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

/**
 * 缓存时长。
 *
 * 2026-11-19 用户断网后截图里看不到图标：原来渲染层 60 秒才拉一次、
 * 主进程再缓存 30 秒，最长要等 90 秒。当时改成 10 秒缓存 + 渲染层 15 秒轮询。
 *
 * 2026-11-22 改回来（SPEC-perf-no-sync-ps）：轮询改成 60 秒、去掉「点一下就拉」之后，
 * 保持实时性靠的是**事件**（powerMonitor 插拔电源 / 休眠恢复、Chromium online-offline、
 * TCP 探针翻转），缓存只作兜底。缓存越短 = 起 PowerShell 越频繁 = 弱机器越卡。
 */
const CACHE_MS = 60_000
/** 看门狗周期：只读 powerMonitor，不起子进程，所以可以比取数频繁得多 */
const WATCH_MS = 1_000
/**
 * 网络连通性探针（2026-11-19 用户「十几秒还是太长了」）。
 * Node 直接发 TCP 握手，不起 PowerShell，可以每 3 秒跑一次；只在「通/不通」翻转时
 * 触发一次真正的状态重读（异步的一次 PowerShell，不阻塞主进程），让图标在几秒内跟上，
 * 而不是等轮询。
 * 目标用阿里公共 DNS 的 443 端口（本机实测 223.5.5.5:53、119.29.29.29:53 被网络屏蔽，
 * 223.5.5.5:443 与 223.6.6.6:443 可连；两个都失败才算不通）。
 * 探针只当「触发器」用，界面上网/离线仍以 Windows 的连接类别为准，避免自造判据。
 */
const NET_PROBE_MS = 3_000
const NET_PROBE_TIMEOUT_MS = 1_500
const NET_PROBE_HOSTS: ReadonlyArray<readonly [string, number]> = [
  ['223.5.5.5', 443],
  ['223.6.6.6', 443]
]
/** 事件到达后补读电量/网络的延迟。颜色已由事件当场翻转（不等这一步），
 *  这里只是为了把百分比和 Wi-Fi 一起刷新，所以可以比上一版的 600ms 更早。
 *  取 300ms 仍留有「系统状态机追上事件」的余量；该数值无真机插拔实测依据。 */
const EVENT_SETTLE_MS = 300
/** 事件优先窗口：这段时间内若补读到的充电态与事件方向冲突，以事件为准。
 *  原因：Windows 的 Win32_Battery 更新常常比 on-ac / on-battery 慢，甚至出现
 *  「已经拔线但系统仍报接交流电」（2026-11-09 实测过一次）。不设这段窗口，
 *  界面会在变色后 300ms 被旧读数打回原色，肉眼看是「闪一下又弹回去」。
 *  取 3 秒：短到不会拿错误方向盖住真实状态，长到能跨过系统的延迟。 */
const EVENT_TRUST_MS = 3_000

let cache: StatusSnapshot = { battery: null, charging: false, wifi: null }
let cacheAt = 0
/** 上一次通过 powerMonitor 看到的「是否在用电池供电」，看门狗拿它比对 */
let lastOnBattery: boolean | null = null
let watchTimer: ReturnType<typeof setInterval> | null = null
let settleTimer: NodeJS.Timeout | null = null

/** 读不到时的空快照（界面据此不渲染电量/网络） */
const EMPTY_STATUS: StatusSnapshot = { battery: null, charging: false, wifi: null }

/**
 * 状态脚本：电量 + 网络同一次取回（US-005）。
 * 抽成常量是为了让「异步读」只有一份脚本正文，改判据只需要改这里。
 *
 * 电量行判据＝「不是放电状态」（BatteryStatus 不是 1，且 WMI 没报 Discharging）。
 * 用户口径（2026-11-09 17:37 原话「我现在冲着电，他是白的」）：插着电源就该显示充电态。
 * 不能只看 6/7/8/9——电池到 96% 后系统会停止充电但仍在供电，那时 BatteryStatus=2
 * （接交流电）或 3（已充满），只按 6-9 判就会漏掉，界面显示白弧，用户认为错。
 * 也不能用 `-eq 2`：那会连「拔了电但系统还认为在 AC」的情况一起算成充电。
 * 4/5（低电/临界）同样不能排除：插着电且电量低时必须走绿（充电优先），
 * 排除它们会让「15% 插着电」显示成低电红，与用户口径相反。
 * 实测记录见 docs/Spec/SPEC-battery-charging-accuracy.md 第九节。
 *
 * 网络行：net|IPv4类别|IPv6类别|接口名|介质类型|是否虚拟
 * 按 InterfaceIndex 关联连接配置与网卡：MediaType 802.11=无线 / 802.3=有线，
 * Virtual=True 是 VPN 等虚拟网卡（如 Radmin VPN），不算真网线（实测踩坑）。
 */
const STATUS_SCRIPT = [
  '$b=Get-CimInstance -ClassName Win32_Battery; $w=@(Get-CimInstance -Namespace root\\wmi -ClassName BatteryStatus -ErrorAction SilentlyContinue); if($b){"{0}|{1}" -f $b.EstimatedChargeRemaining, (($b.BatteryStatus -notin 1) -and -not [bool]($w|Where-Object {$_.Discharging}))}else{"null|false"}',
  '$ps=Get-NetConnectionProfile; $ads=Get-NetAdapter; foreach($p in $ps){ $a=$ads|Where-Object InterfaceIndex -eq $p.InterfaceIndex; "net|{0}|{1}|{2}|{3}|{4}" -f $p.IPv4Connectivity,$p.IPv6Connectivity,$p.Name,$a.MediaType,$a.Virtual }'
].join('; ')

/**
 * 解析脚本 stdout → 快照。纯函数，方便单独核对（`status:snapshot` 与广播共用同一份）。
 */
function parseStatusOutput(out: string): StatusSnapshot {
  let battery: number | null = null
  let charging = false
  let wifi: WifiSnapshot | null = null
  let sawLine = false
  // 逐行找：第一行电量，net| 开头的是网络行。
  // 多接口并存（Wi-Fi+网线同时插）时优先网线（更稳定，通常是有意为之），
  // 虚拟网卡（Virtual=True，如 VPN）跳过不算。
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    sawLine = true
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
  // 命令成功执行、但没有可用的物理连接（Wi-Fi 断开 / 未插网线 / 只剩 Radmin 这类虚拟网卡）：
  // 返回 connected:false 的快照，让界面显示断网图标（用户 2026-11-19）。
  // 这里不能看「有没有 net| 行」——只剩虚拟网卡时也有行，但 wifi 仍会是 null，
  // 界面就什么都不显示（用户断网后截图正是这个现象）。
  // null 只留给「命令失败 / 完全读不到」，界面保持不渲染，避免误报。
  if (wifi === null && sawLine) {
    wifi = { connected: false, online: false, name: null, kind: 'wifi' }
  }
  return { battery, charging, wifi }
}

/** 一次异步读的结果：ok=false 表示这次没读到（超时/进程起不来），调用方保留旧值 */
interface StatusRead {
  ok: boolean
  value: StatusSnapshot
}

/** 正在进行的读（单飞：并发请求共用同一次 PowerShell，避免几处同时各起一个） */
let reading: Promise<StatusRead> | null = null

/**
 * 异步读一次系统状态。
 *
 * **为什么必须异步**（SPEC-perf-no-sync-ps）：2026-11-22 实测这条脚本要 830–925 ms，
 * 旧实现用 `spawnSync`，期间主进程完全冻结——窗口尺寸补间、IPC、托盘、输入全部停摆。
 * 而它当时挂在「每次 pointerdown」这条路径上，用户观感就是「点一下卡一秒」。
 * 现在改成异步：主进程只占一次 spawn 的系统调用，其余时间照常处理事件。
 */
function readStatusOnce(): Promise<StatusRead> {
  if (reading) return reading
  const p: Promise<StatusRead> = runPowerShellRaw(STATUS_SCRIPT, 10_000)
    .then((r) => ({ ok: true, value: parseStatusOutput(r.stdout) }))
    .catch(() => ({ ok: false, value: { ...EMPTY_STATUS } }))
    .finally(() => {
      if (reading === p) reading = null
    })
  reading = p
  return p
}

/** 最近一次电源事件给出的方向与时间；用于 EVENT_TRUST_MS 窗口内压住与事件冲突的读数 */
let trustedCharging: boolean | null = null
let trustedAt = 0

/** 把一份状态推给所有还活着的窗口（缺它时插拔电源只能等 60 秒轮询） */
function broadcast(s: StatusSnapshot): void {
  for (const win of BrowserWindow.getAllWindows()) {
    // 独立验收 C8：getAllWindows 里可能有已销毁的窗口（如全屏感应用的 4px 边缘窗），
    // 向已销毁的 webContents send 会抛异常，必须先判。
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send('island:status-changed', s)
  }
}

/** 把一次读到的结果落地：事件优先窗口内保持充电方向，写缓存并广播 */
function applyRead(next: StatusSnapshot): StatusSnapshot {
  // 事件刚发生时，系统读数可能还没跟上（甚至反过来），这段时间以事件方向为准，
  // 否则界面会「闪一下绿又弹回白」。百分比、Wi-Fi 仍按真实读数更新。
  const inTrust = trustedCharging !== null && Date.now() - trustedAt < EVENT_TRUST_MS
  cache = inTrust ? { ...next, charging: trustedCharging as boolean } : next
  cacheAt = Date.now()
  // 注意：这里不要动 lastOnBattery。它表示「上一次观察到的传感器状态」，
  // 只有看门狗自己的采样和电源事件才能改它。若拿读数的 charging 回写，
  // 一旦传感器的方向与读数矛盾（有的机器传感器恒报「插着电」），
  // 看门狗就会每 1 秒认定「翻转了」并把界面强行掰成充电态，界面反而不准。
  broadcast(cache)
  return cache
}

/**
 * 重读状态、更新缓存，并主动推给渲染层（插拔电源时不等轮询）。
 * 异步：读失败（超时/进程起不来）就保留旧值，不把界面刷成空。
 */
async function refreshAndBroadcast(): Promise<StatusSnapshot> {
  const r = await readStatusOnce()
  if (!r.ok) return cache
  return applyRead(r.value)
}

/**
 * 插拔电源：「变绿/变白」这件事不等子进程，先用事件给的方向当场翻转并广播。
 * 剩下的百分比、Wi-Fi 交给 EVENT_SETTLE_MS 后的 refreshAndBroadcast 补齐。
 * 这样用户从插上电源到看见颜色变化只有几十毫秒，而不是等一次约 1 秒的 PowerShell。
 *
 * @param chargingFromEvent on-ac → true（插着电）；on-battery → false（在用电池）
 */
function applyPowerEvent(chargingFromEvent: boolean): void {
  lastOnBattery = !chargingFromEvent
  trustedCharging = chargingFromEvent
  trustedAt = Date.now()
  if (cache.charging !== chargingFromEvent) {
    cache = { ...cache, charging: chargingFromEvent }
    broadcast(cache)
  }
  scheduleRefresh()
}

/**
 * 事件到达后延迟补读一次：百分比与 Wi-Fi 仍要重新取。
 * 用 setTimeout 而不是 sleep，避免阻塞主进程。
 */
function scheduleRefresh(): void {
  if (settleTimer !== null) clearTimeout(settleTimer)
  settleTimer = setTimeout(() => {
    settleTimer = null
    void refreshAndBroadcast()
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
    const onBattery = powerMonitor.isOnBatteryPower()
    if (onBattery === lastOnBattery) return
    applyPowerEvent(!onBattery)
  }, WATCH_MS)
}

let probeTimer: ReturnType<typeof setInterval> | null = null
let probeBusy = false
let lastReach: boolean | null = null
let probeSettleTimers: Array<ReturnType<typeof setTimeout>> = []

function probeHost(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = netConnect({ host, port })
    let done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(NET_PROBE_TIMEOUT_MS)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

async function probeReachable(): Promise<boolean> {
  const results = await Promise.all(NET_PROBE_HOSTS.map(([h, p]) => probeHost(h, p)))
  return results.some(Boolean)
}

function refreshNow(): void {
  void refreshAndBroadcast()
}

/**
 * 网络探针：只当触发器，不通/通翻转时立刻重读一次状态并广播，再在 2.5 秒后补读一次
 * （Windows 的连接类别有时比 TCP 握手慢一拍）。界面判据仍是 parseStatusOutput 解析出的 Windows 结果。
 */
function startNetProbe(): void {
  if (probeTimer !== null) return
  probeTimer = setInterval(() => {
    if (probeBusy) return
    probeBusy = true
    void probeReachable()
      .then((ok) => {
        const prev = lastReach
        lastReach = ok
        if (prev === null || ok === prev) return
        probeSettleTimers.push(setTimeout(refreshNow, 600))
        probeSettleTimers.push(setTimeout(refreshNow, 2_500))
      })
      .finally(() => {
        probeBusy = false
      })
  }, NET_PROBE_MS)
}

export function setupStatus(): void {
  ipcMain.handle('status:snapshot', async (): Promise<StatusSnapshot> => {
    // 缓存没过期就直接给（大多数调用走这条，0 开销）。
    // 过期了才 await 一次异步读 —— **不再阻塞主进程**：只是这条 IPC 回得晚一点，
    // 窗口动画、其它 IPC、托盘全都照常跑（旧实现是 spawnSync，整段冻结约 1 秒）。
    if (Date.now() - cacheAt > CACHE_MS) return await refreshAndBroadcast()
    return cache
  })

  // 渲染层收到系统 online/offline 事件时强制重读（不等缓存/轮询）
  ipcMain.handle('status:refresh', (): Promise<StatusSnapshot> => refreshAndBroadcast())

  // 插拔电源：先用事件方向当场翻转颜色并广播，再延迟补读百分比与 Wi-Fi
  powerMonitor.on('on-ac', () => applyPowerEvent(true))
  powerMonitor.on('on-battery', () => applyPowerEvent(false))
  // 休眠恢复：合盖期间的电量变化事件可能丢，醒来补读一次
  powerMonitor.on('resume', scheduleRefresh)
  startWatch()
  startNetProbe()
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
  if (probeTimer !== null) {
    clearInterval(probeTimer)
    probeTimer = null
  }
  for (const t of probeSettleTimers) clearTimeout(t)
  probeSettleTimers = []
  probeBusy = false
  lastReach = null
  lastOnBattery = null
  trustedCharging = null
  trustedAt = 0
  // 正在跑的那次读不用等它（退出流程），清掉引用即可；子进程会随父进程退出
  reading = null
}
