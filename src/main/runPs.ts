import { spawn } from 'node:child_process'

/**
 * 跑一条 PowerShell 脚本并取回标准输出。
 *
 * 供「空间」页的清理/扫描使用（回收站、注册表、快捷方式解析）。
 * - `windowsHide`：不闪黑窗。
 * - 超时直接 kill，抛 `PowerShell 超时`，由调用方决定算失败还是算空结果。
 * - 退出码非 0 时抛 stderr 文本；调用方只能拿它写日志/兜底文案，**不直接展示给用户**。
 */
export function runPowerShell(script: string, timeoutMs = 25_000): Promise<string> {
  // Windows PowerShell 5.1 默认按系统代码页（中文系统是 GBK）写 stdout/stderr，
  // Node 按 UTF-8 解码会把中文报错变成乱码。先切到 UTF-8 再执行原脚本。
  const wrapped = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wrapped],
      { windowsHide: true }
    )
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('PowerShell 超时'))
    }, timeoutMs)
    child.stdout?.on('data', (d) => {
      out += d.toString('utf8')
    })
    child.stderr?.on('data', (d) => {
      err += d.toString('utf8')
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out.trim())
      else reject(new Error(err.trim() || `PowerShell 退出码 ${code}`))
    })
  })
}

/** 跑一个普通可执行文件（如 reg.exe），返回 stdout；非 0 退出抛错 */
export function runCommand(file: string, args: string[], timeoutMs = 25_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${file} 超时`))
    }, timeoutMs)
    child.stdout?.on('data', (d) => {
      out += d.toString('utf8')
    })
    child.stderr?.on('data', (d) => {
      err += d.toString('utf8')
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out.trim())
      else reject(new Error(err.trim() || `${file} 退出码 ${code}`))
    })
  })
}
