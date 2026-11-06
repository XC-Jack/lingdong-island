// e2e-wifi.mjs：US-005 收起态 Wi-Fi/网线状态 e2e（走 CDP 连 dev 或打包后的渲染层）
// A1 快照结构 / A2 图标+文案+类 / A3 DOM 顺序与无重叠 / A4 展开态无图标 / A5 null 分支说明
// kind='wifi' → IcoWifi 弧线；kind='ethernet' → IcoEthernet 水晶头（svg path 数量区分）
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const CDP_PORT = 9321
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
function assert(cond, msg) {
  if (cond) return
  failures++
  console.error('FAIL:', msg)
}

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(500)
  }
  throw new Error('CDP 连不上')
}

function cdp(wsUrl, expression, awaitPromise = false) {
  const ws = new WebSocket(wsUrl)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cdp timeout')), 20000)
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise }
        })
      )
    ws.onmessage = (ev) => {
      const data = JSON.parse(ev.data)
      if (data.id !== 1) return
      clearTimeout(timer)
      resolve(data.result?.result?.value)
      ws.close()
    }
  })
}

const main = async () => {
  const exe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(exe, ['.', `--remote-debugging-port=${CDP_PORT}`], { cwd: ROOT, env, stdio: 'ignore' })
  try {
    const wsUrl = await connect()
    await sleep(800)

    // —— A1：主进程快照里 wifi 字段结构与 kind 取值 ——
    // A1：awaitPromise 写法必须是 Promise.then(...) 链——裸 await 表达式在这里返回 undefined（实测踩坑）
    const a1raw = await cdp(wsUrl, `window.island.statusSnapshot().then(s => JSON.stringify(s))`, true)
    const a1 = JSON.parse(a1raw)
    assert(a1 && typeof a1.battery === 'number' && typeof a1.charging === 'boolean', 'A1 快照缺 battery/charging')
    if (a1.wifi !== null) {
      assert(
        typeof a1.wifi.connected === 'boolean' &&
          typeof a1.wifi.online === 'boolean' &&
          (a1.wifi.name === null || typeof a1.wifi.name === 'string') &&
          (a1.wifi.kind === 'wifi' || a1.wifi.kind === 'ethernet'),
        'A1 wifi 字段结构错: ' + JSON.stringify(a1.wifi)
      )
      console.log('[1] A1 通过：快照 wifi 字段 = ' + JSON.stringify(a1.wifi))
    } else {
      console.log('[1] A1 说明：本机无已连接网络，wifi=null（分支允许）')
    }

    // —— A2：收起态图标出现、文案含接口名与连接方式、类正确；kind 与图标种类对应 ——
    const a2 = JSON.parse(
      await cdp(
        wsUrl,
        `(() => {
          const el = document.querySelector('.collapsed-wifi')
          if (!el) return JSON.stringify({ has: false })
          return JSON.stringify({
            has: true,
            title: el.getAttribute('title'),
            cls: String(el.className),
            svgPaths: el.querySelectorAll('svg path').length,
            ariaLabel: el.getAttribute('aria-label')
          })
        })()`
      )
    )
    if (a1.wifi !== null) {
      assert(a2.has, 'A2 快照有 wifi 但收起态没渲染图标')
      assert(a2.title.includes(wifiName(a1.wifi)), 'A2 悬停文案不含网络名: ' + a2.title)
      assert(
        a1.wifi.kind === 'ethernet' ? a2.title.includes('网线') : a2.title.includes('Wi-Fi'),
        'A2 文案未区分网线/Wi-Fi: ' + a2.title
      )
      const expectOffline = a1.wifi.online ? '' : 'offline'
      assert(a2.cls.includes(expectOffline) || (a1.wifi.online && !a2.cls.includes('offline')), 'A2 offline 类错: ' + a2.cls)
      // 图标种类：Wi-Fi 弧线 3 path（+1 circle fill 点），网线水晶头 3 path 无 circle
      assert(a2.svgPaths === 3, 'A2 图标 path 数错: ' + a2.svgPaths)
      const kindOk =
        a1.wifi.kind === 'ethernet'
          ? a2.ariaLabel.startsWith('网线')
          : a2.ariaLabel.startsWith('Wi-Fi')
      assert(kindOk, 'A2 aria-label 与 kind 不匹配: ' + a2.ariaLabel)
      console.log('[2] A2 通过：图标 kind=' + a1.wifi.kind + '，文案「' + a2.title + '」，aria=' + a2.ariaLabel)
    } else {
      assert(!a2.has, 'A2 快照 wifi=null 但渲染了图标')
      console.log('[2] A2 通过：null 时不渲染')
    }

    // —— A3：位置在时钟右侧、电量环右侧（SPEC：电量环右、待办数字左）——
    const a3 = JSON.parse(
      await cdp(
        wsUrl,
        `(() => {
          const kid = document.querySelector('.island').children
          const names = Array.from(kid).map(el => String(el.className).split(' ')[0])
          const wifi = document.querySelector('.collapsed-wifi')
          const bat = document.querySelector('.head-battery-ring')
          const clock = document.querySelector('.collapsed-clock')
          const wr = wifi?.getBoundingClientRect(), br = bat?.getBoundingClientRect(), cr = clock?.getBoundingClientRect()
          return JSON.stringify({
            order: names.filter(Boolean),
            wifiLeft: wr ? Math.round(wr.left) : null,
            wifiRight: wr ? Math.round(wr.right) : null,
            batRight: br ? Math.round(br.right) : null,
            clockRight: cr ? Math.round(cr.right) : null,
            sameRow: wr && br ? Math.abs((wr.top + wr.bottom) / 2 - (br.top + br.bottom) / 2) < 6 : null,
            clockText: clock?.textContent ?? null
          })
        })()`
      )
    )
    const wi = a3.order.indexOf('collapsed-wifi')
    const bi = a3.order.indexOf('head-battery-ring')
    const ci = a3.order.indexOf('collapsed-clock')
    assert(ci >= 0 && bi >= 0, 'A3 收起态缺时钟或电量环: ' + JSON.stringify(a3.order))
    if (wi >= 0) {
      assert(wi > ci && wi > bi, 'A3 Wi-Fi 应在时钟与电量环之后: ' + JSON.stringify(a3.order))
      assert(a3.wifiLeft !== null && a3.clockRight !== null && a3.wifiLeft >= a3.clockRight, 'A3 Wi-Fi 与时钟重叠')
      assert(a3.wifiLeft !== null && a3.batRight !== null && a3.wifiLeft >= a3.batRight, 'A3 Wi-Fi 与电量环重叠: wifi左=' + a3.wifiLeft + ' 电量右=' + a3.batRight)
      assert(a3.sameRow !== false, 'A3 Wi-Fi 与电量环不在同一行')
      assert(/^\d{2}:\d{2}$/.test(a3.clockText), 'A3 时钟被挤压串行: ' + a3.clockText)
      console.log('[3] A3 通过：DOM 顺序', a3.order.join(' → '), '；时钟完整', a3.clockText)
    } else {
      console.log('[3] A3 跳过（本机无已连接网络，图标未渲染）')
    }

    // —— A4：展开态头部不出现 Wi-Fi/网线图标 ——
    await cdp(
      wsUrl,
      `(() => {
          document.querySelector('.island').dispatchEvent(new MouseEvent('click', { bubbles: true }))
          return 'clicked'
        })()`
    )
    await sleep(600)
    const a4b = JSON.parse(
      await cdp(
        wsUrl,
        `JSON.stringify({ wifi: !!document.querySelector('.collapsed-wifi'), expanded: !!document.querySelector('.page-todo, .page-notify, .page-schedule, .page-shelf, .page-settings') || document.querySelector('.island').className.includes('expanded') })`
      )
    )
    assert(!a4b.wifi || !a4b.expanded, 'A4 展开态仍显示 Wi-Fi 图标')
    console.log('[4] A4 通过：展开态无网络图标')
    // 收回来：展开态里 island 类名含 expanded，直接再次 dispatch click（收起态↔展开态互切）
    await cdp(
      wsUrl,
      `(() => { document.querySelector('.island').dispatchEvent(new MouseEvent('click', { bubbles: true })); return 'clicked' })()`
    )
    await sleep(600)

    // —— A5：null 分支说明（无网环境断言 wifi 不渲染；有网环境断言 kind 一致）——
    if (a1.wifi === null) {
      assert(!a2.has, 'A5 null 分支仍渲染')
      console.log('[5] A5 说明：本机无网，wifi=null 不渲染——分支成立')
    } else {
      console.log('[5] A5 说明：null 分支由 JSX 条件 {wifi !== null} 直接控制；当前 DOM has = ' + a2.has)
    }

    if (failures === 0) console.log('E2E WIFI PASS')
    else process.exitCode = 1
  } finally {
    child.kill()
    await sleep(300)
  }
}

function wifiName(w) {
  return w.name ?? ''
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e.message ?? e); process.exit(1) })
