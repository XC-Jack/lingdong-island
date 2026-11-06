import { ipcMain } from 'electron'

/** Wi-Fi 状态（收起态 US-005）；读不到时 wifi 为 null，UI 不显示 */
export interface WifiSnapshot {
  /** 是否已连上 Wi-Fi（有 WLAN 连接配置即算连上，哪怕暂时上不了网） */
  connected: boolean
  /** 有网（任一 IPv4/IPv6 连接类别为 Internet） */
  online: boolean
  /** 当前 Wi-Fi 网络名（SSID），取不到为 null */
  name: string | null
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

let cache: StatusSnapshot = { battery: null, charging: false, wifi: null }
let cacheAt = 0

/**
 * 读系统电量与 Wi-Fi 状态（US-005 起 Wi-Fi 顺带在同一次子进程里取回，不新开进程）。
 * Electron 主进程没有现成 API，这里走 PowerShell CIM 查 Win32_Battery +
 * Get-NetConnectionProfile，10 秒超时，结果缓存 30 秒。
 * 注意：输出编码显式 UTF-8，否则中文 Wi-Fi 名（SSID）会乱码（实测踩坑）。
 */
function readStatus(): StatusSnapshot {
  try {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
    const script = [
      // 电量行（与 US-005 之前格式一致）：电量|是否充电
      '$b=Get-CimInstance -ClassName Win32_Battery; if($b){"{0}|{1}" -f $b.EstimatedChargeRemaining, ($b.BatteryStatus -eq 2)}else{"null|false"}',
      // Wi-Fi 行：wifi|IPv4类别|IPv6类别|网络名（按接口别名 WLAN 过滤，VPN 等虚拟网卡不算）
      '$p=Get-NetConnectionProfile | Where-Object InterfaceAlias -like "*WLAN*"; if($p){"wifi|{0}|{1}|{2}" -f $p.IPv4Connectivity,$p.IPv6Connectivity,$p.Name}else{"wifi|none"}'
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
    // 逐行找：第一行电量，含 wifi| 前缀的行是 Wi-Fi
    for (const line of out.split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      if (t.startsWith('wifi|')) {
        const [, v4, v6, ...rest] = t.split('|')
        if (v4 === 'none' || v4 === undefined) {
          // 无 WLAN 连接配置 → 未连 Wi-Fi
          continue
        }
        const name = rest.join('|').trim() || null
        wifi = {
          connected: true,
          online: v4 === 'Internet' || v6 === 'Internet',
          name
        }
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

export function setupStatus(): void {
  ipcMain.handle('status:snapshot', (): StatusSnapshot => {
    // 缓存 30 秒，电量/Wi-Fi 变化都慢，没必要每次都起子进程
    if (Date.now() - cacheAt > 30_000) {
      cache = readStatus()
      cacheAt = Date.now()
    }
    return cache
  })
}
