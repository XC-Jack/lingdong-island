import { app, net, protocol } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 本地图片的自定义协议（`ldapp://`）。
 *
 * 为什么需要它（2026-11-12 用户反馈「这个图标怎么显示不出来」）：
 * 渲染层原来把绝对路径拼成 `file:///C:/...` 直接塞进 <img src>。打包版里页面本身
 * 就是 file:// 源，同源，能加载；但**开发预览版的页面源是 http://localhost:5173**，
 * 从 http 源引用 file:// 子资源会被 Chromium 底层拦掉（跨源本地文件访问），
 * 连 CSP 违规事件都不报，表现就是 <img> 静默失败 —— 横幅上的应用图标变成一块空灰底。
 *
 * 实测证据（.tmp/probe-icon-origin.mjs，本地 http 服务器挂 out/renderer）：
 *   同一张 icon-cache/notify-ScreenSketch_*.png
 *     原 CSP          → file: error / data: load:48
 *     放行 file: 的 CSP → file: error / data: load:48
 *   两轮 file: 都 error 且 csp 违规数组为空 ⇒ 不是 CSP 规则拦的，是源不同。
 *
 * 为什么不用 data: URL 一把梭：图标要经 IPC 传 base64，通知列表几十条就白占内存；
 * 置物架图标（App.tsx:703）也走 file://，同样在开发版坏掉，自定义协议一处修两边都通。
 *
 * 为什么把协议注册放在模块顶层：registerSchemesAsPrivileged 必须在 app ready 之前调用，
 * 放到 whenReady 里会失效。index.ts 在启动时 import 本模块，时机正好。
 */

/** 协议名（渲染层用 localUrl() 拼，别处不要写死字符串） */
const SCHEME = 'ldapp'

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      // 不开 bypassCSP：CSP 里显式允许 ldapp: 就够了，别把安全边界放宽得更离谱
      bypassCSP: false
    }
  }
])

/** 只放行这些图片扩展名，别让协议变成任意文件读取通道 */
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico', '.svg'])

/**
 * 把 `ldapp://local/<encodeURIComponent 的绝对路径>` 还原成真实路径。
 * 用单段 encodeURIComponent 而不是逐段编码：Windows 路径里的冒号、空格、
 * 中文和 `#` 全得转义，逐段拼太容易漏。
 */
function decodeTarget(url: URL): string | null {
  // standard 协议下 host 恒为 'local'，真正的路径在 pathname 里（以 / 开头）
  const raw = url.pathname.replace(/^\//, '')
  if (!raw) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

/** app ready 之后调用一次：把协议接到真实的文件读取 */
export function setupLocalFileProtocol(): void {
  protocol.handle(SCHEME, async (req) => {
    const url = new URL(req.url)
    const target = decodeTarget(url)
    if (!target) return new Response('bad request', { status: 400 })

    const ext = extname(target).toLowerCase()
    if (!ALLOWED_EXT.has(ext)) return new Response('forbidden type', { status: 403 })
    if (!existsSync(target)) return new Response('not found', { status: 404 })
    try {
      if (!statSync(target).isFile()) return new Response('not a file', { status: 404 })
    } catch {
      return new Response('not found', { status: 404 })
    }

    // net.fetch 读 file: URL 是 Electron 官方推荐做法（自动带正确的 content-type）
    return net.fetch(pathToFileURL(target).toString())
  })
}

/** 把绝对路径转成渲染层能用的 URL（与渲染层 localUrl() 必须保持一致） */
export function localFileUrl(p: string): string {
  return `${SCHEME}://local/${encodeURIComponent(p)}`
}

/** 供主进程自检/日志用：当前协议名 */
export function localFileScheme(): string {
  return SCHEME
}

// app 未 ready 时协议还注册不了，这里只提醒使用者别提前调用（不是错误路径）
void app
