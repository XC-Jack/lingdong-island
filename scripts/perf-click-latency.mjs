#!/usr/bin/env node
/**
 * 性能回归护栏（SPEC-perf-no-sync-ps）。
 *
 * 背景：2026-11-22 用户报「只要一点击切换就卡」，只出现在别的电脑上。本机实测根因是
 * 主进程用 `spawnSync` 跑 PowerShell（状态读数 830–925 ms、图标解析 1.5–2.5 s 一串），
 * 而状态读数还挂在「岛里每次 pointerdown」上 —— 一次点击 = 主进程整段冻结约 1 秒。
 *
 * 这个脚本守住三件事：
 *   P1 源码里**没有** `spawnSync(`（主进程同步等子进程 = 窗口动画/IPC/输入一起停摆）；
 *   P2 启动到界面可交互 < 2500 ms（改前实测 5953 / 5979 ms，大半是启动期同步 PowerShell）；
 *   P3 后台正在读状态时，点击 → 主进程空 IPC 往返 P95 < 50 ms（改前实测 942 / 996 / 955 ms）。
 *
 * P3 的测法：先 `statusRefresh()` 起一次真实的异步读（不要 await），**在读进行中**
 * 连续派发 pointerdown 并量 `prefsGet()` 往返。同步实现下这里必然是 900 ms 量级。
 * （不去等 60 秒缓存过期：那只是把「同步冻结」推迟到下一次点击，不是本次要守的性质。）
 *
 * 用法：node scripts/perf-click-latency.mjs
 */
import { spawn, execSync } from './isolate-userdata.mjs'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9321
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  ✓ ${name}${extra ? ' —— ' + extra : ''}`)
  else {
    failed++
    console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`)
  }
}

/* ---------------- P1：源码里不许出现 spawnSync ---------------- */

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

console.log('P1 主进程不许有 spawnSync')
const offenders = []
for (const f of walk(join(ROOT, 'src', 'main'))) {
  // 只看代码，不看注释：去掉行注释和块注释后再找
  const code = readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  if (/\bspawnSync\(/.test(code)) offenders.push(relative(ROOT, f))
}
ok('src/main 里 spawnSync( 命中数为 0', offenders.length === 0, offenders.join(', ') || '0 处')

/* ---------------- 起隔离实例 ---------------- */

async function evalIn(expression, timeout = 120000) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  return await new Promise((res, rej) => {
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {}
      rej(new Error('cdp timeout'))
    }, timeout)
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true }
        })
      )
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id !== 1) return
      clearTimeout(timer)
      ws.close()
      if (m.result?.exceptionDetails)
        return rej(new Error('eval: ' + (m.result.exceptionDetails.exception?.description ?? m.result.exceptionDetails.text)))
      res(m.result?.result?.value)
    }
    ws.onerror = () => {
      clearTimeout(timer)
      rej(new Error('ws error'))
    }
  })
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE // 继承到它会退化成纯 Node 秒退
const t0 = Date.now()
const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: 'ignore' })

try {
  /* ---------------- P2：启动耗时 ---------------- */
  let startupMs = null
  for (let i = 0; i < 80; i++) {
    await sleep(200)
    try {
      if (await evalIn(`!!document.querySelector('.island')`, 8000)) {
        startupMs = Date.now() - t0
        break
      }
    } catch {
      /* 页面还没起来 */
    }
  }
  console.log('\nP2 启动到界面可交互')
  ok('启动 < 2500 ms', startupMs !== null && startupMs < 2500, `${startupMs ?? '超时'} ms`)

  if (startupMs === null) throw new Error('界面没起来，后续测量跳过')

  // 展开岛（后面点击都落在展开态上，和用户的实际场景一致）
  await evalIn(`(() => { document.querySelector('.island').click(); return 1 })()`)
  await sleep(1500)

  /* ---------------- P3：读在飞的时候，点击还能不能及时回 ---------------- */
  console.log('\nP3 后台正在读状态时的点击延迟')
  const measure = await evalIn(`(async () => {
    // 先起一次真实的状态重读（异步、不等它），模拟「缓存过期」那一刻
    window.island.statusRefresh().catch(() => {})
    const samples = []
    for (let i = 0; i < 6; i++) {
      const island = document.querySelector('.island')
      const t = performance.now()
      island.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
      await window.island.prefsGet()
      samples.push(Math.round(performance.now() - t))
      await new Promise((r) => setTimeout(r, 60))
    }
    samples.sort((a, b) => a - b)
    return {
      samples,
      p50: samples[Math.floor(samples.length / 2)],
      p95: samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))]
    }
  })()`)

  const p95 = measure.p95
  ok('点击 → 主进程空 IPC 往返 P95 < 50 ms', p95 < 50, `P95=${p95} ms，P50=${measure.p50} ms，样本=${JSON.stringify(measure.samples)}`)

  // 顺带核对：状态读数仍然能拿到真实数据（异步不等于读不到）
  const snap = await evalIn(`window.island.statusSnapshot()`)
  ok(
    'statusSnapshot 仍返回真实读数',
    snap !== null && typeof snap === 'object' && (snap.battery !== null || snap.wifi !== null),
    JSON.stringify(snap)
  )
} catch (e) {
  failed++
  console.error('\n探针失败：', e.message)
} finally {
  try {
    execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
  } catch {
    /* 进程已退出 */
  }
}

console.log(failed === 0 ? '\n结果：全部通过' : `\n结果：${failed} 项未通过`)
process.exit(failed === 0 ? 0 : 1)
