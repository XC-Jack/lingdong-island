// e2e-reorder 的启动包装：先拉起带 CDP 9225 的 electron，再跑 e2e-reorder.mjs，最后清理进程树。
// e2e-reorder.mjs 设计上只连 CDP（端口 9225，与 m4-drop 相同但错开运行），不自己启动实例。
import { spawn } from './isolate-userdata.mjs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const exe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9225

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitCdp() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`)
      const list = await r.json()
      if (list.some((t) => t.type === 'page')) return
    } catch {
      /* not ready */
    }
    await sleep(300)
  }
  throw new Error('CDP 9225 未就绪')
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(exe, ['.', `--remote-debugging-port=${CDP_PORT}`], { cwd: ROOT, env, stdio: 'ignore' })

try {
  await waitCdp()
  await sleep(1000)
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(ROOT, 'scripts', 'e2e-reorder.mjs')], {
      stdio: 'inherit',
      env: { ...process.env, E2E_REORDER_WRAPPED: '1' }
    })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`e2e-reorder exit ${code}`))))
  })
  console.log('E2E REORDER WRAPPER PASS')
} finally {
  // 杀整棵进程树（child.kill 只杀 launcher，electron 子进程会挂着）
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill()
  }
}
