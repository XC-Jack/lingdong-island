import { ipcMain } from 'electron'

/** 收起态状态栏的数据快照 */
export interface StatusSnapshot {
  /** 电量百分比 0-100；取不到时为 null */
  battery: number | null
  /** 是否正在充电 */
  charging: boolean
}

let cache: StatusSnapshot = { battery: null, charging: false }
let cacheAt = 0

/**
 * 读系统电量。Electron 主进程没有现成 API，这里走 PowerShell CIM 查
 * Win32_Battery，10 秒超时，结果缓存 30 秒。
 */
function readBattery(): StatusSnapshot {
  try {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
    const r = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$b=Get-CimInstance -ClassName Win32_Battery; if($b){"{0}|{1}" -f $b.EstimatedChargeRemaining, ($b.BatteryStatus -eq 2)}else{"null|false"}'
      ],
      { timeout: 10_000, windowsHide: true }
    )
    const out = r.stdout?.toString().trim() ?? ''
    const [pct, chg] = out.split('|')
    if (pct === 'null' || pct === '' || Number.isNaN(Number(pct))) {
      return { battery: null, charging: false }
    }
    return { battery: Math.round(Number(pct)), charging: chg === 'True' }
  } catch {
    return { battery: null, charging: false }
  }
}

export function setupStatus(): void {
  ipcMain.handle('status:snapshot', (): StatusSnapshot => {
    // 缓存 30 秒，电量变化慢，没必要每次都起子进程
    if (Date.now() - cacheAt > 30_000) {
      cache = readBattery()
      cacheAt = Date.now()
    }
    return cache
  })
}
