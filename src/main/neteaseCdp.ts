/**
 * 网易云音乐后台精确控制（CDP）。
 *
 * 为什么需要它：网易云 3.x 不注册 Windows SMTC 的播放位置（位置/时长恒 0、
 * 不接受系统的 seek），以前只能靠「抓它窗口的像素 + 把窗口顶到前台点屏幕坐标」，
 * 于是用户必须让网易云窗口显示在桌面上，最小化就完全不能控制。
 *
 * 网易云是基于 Chromium 的客户端（OrpheusBrowserHost），启动时加
 * `--remote-debugging-port=9222` 就会开放 DevTools 协议。通过它可以：
 *   - 读它页面里那条进度控件的文字（"01:09 / 03:52"）拿到精确位置与时长；
 *   - 用 Input.dispatchMouseEvent 点它自己的进度条（事件直接进渲染器，
 *     不需要窗口可见、不需要前台、不需要真实鼠标）；
 *   - 点播放/上一首/下一首按钮。
 * 2026-11-17 实测（网易云 3.1.41.205564，窗口最小化）：
 *   点 30% → 01:09、点 85% → 03:17（总长 03:52），播放键/下一首同样生效。
 *
 * 限制：调试端口只能在进程启动时打开。用户若用普通方式重新打开网易云，
 * 端口会消失——界面会给出「一键重启开启」的入口（见 enableNeteaseDebugPort）。
 */

import { execFile } from 'node:child_process'

const CDP_PORT = 9222
/** 单条 CDP 命令的超时；页面卡住时别把整轮轮询拖死 */
const RPC_TIMEOUT = 1500
const WS_TIMEOUT = 1500

export interface NeteaseCdpState {
  /** 当前播放位置（秒，进度控件显示到秒） */
  pos: number
  /** 总时长（秒） */
  dur: number
  playing: boolean
  title: string
  artist: string
  /** 封面原地址（orpheus://cache/?https://...），由调用方决定是否转 data URL */
  coverUrl: string
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

let sock: WebSocket | null = null
let sockUrl = ''
let seq = 0
const pending = new Map<number, Pending>()
/** 同一类错误只打一次日志，别让每秒轮询刷屏 */
let lastCdpError = ''
function warnCdp(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg === lastCdpError) return
  lastCdpError = msg
  console.warn('[music] 网易云 CDP:', msg)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 找网易云的页面目标；没开调试端口 / 进程没起来都返回 null */
async function findPage(): Promise<string | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 700)
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`, { signal: ctrl.signal })
    if (!r.ok) return null
    const list = (await r.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>
    const page = list.find((t) => t.type === 'page' && t.url.startsWith('orpheus://'))
    return page?.webSocketDebuggerUrl ?? null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function dropSocket(): void {
  const s = sock
  sock = null
  sockUrl = ''
  if (s) {
    try {
      s.close()
    } catch {
      /* ignore */
    }
  }
  for (const p of pending.values()) {
    clearTimeout(p.timer)
    p.reject(new Error('cdp closed'))
  }
  pending.clear()
}

/** 连上（或复用）调试 WebSocket；失败返回 null，不抛异常 */
async function ensureSocket(): Promise<WebSocket | null> {
  const url = await findPage()
  if (!url) {
    dropSocket()
    return null
  }
  if (sock && sock.readyState === 1 && sockUrl === url) return sock
  dropSocket()
  try {
    const s = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws timeout')), WS_TIMEOUT)
      s.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      s.onerror = () => {
        clearTimeout(timer)
        reject(new Error('ws error'))
      }
    })
    s.onmessage = (ev: MessageEvent) => {
      let msg: { id?: number; result?: unknown; error?: { message?: string } }
      try {
        msg = JSON.parse(String(ev.data)) as typeof msg
      } catch {
        return
      }
      if (!msg.id) return
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(msg.error.message ?? 'cdp error'))
      else p.resolve(msg.result)
    }
    s.onclose = () => {
      if (sock === s) dropSocket()
    }
    s.onerror = () => {
      if (sock === s) dropSocket()
    }
    sock = s
    sockUrl = url
    lastCdpError = ''
    return s
  } catch (err) {
    warnCdp(err)
    return null
  }
}

/** 发一条 CDP 命令 */
async function rpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
  const s = await ensureSocket()
  if (!s) throw new Error('no cdp')
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('cdp timeout'))
    }, RPC_TIMEOUT)
    pending.set(id, { resolve, reject, timer })
    try {
      s.send(JSON.stringify({ id, method, params }))
    } catch (err) {
      clearTimeout(timer)
      pending.delete(id)
      reject(err instanceof Error ? err : new Error('cdp send'))
    }
  })
}

/** 在网易云页面里跑一段 JS，返回其值 */
async function evaluate(expression: string): Promise<unknown> {
  const r = (await rpc('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false,
    userGesture: true
  })) as { result?: { value?: unknown }; exceptionDetails?: unknown }
  if (r.exceptionDetails) {
    warnCdp('页面脚本异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
    return undefined
  }
  return r.result?.value
}

/**
 * 读一次播放状态。
 * 一次性取完，别拆成多次往返：轮询每秒一次，多一次往返就多一份卡顿风险。
 */
const STATE_EXPR = `(() => {
  const all = Array.prototype.slice.call(document.querySelectorAll('.slider-default'));
  let s = null;
  for (let i = 0; i < all.length; i += 1) {
    if (all[i].getAttribute('aria-label') === '播放进度调节' && all[i].getBoundingClientRect().width > 0) { s = all[i]; break; }
  }
  if (!s) return null;
  const txt = (s.textContent || '').trim();
  const m = txt.match(/(\\d{1,2}):(\\d{2})\\s*\\/\\s*(\\d{1,2}):(\\d{2})/);
  if (!m) return null;
  const pos = Number(m[1]) * 60 + Number(m[2]);
  const dur = Number(m[3]) * 60 + Number(m[4]);
  const titleEl = document.querySelector('[data-testid=tid_minibar_title]');
  let title = '';
  let artist = '';
  if (titleEl) {
    const badge = /^(VIP|试听|超高|极高|标准|无损|杜比|Hi-Res|HiRes|独家|新歌|抢先听|付费)$/;
    const lines = (titleEl.innerText || '').split('\\n').map(function (x) { return x.trim(); })
      .filter(function (x) { return x && !badge.test(x); });
    title = lines[0] || '';
    // 标题行在 innerText 里会重复一次（实测「歌名\\n歌名\\n歌手」），去掉与歌名相同的行
    artist = lines.filter(function (x) { return x !== title; }).join(' / ');
  }
  const btn = document.querySelector('[data-testid=tid_playbar_play_btn]');
  const icon = btn && btn.querySelector('.cmd-icon');
  const playing = !!icon && /cmd-icon-pause/.test(icon.className);
  const bar = document.querySelector('.default-bar-wrapper');
  const img = bar && bar.querySelector('img');
  return { pos: pos, dur: dur, playing: playing, title: title, artist: artist,
    coverUrl: img ? (img.getAttribute('src') || '') : '' };
})()`

export async function readNeteaseState(): Promise<NeteaseCdpState | null> {
  try {
    const v = (await evaluate(STATE_EXPR)) as NeteaseCdpState | null
    if (!v) {
      warnCdp('页面里没读到进度控件')
      return null
    }
    if (typeof v.dur !== 'number' || v.dur <= 0) {
      warnCdp('进度控件无时长: ' + JSON.stringify(v).slice(0, 200))
      return null
    }
    return {
      pos: Number.isFinite(v.pos) ? Math.max(0, Math.min(v.dur, v.pos)) : 0,
      dur: v.dur,
      playing: v.playing === true,
      title: typeof v.title === 'string' ? v.title : '',
      artist: typeof v.artist === 'string' ? v.artist : '',
      coverUrl: typeof v.coverUrl === 'string' ? v.coverUrl : ''
    }
  } catch (err) {
    warnCdp(err)
    return null
  }
}

/**
 * 点网易云页面里进度条的 ratio（0..1）位置。
 *
 * 实测（2026-11-17）：Electron 主进程这条 WebSocket 发 `Input.dispatchMouseEvent`
 * 会一直等不到回包（1.5 秒超时），但同一条连接上的 Runtime.evaluate 正常。
 * 所以改成在页面内直接派发指针/鼠标事件——网易云的 React 监听器照常接收，
 * 效果与真实点击一致（暂停态 01:26 → 点 50% → 01:48，误差 0 秒）。
 */
export async function seekNetease(ratio: number): Promise<boolean> {
  try {
    const pct = Math.min(1, Math.max(0, ratio))
    const ok = await evaluate(`(() => {
      const all = Array.prototype.slice.call(document.querySelectorAll('.slider-default'));
      let s = null;
      for (let i = 0; i < all.length; i += 1) {
        const r = all[i].getBoundingClientRect();
        if (all[i].getAttribute('aria-label') === '播放进度调节' && r.width > 0) { s = all[i]; break; }
      }
      if (!s) return false;
      const r = s.getBoundingClientRect();
      const x = r.left + r.width * ${pct};
      const y = r.top + Math.max(1, r.height / 2);
      const down = { bubbles: true, cancelable: true, clientX: x, clientY: y,
        button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      const up = Object.assign({}, down, { buttons: 0 });
      s.dispatchEvent(new PointerEvent('pointerdown', down));
      s.dispatchEvent(new MouseEvent('mousedown', down));
      s.dispatchEvent(new PointerEvent('pointerup', up));
      s.dispatchEvent(new MouseEvent('mouseup', up));
      s.dispatchEvent(new MouseEvent('click', up));
      return true;
    })()`)
    if (ok !== true) warnCdp('seek 找不到进度控件')
    return ok === true
  } catch (err) {
    warnCdp(err)
    return false
  }
}

/** 点播放栏上的按钮：play / next / prev */
export async function clickNetease(which: 'play' | 'next' | 'prev'): Promise<boolean> {
  const id =
    which === 'play' ? 'tid_playbar_play_btn' : which === 'next' ? 'tid_playbar_next_btn' : 'tid_playbar_prev_btn'
  try {
    const ok = await evaluate(`(() => {
      const b = document.querySelector('[data-testid=${id}]');
      if (!b) return false;
      b.click();
      return true;
    })()`)
    return ok === true
  } catch {
    return false
  }
}

/**
 * 把网易云页面里的封面地址（orpheus://cache/?https://...）取回来转成 data URL。
 * 页面里那张是 50px 缩略图，改成 param=200y200 拿大一点的给岛上用。
 * 取不到就返回空串，界面回落音符占位，不影响播放控制。
 */
export async function fetchNeteaseCover(url: string): Promise<string> {
  try {
    let u = url
    const prefix = 'orpheus://cache/?'
    if (u.startsWith(prefix)) u = u.slice(prefix.length)
    const parsed = new URL(u)
    // 网易云图片服务的 type=webp 会让它回 webp；老界面/断言只认 png/jpeg，
    // 去掉 type 后同一地址回的是标准 PNG（实测 200x200、97KB）。
    parsed.searchParams.delete('type')
    parsed.searchParams.delete('thumbnail')
    parsed.searchParams.set('param', '200y200')
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 4000)
    const r = await fetch(parsed.toString(), { signal: ctrl.signal })
    clearTimeout(timer)
    if (!r.ok) return ''
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length < 100) return ''
    let mime = 'image/jpeg'
    if (buf[0] === 0x89 && buf[1] === 0x50) mime = 'image/png'
    else if (buf.subarray(0, 4).toString('ascii') === 'RIFF') mime = 'image/webp'
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return ''
  }
}

/** 调试端口是否可用（网易云是否以精确控制模式在跑） */
export async function isNeteaseCdpReady(): Promise<boolean> {
  return (await findPage()) !== null
}

let runningCache = { at: 0, value: false }

/**
 * 网易云进程在不在（用于在界面上给出「开启后台控制」入口）。
 * 用 tasklist 而不是 WMI：win11 上 WMI 查询经常卡 1~2 秒，tasklist 实测 30~60ms。
 * 4 秒缓存，避免每秒 spawn 一次。
 */
export async function isNeteaseRunning(): Promise<boolean> {
  if (Date.now() - runningCache.at < 4000) return runningCache.value
  let value = false
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        'tasklist.exe',
        ['/FI', 'IMAGENAME eq cloudmusic.exe', '/NH'],
        { windowsHide: true, timeout: 3000 },
        (err, stdout) => (err ? reject(err) : resolve(String(stdout)))
      )
    })
    value = /cloudmusic\.exe/i.test(out)
  } catch {
    value = false
  }
  runningCache = { at: Date.now(), value }
  return value
}

/**
 * 重启网易云并带上调试端口。
 * 这是开启精确控制的唯一方法：Chromium 的调试端口只能在进程启动时打开。
 * 先 CloseMainWindow 再强制结束（网易云的关闭按钮只是收进托盘），然后用原路径重启。
 * 返回 true 表示端口已就绪。
 */
export async function enableNeteaseDebugPort(): Promise<boolean> {
  if (await isNeteaseCdpReady()) return true
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    '$p = Get-Process cloudmusic | Where-Object { $_.Path } | Select-Object -First 1',
    'if (-not $p) { exit 2 }',
    '$exe = $p.Path',
    '$null = $p.CloseMainWindow()',
    'Start-Sleep -Milliseconds 600',
    'Get-Process cloudmusic | Stop-Process -Force',
    'Start-Sleep -Milliseconds 900',
    "$null = Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=9222'",
    'exit 0'
  ].join('; ')
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, timeout: 15000 },
        (err) => (err ? reject(err) : resolve())
      )
    })
  } catch {
    return false
  }
  for (let i = 0; i < 50; i += 1) {
    await sleep(500)
    if (await isNeteaseCdpReady()) return true
  }
  return false
}
